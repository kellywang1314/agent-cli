import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { persistedAgentMessageSchema } from './messageSchema.js';
import type {
  MemoryCandidateStatus,
  NewDisplayMessage,
  SessionPatch,
  SessionQuery,
  StoredCandidateResolution,
  StoredDisplayMessage,
  StoredMemory,
  StoredMemoryCandidate,
  StoredSession,
} from './types.js';

const schemaVersion = 1;
const busyTimeoutMs = 5000;
const walRetryIntervalMs = 25;
const walRetrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const sessionPatchColumns = {
  title: 'title',
  status: 'status',
  memoryExtractionStatus: 'memoryExtractionStatus',
  memoryExtractionError: 'memoryExtractionError',
  updatedAt: 'updatedAt',
} as const satisfies Record<keyof SessionPatch, string>;
type SessionPatchKey = keyof typeof sessionPatchColumns;
const sessionStatuses = new Set<StoredSession['status']>([
  'idle', 'running', 'interrupted', 'failed',
]);
const memoryExtractionStatuses = new Set<StoredSession['memoryExtractionStatus']>([
  'idle', 'running', 'failed', 'complete',
]);

/** 按字段约束校验会话更新值，避免依赖 SQLite 动态类型转换。 */
function isValidSessionPatchValue(key: SessionPatchKey, value: unknown): boolean {
  switch (key) {
    case 'title':
      return typeof value === 'string';
    case 'status':
      return sessionStatuses.has(value as StoredSession['status']);
    case 'memoryExtractionStatus':
      return memoryExtractionStatuses.has(value as StoredSession['memoryExtractionStatus']);
    case 'memoryExtractionError':
      return typeof value === 'string' || value === null;
    case 'updatedAt':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }
}

class UnsupportedDatabaseVersionError extends Error {
  /** 创建包含实际版本号的兼容性错误。 */
  constructor(version: number) {
    super(`不支持的数据库版本：${version}`);
  }
}

const migrationV1 = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  clientType TEXT NOT NULL CHECK (clientType IN ('web', 'cli')),
  workspace TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'interrupted', 'failed')),
  turns INTEGER NOT NULL DEFAULT 0 CHECK (turns >= 0),
  memoryExtractionStatus TEXT NOT NULL DEFAULT 'idle'
    CHECK (memoryExtractionStatus IN ('idle', 'running', 'failed', 'complete')),
  memoryExtractionError TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX sessionsWorkspaceUpdated ON sessions(workspace, clientType, updatedAt DESC);

CREATE TABLE displayMessages (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'notice')),
  content TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  UNIQUE(sessionId, sequence)
);

CREATE TABLE agentMessages (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  payloadJson TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  UNIQUE(sessionId, sequence)
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('rule', 'decision', 'fact', 'preference')),
  content TEXT NOT NULL,
  normalizedContent TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sourceSessionId TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  UNIQUE(workspace, normalizedContent)
);
CREATE INDEX memoriesWorkspaceActive ON memories(workspace, active, updatedAt DESC);

