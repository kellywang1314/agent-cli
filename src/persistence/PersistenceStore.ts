import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { persistedAgentMessageSchema } from './messageSchema.js';
import type {
  NewDisplayMessage,
  SessionPatch,
  SessionQuery,
  StoredDisplayMessage,
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

  /** 校验 patch 字段并更新已有会话，空 patch 保持无操作。 */
  private applySessionPatch(id: string, patch: SessionPatch): void {
    for (const key of Object.keys(patch)) {
      if (!Object.hasOwn(sessionPatchColumns, key)) {
        throw new Error(`不支持的会话更新字段：${key}`);
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
      const pendingToolCalls = new Map<string, Set<string>>();
      const rows = this.database.prepare(`
        SELECT sessionId, payloadJson
        FROM agentMessages
        ORDER BY sessionId ASC, sequence ASC
      `).all();
      for (const row of rows) {
        const sessionId = String(row.sessionId);
        const message = persistedAgentMessageSchema.parse(
          JSON.parse(String(row.payloadJson)),
        );
        let pending = pendingToolCalls.get(sessionId);
        if (!pending) {
          pending = new Set<string>();
          pendingToolCalls.set(sessionId, pending);
        }
        if (message.role === 'assistant') {
          for (const toolCall of message.tool_calls ?? []) pending.add(toolCall.id);
        } else if (message.role === 'tool') {
          pending.delete(message.tool_call_id);
        }
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