CREATE TABLE memoryCandidates (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  sourceSessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sourceTurn INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('rule', 'decision', 'fact', 'preference')),
  content TEXT NOT NULL,
  normalizedContent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'ignored')),
  acceptedMemoryId TEXT REFERENCES memories(id) ON DELETE SET NULL,
  createdAt INTEGER NOT NULL,
  resolvedAt INTEGER
);
CREATE INDEX candidatesSessionStatus ON memoryCandidates(sourceSessionId, status, createdAt);
PRAGMA user_version = 1;
`;

/** 判断错误是否为 SQLite 的 busy 或 locked 锁冲突。 */
function isSqliteLockError(error: unknown): boolean {
  if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ERR_SQLITE_ERROR') return false;
  const errorCode = Reflect.get(error, 'errcode');
  return typeof errorCode === 'number' && [5, 6].includes(errorCode & 0xff);
}

/** 在 busy timeout 总期限内同步重试 WAL 切换，并验证最终模式。 */
function enableWriteAheadLogging(database: DatabaseSync): void {
  const deadline = performance.now() + busyTimeoutMs;
  while (true) {
    try {
      const journalMode = String(
        database.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode ?? '',
      );
      if (journalMode !== 'wal') throw new Error(`无法启用 WAL 模式：${journalMode}`);
      return;
    } catch (error) {
      if (!isSqliteLockError(error)) throw error;
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw error;
      Atomics.wait(walRetrySignal, 0, 0, Math.min(walRetryIntervalMs, remainingMs));
    }
  }
}

/** 将 SQLite 查询结果转换为强类型会话。 */
function mapSession(row: Record<string, unknown>): StoredSession {
  return {
    id: String(row.id),
    clientType: row.clientType as StoredSession['clientType'],
    workspace: String(row.workspace),
    title: String(row.title),
    status: row.status as StoredSession['status'],
    turns: Number(row.turns),
    memoryExtractionStatus: row.memoryExtractionStatus as StoredSession['memoryExtractionStatus'],
    memoryExtractionError: row.memoryExtractionError === null
      ? null
      : String(row.memoryExtractionError),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

/** 将 SQLite 查询结果转换为强类型显示消息。 */
function mapDisplayMessage(row: Record<string, unknown>): StoredDisplayMessage {
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    sequence: Number(row.sequence),
    role: row.role as StoredDisplayMessage['role'],
    content: String(row.content),
    createdAt: Number(row.createdAt),
  };
}

/** 将 SQLite 查询结果转换为强类型记忆候选。 */
function mapMemoryCandidate(row: Record<string, unknown>): StoredMemoryCandidate {
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    sourceSessionId: String(row.sourceSessionId),
    sourceTurn: Number(row.sourceTurn),
    category: row.category as StoredMemoryCandidate['category'],
    content: String(row.content),
    normalizedContent: String(row.normalizedContent),
    status: row.status as StoredMemoryCandidate['status'],
    acceptedMemoryId: row.acceptedMemoryId === null ? null : String(row.acceptedMemoryId),
    createdAt: Number(row.createdAt),
    resolvedAt: row.resolvedAt === null ? null : Number(row.resolvedAt),
  };
}

/** 将 SQLite 查询结果转换为强类型正式记忆。 */
function mapMemory(row: Record<string, unknown>): StoredMemory {
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    category: row.category as StoredMemory['category'],
    content: String(row.content),
    normalizedContent: String(row.normalizedContent),
    active: Number(row.active) === 1,
    sourceSessionId: row.sourceSessionId === null ? null : String(row.sourceSessionId),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

/** 使用与服务层一致的稳定规则计算正式记忆去重键。 */
function normalizeStoredMemoryContent(content: string): string {
  return content.normalize('NFKC').trim().replace(/\s+/gu, ' ').replace(
    /[A-Z]/g,
    (character) => character.toLowerCase(),
  );
}

export class PersistenceStore {
  private readonly database: DatabaseSync;

  /** 打开数据库、限制权限并执行版本 1 迁移。 */
  constructor(readonly databasePath: string) {
    let database: DatabaseSync | undefined;
    try {
      const directory = path.dirname(databasePath);
      const createdDirectory = mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (createdDirectory !== undefined) chmodSync(directory, 0o700);
      database = new DatabaseSync(databasePath);
      chmodSync(databasePath, 0o600);
      database.exec('PRAGMA foreign_keys = ON');
      enableWriteAheadLogging(database);
      database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      let transactionStarted = false;
      try {
        database.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        const version = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
        if (version === 0) database.exec(migrationV1);
        else if (version !== schemaVersion) throw new UnsupportedDatabaseVersionError(version);
        database.exec('COMMIT');
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) {
          try {
            database.exec('ROLLBACK');
          } catch {
            // 保留初始化失败，由外层统一关闭连接并报告。
          }
        }
        throw error;
      }
      this.database = database;
    } catch {
      try {
        database?.close();
      } catch {
        // 忽略关闭错误，保持统一的公开错误边界。
      }
      throw new Error(`无法打开长期记忆数据库：${databasePath}`);
    }
  }

  /** 在 IMMEDIATE 事务中执行操作，异常时保证回滚。 */
  private transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // 保留触发事务回滚的原始错误。
      }
      throw error;
    }
  }

  /** 确认会话存在，并为公开写接口提供一致错误。 */
  private assertSessionExists(id: string): void {
    const row = this.database.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
    if (!row) throw new Error(`会话不存在：${id}`);
  }

  /** 返回调用会话的工作区，不存在时拒绝后续资源访问。 */
  private getSessionWorkspace(id: string): string {
    const row = this.database.prepare('SELECT workspace FROM sessions WHERE id = ?').get(id);
    if (!row) throw new Error(`会话不存在：${id}`);
    return String(row.workspace);
  }

  /** 在当前事务内校验并批量写入记忆候选。 */
  private insertMemoryCandidateRows(candidates: StoredMemoryCandidate[]): void {
    const insert = this.database.prepare(`
      INSERT INTO memoryCandidates (
        id, workspace, sourceSessionId, sourceTurn, category, content,
        normalizedContent, status, acceptedMemoryId, createdAt, resolvedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const candidate of candidates) {
      const workspace = this.getSessionWorkspace(candidate.sourceSessionId);
      if (workspace !== candidate.workspace) throw new Error('会话工作区不匹配');
      insert.run(
        candidate.id,
        candidate.workspace,
        candidate.sourceSessionId,
        candidate.sourceTurn,
        candidate.category,
        candidate.content,
        candidate.normalizedContent,
        candidate.status,
        candidate.acceptedMemoryId,
        candidate.createdAt,
        candidate.resolvedAt,
      );
    }
  }

  /** 在指定消息表中计算会话的下一个严格递增序号。 */
  private nextSequence(
    table: 'displayMessages' | 'agentMessages',
    sessionId: string,
  ): number {
    const row = this.database.prepare(
      `SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM ${table} WHERE sessionId = ?`,
    ).get(sessionId);
    return Number(row?.sequence ?? 0);
  }

  /** 校验 patch 字段及运行时值并更新已有会话，空 patch 保持无操作。 */
  private applySessionPatch(id: string, patch: SessionPatch): void {
    for (const key of Object.keys(patch)) {
      if (!Object.hasOwn(sessionPatchColumns, key)) {
        throw new Error(`不支持的会话更新字段：${key}`);
      }
      const patchKey = key as SessionPatchKey;
      const value = patch[patchKey];
      if (!isValidSessionPatchValue(patchKey, value)) {
        throw new Error(`无效的会话更新字段值：${key}`);
      }
    }
    const keys = (Object.keys(sessionPatchColumns) as SessionPatchKey[])
      .filter((key) => patch[key] !== undefined);
    if (keys.length === 0) return;
    const assignments = keys.map((key) => `${sessionPatchColumns[key]} = ?`);
    const values = keys.map((key) => patch[key] as string | number | null);
    this.database.prepare(
      `UPDATE sessions SET ${assignments.join(', ')} WHERE id = ?`,
    ).run(...values, id);
  }

  /** 返回 SQLite Schema 版本。 */
  getSchemaVersion(): number {
    return Number(this.database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  }

  /** 返回按名称排序的业务表，供迁移检查使用。 */
  listTableNames(): string[] {
    return this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((row) => String(row.name));
  }

  /** 创建一条完整的会话记录。 */
  createSession(session: StoredSession): void {
    this.database.prepare(`
      INSERT INTO sessions (
        id, clientType, workspace, title, status, turns,
        memoryExtractionStatus, memoryExtractionError, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.clientType,
      session.workspace,
      session.title,
      session.status,
      session.turns,
      session.memoryExtractionStatus,
      session.memoryExtractionError,
      session.createdAt,
      session.updatedAt,
    );
  }

  /** 按 ID 获取会话，不存在时抛出明确错误。 */
  getSession(id: string): StoredSession {
    const row = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!row) throw new Error(`会话不存在：${id}`);
    return mapSession(row);
  }

  /** 按可选工作区和客户端类型查询会话。 */
  listSessions(query: SessionQuery = {}): StoredSession[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (query.workspace !== undefined) {
      conditions.push('workspace = ?');
      values.push(query.workspace);
    }
    if (query.clientType !== undefined) {
      conditions.push('clientType = ?');
      values.push(query.clientType);
    }
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    return this.database.prepare(
      `SELECT * FROM sessions${whereClause} ORDER BY updatedAt DESC, id ASC`,
    ).all(...values).map(mapSession);
  }

  /** 原子写入显示与 agent 用户消息，并将会话推进一轮。 */
  beginTurn(
    sessionId: string,
    display: NewDisplayMessage,
    agent: ChatCompletionMessageParam,
  ): void {
    const parsedAgent = persistedAgentMessageSchema.parse(agent);
    this.transaction(() => {
      this.assertSessionExists(sessionId);
      const displaySequence = this.nextSequence('displayMessages', sessionId);
      const agentSequence = this.nextSequence('agentMessages', sessionId);
      this.database.prepare(`
        INSERT INTO displayMessages (id, sessionId, sequence, role, content, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        display.id,
        sessionId,
        displaySequence,
        display.role,
        display.content,
        display.createdAt,
      );
      this.database.prepare(`
        INSERT INTO agentMessages (id, sessionId, sequence, payloadJson, createdAt)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        sessionId,
        agentSequence,
        JSON.stringify(parsedAgent),
        display.createdAt,
      );
      this.database.prepare(`
        UPDATE sessions SET turns = turns + 1, status = ? WHERE id = ?
      `).run('running', sessionId);
    });
  }

  /** 原子写入仅展示给用户的消息，并将会话推进一轮。 */
  beginDisplayOnlyTurn(sessionId: string, display: NewDisplayMessage): void {
    this.transaction(() => {
      this.assertSessionExists(sessionId);
      const sequence = this.nextSequence('displayMessages', sessionId);
      this.database.prepare(`
        INSERT INTO displayMessages (id, sessionId, sequence, role, content, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        display.id,
        sessionId,
        sequence,
        display.role,
        display.content,
        display.createdAt,
      );
      this.database.prepare(`
        UPDATE sessions SET turns = turns + 1, status = ? WHERE id = ?
      `).run('running', sessionId);
    });
  }

  /** 校验并原子追加一组 agent 历史消息。 */
  appendAgentMessages(sessionId: string, messages: ChatCompletionMessageParam[]): void {
    const parsedMessages = messages.map((message) => persistedAgentMessageSchema.parse(message));
    this.transaction(() => {
      this.assertSessionExists(sessionId);
      let sequence = this.nextSequence('agentMessages', sessionId);
      const insert = this.database.prepare(`
        INSERT INTO agentMessages (id, sessionId, sequence, payloadJson, createdAt)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const message of parsedMessages) {
        insert.run(randomUUID(), sessionId, sequence, JSON.stringify(message), Date.now());
        sequence += 1;
      }
    });
  }

  /** 原子追加显示消息并应用允许的会话字段更新。 */
  appendDisplayMessage(
    sessionId: string,
    message: NewDisplayMessage,
    patch: SessionPatch,
  ): void {
    this.transaction(() => {
      this.assertSessionExists(sessionId);
      const sequence = this.nextSequence('displayMessages', sessionId);
      this.database.prepare(`
        INSERT INTO displayMessages (id, sessionId, sequence, role, content, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        sessionId,
        sequence,
        message.role,
        message.content,
        message.createdAt,
      );
      this.applySessionPatch(sessionId, patch);
    });
  }

  /** 按序读取会话的显示消息。 */
  loadDisplayMessages(sessionId: string): StoredDisplayMessage[] {
    return this.database.prepare(`
      SELECT id, sessionId, sequence, role, content, createdAt
      FROM displayMessages
      WHERE sessionId = ?
      ORDER BY sequence ASC
    `).all(sessionId).map(mapDisplayMessage);
  }

  /** 按序读取并严格校验会话的 agent 历史消息。 */
  loadAgentMessages(sessionId: string): ChatCompletionMessageParam[] {
    return this.database.prepare(`
      SELECT payloadJson
      FROM agentMessages
      WHERE sessionId = ?
      ORDER BY sequence ASC
    `).all(sessionId).map((row) => (
      persistedAgentMessageSchema.parse(JSON.parse(String(row.payloadJson)))
    ));
  }

  /** 更新允许修改的会话字段。 */
  updateSession(id: string, patch: SessionPatch): void {
    this.transaction(() => {
      this.assertSessionExists(id);
      this.applySessionPatch(id, patch);
    });
  }

  /** 在单个事务中批量写入记忆候选，任一失败时全部回滚。 */
  insertMemoryCandidates(candidates: StoredMemoryCandidate[]): void {
    this.transaction(() => {
      this.insertMemoryCandidateRows(candidates);
    });
  }

  /** 原子写入本次候选并将对应会话的提取状态标记为完成。 */
  completeMemoryExtraction(
    sessionId: string,
    candidates: StoredMemoryCandidate[],
  ): void {
    this.transaction(() => {
      this.assertSessionExists(sessionId);
      if (candidates.some(({ sourceSessionId }) => sourceSessionId !== sessionId)) {
        throw new Error('记忆候选源会话不匹配');
      }
      this.insertMemoryCandidateRows(candidates);
      this.applySessionPatch(sessionId, {
        memoryExtractionStatus: 'complete',
        memoryExtractionError: null,
      });
    });
  }

  /** 按创建顺序列出会话候选，并可限制候选状态。 */
  listMemoryCandidates(
    sessionId: string,
    status?: MemoryCandidateStatus,
  ): StoredMemoryCandidate[] {
    const workspace = this.getSessionWorkspace(sessionId);
    const statusCondition = status === undefined ? '' : ' AND status = ?';
    const values = status === undefined
      ? [sessionId, workspace]
      : [sessionId, workspace, status];
    return this.database.prepare(`
      SELECT *
      FROM memoryCandidates
      WHERE sourceSessionId = ? AND workspace = ?${statusCondition}
      ORDER BY createdAt ASC, id ASC
    `).all(...values).map(mapMemoryCandidate);
  }

  /** 列出工作区全部非忽略候选的去重键。 */
  listNonIgnoredMemoryCandidateNormalizedContents(workspace: string): string[] {
    return this.database.prepare(`
      SELECT normalizedContent
      FROM memoryCandidates
      WHERE workspace = ? AND status != ?
      ORDER BY createdAt ASC, id ASC
    `).all(workspace, 'ignored').map((row) => String(row.normalizedContent));
  }

  /** 列出工作区全部正式记忆的去重键。 */
  listMemoryNormalizedContents(workspace: string): string[] {
    return this.database.prepare(`
      SELECT normalizedContent
      FROM memories
      WHERE workspace = ?
      ORDER BY updatedAt DESC, id ASC
    `).all(workspace).map((row) => String(row.normalizedContent));
  }

  /** 列出工作区正式记忆，默认包含停用项并保持稳定更新时间排序。 */
  listMemories(workspace: string, activeOnly = false, limit?: number): StoredMemory[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      throw new Error('记忆查询条数限制必须是安全正整数');
    }
    const activeCondition = activeOnly ? ' AND active = ?' : '';
    const values: Array<string | number> = activeOnly ? [workspace, 1] : [workspace];
    const limitClause = limit === undefined ? '' : ' LIMIT ?';
    if (limit !== undefined) values.push(limit);
    return this.database.prepare(`
      SELECT *
      FROM memories
      WHERE workspace = ?${activeCondition}
      ORDER BY updatedAt DESC, id ASC
      ${limitClause}
    `).all(...values).map(mapMemory);
  }

  /** 原子忽略候选，或复用/创建正式记忆并标记候选已接受。 */
  resolveMemoryCandidate(
    sessionId: string,
    candidateId: string,
    decision: StoredCandidateResolution,
    resolvedAt: number,
  ): StoredMemory | null {
    return this.transaction(() => {
      const workspace = this.getSessionWorkspace(sessionId);
      const candidateRow = this.database.prepare(`
        SELECT *
        FROM memoryCandidates
        WHERE id = ? AND workspace = ?
      `).get(candidateId, workspace);
      if (!candidateRow) throw new Error(`记忆候选不存在：${candidateId}`);
      const candidate = mapMemoryCandidate(candidateRow);
      if (candidate.status !== 'pending') throw new Error('记忆候选已处理');

      if (decision.action === 'ignore') {
        this.database.prepare(`
          UPDATE memoryCandidates
          SET status = ?, resolvedAt = ?
          WHERE id = ? AND status = ?
        `).run('ignored', resolvedAt, candidateId, 'pending');
        return null;
      }

      let memoryRow = this.database.prepare(`
        SELECT *
        FROM memories
        WHERE workspace = ? AND normalizedContent = ?
      `).get(workspace, decision.normalizedContent);
      if (!memoryRow) {
        const memoryId = randomUUID();
        this.database.prepare(`
          INSERT INTO memories (
            id, workspace, category, content, normalizedContent, active,
            sourceSessionId, createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          memoryId,
          workspace,
          candidate.category,
          decision.content,
          decision.normalizedContent,
          1,
          candidate.sourceSessionId,
          resolvedAt,
          resolvedAt,
        );
        memoryRow = this.database.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId);
      }
      if (!memoryRow) throw new Error('正式记忆创建失败');
      const memory = mapMemory(memoryRow);
      this.database.prepare(`
        UPDATE memoryCandidates
        SET status = ?, acceptedMemoryId = ?, resolvedAt = ?
        WHERE id = ? AND status = ?
      `).run('accepted', memory.id, resolvedAt, candidateId, 'pending');
      return memory;
    });
  }

  /** 编辑、停用或恢复调用会话工作区内的正式记忆。 */
  updateMemory(
    sessionId: string,
    memoryId: string,
    patch: { content?: string; active?: boolean },
  ): StoredMemory {
    return this.transaction(() => {
      const workspace = this.getSessionWorkspace(sessionId);
      const memoryRow = this.database.prepare(`
        SELECT *
        FROM memories
        WHERE id = ? AND workspace = ?
      `).get(memoryId, workspace);
      if (!memoryRow) throw new Error(`记忆不存在：${memoryId}`);
      if (patch.content === undefined && patch.active === undefined) {
        throw new Error('记忆更新不能为空');
      }
      const currentMemory = mapMemory(memoryRow);

      const assignments: string[] = [];
      const values: Array<string | number> = [];
      if (patch.content !== undefined) {
        const normalizedContent = normalizeStoredMemoryContent(patch.content);
        const duplicate = this.database.prepare(`
          SELECT id
          FROM memories
          WHERE workspace = ? AND normalizedContent = ? AND id <> ?
        `).get(workspace, normalizedContent, memoryId);
        if (duplicate) throw new Error('同工作区已存在相同记忆');
        assignments.push('content = ?', 'normalizedContent = ?');
        values.push(patch.content, normalizedContent);
      }
      if (patch.active !== undefined) {
        assignments.push('active = ?');
        values.push(patch.active ? 1 : 0);
      }
      assignments.push('updatedAt = ?');
      values.push(Math.max(Date.now(), currentMemory.updatedAt + 1));
      this.database.prepare(`
        UPDATE memories
        SET ${assignments.join(', ')}
        WHERE id = ? AND workspace = ?
      `).run(...values, memoryId, workspace);
      const updatedRow = this.database.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId);
      if (!updatedRow) throw new Error(`记忆不存在：${memoryId}`);
      return mapMemory(updatedRow);
    });
  }

  /** 删除调用会话工作区内的正式记忆。 */
  deleteMemory(sessionId: string, memoryId: string): void {
    this.transaction(() => {
      const workspace = this.getSessionWorkspace(sessionId);
      const result = this.database.prepare(`
        DELETE FROM memories
        WHERE id = ? AND workspace = ?
      `).run(memoryId, workspace);
      if (result.changes === 0) throw new Error(`记忆不存在：${memoryId}`);
    });
  }

  /** 删除会话，并由外键级联删除关联消息。 */
  deleteSession(id: string): void {
    this.transaction(() => {
      this.assertSessionExists(id);
      this.database.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    });
  }

  /** 补齐中断工具结果，并修复运行中的会话与记忆提取状态。 */
  recoverInterruptedWork(): void {
    this.transaction(() => {
      const runningSessionTails = this.database.prepare(`
        SELECT
          sessions.id AS sessionId,
          latestAssistant.sequence AS assistantSequence,
          latestAssistant.payloadJson AS assistantPayloadJson
        FROM sessions
        LEFT JOIN agentMessages AS latestAssistant
          ON latestAssistant.id = (
            SELECT agentMessages.id
            FROM agentMessages
            WHERE agentMessages.sessionId = sessions.id
              AND json_extract(agentMessages.payloadJson, '$.role') = ?
            ORDER BY agentMessages.sequence DESC
            LIMIT 1
          )
        WHERE sessions.status = ?
      `).all('assistant', 'running');
      const followingToolMessages = this.database.prepare(`
        SELECT payloadJson
        FROM agentMessages
        WHERE sessionId = ?
          AND sequence > ?
          AND json_extract(payloadJson, '$.role') = ?
        ORDER BY sequence ASC
      `);
      const pendingToolCalls = new Map<string, Set<string>>();
      for (const row of runningSessionTails) {
        const sessionId = String(row.sessionId);
        if (row.assistantPayloadJson === null) continue;
        const assistantMessage = persistedAgentMessageSchema.parse(
          JSON.parse(String(row.assistantPayloadJson)),
        );
        if (assistantMessage.role !== 'assistant' || !assistantMessage.tool_calls?.length) continue;
        const pending = new Set(assistantMessage.tool_calls.map((toolCall) => toolCall.id));
        for (const toolRow of followingToolMessages.all(
          sessionId,
          Number(row.assistantSequence),
          'tool',
        )) {
          const toolMessage = persistedAgentMessageSchema.parse(
            JSON.parse(String(toolRow.payloadJson)),
          );
          if (toolMessage.role === 'tool') pending.delete(toolMessage.tool_call_id);
        }
        if (pending.size > 0) pendingToolCalls.set(sessionId, pending);
      }

      const insert = this.database.prepare(`
        INSERT INTO agentMessages (id, sessionId, sequence, payloadJson, createdAt)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const [sessionId, toolCallIds] of pendingToolCalls) {
        let sequence = this.nextSequence('agentMessages', sessionId);
        for (const toolCallId of toolCallIds) {
          const message = persistedAgentMessageSchema.parse({
            role: 'tool',
            tool_call_id: toolCallId,
            content: '{"error":"服务中断，工具结果未知"}',
          });
          insert.run(
            randomUUID(),
            sessionId,
            sequence,
            JSON.stringify(message),
            Date.now(),
          );
          sequence += 1;
        }
      }

      this.database.prepare('UPDATE sessions SET status = ? WHERE status = ?')
        .run('interrupted', 'running');
      this.database.prepare(`
        UPDATE sessions
        SET memoryExtractionStatus = ?, memoryExtractionError = ?
        WHERE memoryExtractionStatus = ?
      `).run('failed', '服务重启，记忆提取未完成', 'running');
    });
  }

  /** 关闭 SQLite 连接。 */
  close(): void {
    this.database.close();
  }
}
