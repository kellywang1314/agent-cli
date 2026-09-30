import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDatabasePath } from '../src/persistence/databasePath.js';
import { persistedAgentMessageSchema } from '../src/persistence/messageSchema.js';
import { PersistenceStore } from '../src/persistence/PersistenceStore.js';
import type {
  NewDisplayMessage,
  StoredMemoryCandidate,
  StoredSession,
} from '../src/persistence/types.js';

const cleanups: Array<() => Promise<void>> = [];
const readyTimeoutMs = 5000;
const resultTimeoutMs = 10_000;
const exitTimeoutMs = 5000;

type InitializerResult = { ok: boolean; error?: string };
type InitializerExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

interface InitializerChild {
  child: ChildProcess;
  ready: Promise<void>;
  result: Promise<InitializerResult>;
  exited: Promise<InitializerExit>;
  getStderr: () => string;
}

/** 清理每个用例创建的临时数据库目录。 */
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 创建独立数据库路径并注册清理函数。 */
async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-db-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'agent.db');
}

/** 构造具有稳定默认值的持久化会话。 */
function buildSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'session-1',
    clientType: 'web',
    workspace: '/workspace/one',
    title: '新会话',
    status: 'idle',
    turns: 0,
    memoryExtractionStatus: 'idle',
    memoryExtractionError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** 构造不包含会话和序号字段的显示消息。 */
function buildDisplayMessage(overrides: Partial<NewDisplayMessage> = {}): NewDisplayMessage {
  return {
    id: 'display-1',
    role: 'user',
    content: '用户输入',
    createdAt: 2,
    ...overrides,
  };
}

/** 读取测试专用的底层数据库句柄。 */
function getTestDatabase(store: PersistenceStore): DatabaseSync {
  return (store as unknown as { database: DatabaseSync }).database;
}

/** 捕获构造失败，供错误边界断言复用。 */
function captureConstructionError(databasePath: string): Error {
  try {
    new PersistenceStore(databasePath);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('预期 PersistenceStore 构造失败');
}

/** 创建与 node:sqlite 一致的可识别 SQLite 错误。 */
function createSqliteError(errcode: number, errstr: string): Error {
  return Object.assign(new Error(errstr), {
    code: 'ERR_SQLITE_ERROR',
    errcode,
    errstr,
  });
}

/** 在 WAL 设置边界按调用次数注入错误，并返回总调用次数。 */
function mockJournalModeFailure(createError: (attempt: number) => Error | undefined): () => number {
  let attempts = 0;
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql.includes('PRAGMA journal_mode = WAL')) {
      attempts += 1;
      const error = createError(attempts);
      if (error) throw error;
    }
    return originalExec.call(this, sql);
  });
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === 'PRAGMA journal_mode = WAL') {
      attempts += 1;
      const error = createError(attempts);
      if (error) throw error;
    }
    return originalPrepare.call(this, sql);
  });
  return () => attempts;
}

/** 创建子进程并立即注册所有 IPC、错误和退出监听。 */
function spawnInitializer(databasePath: string, script: string): InitializerChild {
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', script,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: databasePath },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  let receivedReady = false;
  let receivedResult = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (result: InitializerResult) => void;
  let rejectResult!: (error: Error) => void;
  let resolveExited!: (exit: InitializerExit) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<InitializerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const exited = new Promise<InitializerExit>((resolve) => {
    resolveExited = resolve;
  });
  void ready.catch(() => undefined);
  void result.catch(() => undefined);

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('message', (message) => {
    if (message === 'ready' && !receivedReady) {
      receivedReady = true;
      resolveReady();
      return;
    }
    if (
      typeof message === 'object'
      && message !== null
      && 'ok' in message
      && typeof message.ok === 'boolean'
      && !receivedResult
    ) {
      receivedResult = true;
      resolveResult(message as InitializerResult);
    }
  });
  child.once('error', (error) => {
    const childError = new Error(`初始化子进程错误：${error.message}：${stderr}`);
    rejectReady(childError);
    rejectResult(childError);
    if (child.pid === undefined) resolveExited({ code: null, signal: null, error: childError });
  });
  child.once('exit', (code, signal) => {
    const childError = new Error(`初始化子进程提前退出 (${code ?? signal})：${stderr}`);
    if (!receivedReady) rejectReady(childError);
    if (!receivedResult) rejectResult(childError);
    resolveExited({ code, signal });
  });

  return { child, ready, result, exited, getStderr: () => stderr };
}

/** 为并发初始化的单个阶段设置明确的最长等待时间。 */
async function waitForPhase<T>(promise: Promise<T>, phase: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${phase} 阶段等待超过 ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 终止仍存活的初始化子进程，并等待所有子进程退出。 */
async function stopInitializers(initializers: InitializerChild[]): Promise<void> {
  for (const { child } of initializers) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  const allExited = Promise.all(initializers.map(({ exited }) => exited));
  try {
    await waitForPhase(allExited, 'cleanup exit', exitTimeoutMs);
  } catch {
    for (const { child } of initializers) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await waitForPhase(allExited, 'forced cleanup exit', exitTimeoutMs);
  }
}

/** 通过 IPC 屏障同时启动多个独立进程中的数据库初始化。 */
async function runConcurrentInitializers(
  databasePath: string,
  processCount = 24,
): Promise<InitializerResult[]> {
  const moduleUrl = pathToFileURL(path.resolve('src/persistence/PersistenceStore.ts')).href;
  const script = `
    import { PersistenceStore } from ${JSON.stringify(moduleUrl)};
    process.send?.('ready');
    process.once('message', () => {
      try {
        const store = new PersistenceStore(process.env.DATABASE_PATH);
        store.close();
        process.send?.({ ok: true });
      } catch (error) {
        process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) });
      } finally {
        process.disconnect?.();
      }
    });
  `;
  const initializers: InitializerChild[] = [];
  try {
    for (let index = 0; index < processCount; index += 1) {
      initializers.push(spawnInitializer(databasePath, script));
    }
    await waitForPhase(Promise.all(initializers.map(({ ready }) => ready)), 'ready', readyTimeoutMs);
    for (const { child } of initializers) child.send('start');
    const results = await waitForPhase(
      Promise.all(initializers.map(({ result }) => result)),
      'result',
      resultTimeoutMs,
    );
    const exits = await waitForPhase(
      Promise.all(initializers.map(({ exited }) => exited)),
      'exit',
      exitTimeoutMs,
    );
    exits.forEach(({ code, signal, error }, index) => {
      if (error || code !== 0) {
        throw new Error(
          error?.message
            ?? `初始化子进程失败 (${code ?? signal})：${initializers[index]?.getStderr() ?? ''}`,
        );
      }
    });
    return results;
  } finally {
    await stopInitializers(initializers);
  }
}

describe('PersistenceStore schema', () => {
  it('在 macOS 用户数据目录生成默认路径', () => {
    expect(resolveDatabasePath({}, '/Users/tester')).toBe(
      '/Users/tester/Library/Application Support/agent-cli/agent.db',
    );
  });

  it('相对配置基于当前目录解析', () => {
    expect(resolveDatabasePath({ AGENT_CLI_DB_PATH: './custom.db' }, '/tmp', '/tmp')).toBe('/tmp/custom.db');
  });

  it('首次打开创建版本 1 Schema', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    expect(store.getSchemaVersion()).toBe(1);
    expect(store.listTableNames()).toEqual([
      'agentMessages', 'displayMessages', 'memories', 'memoryCandidates', 'sessions',
    ]);
    store.close();
  });

  it('持久化启用 WAL 并通过真实外键约束拒绝孤立消息', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    store.close();
    const database = new DatabaseSync(databasePath);
    try {
      expect(database.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    } finally {
      database.close();
    }

    const foreignKeyStore = new PersistenceStore(databasePath);
    expect(() => (foreignKeyStore as unknown as {
      database: DatabaseSync;
    }).database.exec(`
      INSERT INTO displayMessages (id, sessionId, sequence, role, content, createdAt)
        VALUES ('orphan', 'missing', 1, 'user', 'content', 1)
    `)).toThrow();
    foreignKeyStore.close();
  });

  it.each([
    { errcode: 5, errstr: 'database is locked' },
    { errcode: 6, errstr: 'database table is locked' },
  ])('WAL 设置遇到 $errstr 后重试并完成初始化', async ({ errcode, errstr }) => {
    const databasePath = await createDatabasePath();
    const getAttempts = mockJournalModeFailure((attempt) => (
      attempt === 1 ? createSqliteError(errcode, errstr) : undefined
    ));

    const store = new PersistenceStore(databasePath);
    store.close();
    expect(getAttempts()).toBe(2);
  });

  it('WAL 设置遇到非锁错误时立即失败并隐藏底层错误', async () => {
    const databasePath = await createDatabasePath();
    const getAttempts = mockJournalModeFailure(() => createSqliteError(1, 'SQL logic error'));

    const error = captureConstructionError(databasePath);
    expect(error.message).toBe(`无法打开长期记忆数据库：${databasePath}`);
    expect(error).not.toHaveProperty('cause');
    expect(getAttempts()).toBe(1);
  });

  it('WAL 设置成功后验证返回模式', async () => {
    const databasePath = await createDatabasePath();
    const originalPrepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === 'PRAGMA journal_mode = WAL') {
        return { get: () => ({ journal_mode: 'delete' }) } as never;
      }
      return originalPrepare.call(this, sql);
    });

    const error = captureConstructionError(databasePath);
    expect(error.message).toBe(`无法打开长期记忆数据库：${databasePath}`);
    expect(error).not.toHaveProperty('cause');
  });

  it('多个独立进程首次并发打开时只执行一次迁移', async () => {
    const databasePath = await createDatabasePath();
    const results = await runConcurrentInitializers(databasePath);
    expect(results).toEqual(Array.from({ length: results.length }, () => ({ ok: true })));
    const database = new DatabaseSync(databasePath);
    try {
      expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    } finally {
      database.close();
    }
  }, 25_000);

  it('创建关键索引并实施代表性约束', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    store.close();
    const database = new DatabaseSync(databasePath);
    try {
      const indexes = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all().map((row) => String(row.name));
      expect(indexes).toEqual([
        'candidatesSessionStatus', 'memoriesWorkspaceActive', 'sessionsWorkspaceUpdated',
      ]);
      expect(() => database.exec(`
        INSERT INTO sessions (
          id, clientType, workspace, title, status, turns, memoryExtractionStatus, createdAt, updatedAt
        ) VALUES ('invalid', 'terminal', '/tmp', 'title', 'idle', 0, 'idle', 1, 1)
      `)).toThrow();
      database.exec(`
        INSERT INTO sessions (
          id, clientType, workspace, title, status, turns, memoryExtractionStatus, createdAt, updatedAt
        ) VALUES ('session', 'cli', '/tmp', 'title', 'idle', 0, 'idle', 1, 1);
        INSERT INTO agentMessages (id, sessionId, sequence, payloadJson, createdAt)
          VALUES ('first', 'session', 1, '{}', 1);
      `);
      expect(() => database.exec(`
        INSERT INTO agentMessages (id, sessionId, sequence, payloadJson, createdAt)
          VALUES ('second', 'session', 1, '{}', 1)
      `)).toThrow();
    } finally {
      database.close();
    }
  });

  it('保留已有父目录权限并限制数据库文件为仅用户可访问', async () => {
    const databasePath = await createDatabasePath();
    await chmod(path.dirname(databasePath), 0o755);
    const store = new PersistenceStore(databasePath);
    store.close();
    expect((await stat(path.dirname(databasePath))).mode & 0o777).toBe(0o755);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
  });

  it('将本次新建的应用数据库目录限制为仅用户可访问', async () => {
    const rootDatabasePath = await createDatabasePath();
    const databasePath = path.join(path.dirname(rootDatabasePath), 'application-data', 'agent.db');
    const store = new PersistenceStore(databasePath);
    store.close();
    expect((await stat(path.dirname(databasePath))).mode & 0o777).toBe(0o700);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
  });

  it('统一隐藏不支持版本的底层错误', async () => {
    const databasePath = await createDatabasePath();
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA user_version = 2');
    database.close();
    const error = captureConstructionError(databasePath);
    expect(error.message).toBe(`无法打开长期记忆数据库：${databasePath}`);
    expect(error).not.toHaveProperty('cause');
  });

  it('迁移失败时隐藏底层错误并关闭数据库连接', async () => {
    const databasePath = await createDatabasePath();
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE displayMessages (id TEXT PRIMARY KEY)');
    database.close();

    const error = captureConstructionError(databasePath);
    expect(error.message).toBe(`无法打开长期记忆数据库：${databasePath}`);
    expect(error).not.toHaveProperty('cause');

    const verificationDatabase = new DatabaseSync(databasePath);
    try {
      expect(verificationDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
      expect(verificationDatabase.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
      ).get()).toBeUndefined();
      expect(verificationDatabase.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'displayMessages'",
      ).get()?.name).toBe('displayMessages');
      expect(() => verificationDatabase.exec('BEGIN IMMEDIATE; ROLLBACK;')).not.toThrow();
    } finally {
      verificationDatabase.close();
    }
  });
});

describe('PersistenceStore session CRUD', () => {
  it('原子写入一轮开头并按工作区和客户端隔离会话', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    const webSession = buildSession();
    const cliSession = buildSession({
      id: 'session-2',
      clientType: 'cli',
      title: 'CLI 会话',
      updatedAt: 2,
    });
    store.createSession(webSession);
    store.createSession(cliSession);

    store.beginTurn(
      webSession.id,
      buildDisplayMessage(),
      { role: 'user', content: '模型输入' },
    );

    expect(store.listSessions({
      workspace: webSession.workspace,
      clientType: 'web',
    })).toEqual([{
      ...webSession,
      status: 'running',
      turns: 1,
    }]);
    expect(store.loadDisplayMessages(webSession.id)).toEqual([{
      ...buildDisplayMessage(),
      sessionId: webSession.id,
      sequence: 0,
    }]);
    expect(store.loadAgentMessages(webSession.id)).toEqual([
      { role: 'user', content: '模型输入' },
    ]);
    store.close();
  });

  it('删除会话级联删除两类消息', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    const session = buildSession();
    store.createSession(session);
    store.beginTurn(
      session.id,
      buildDisplayMessage(),
      { role: 'user', content: '模型输入' },
    );

    store.deleteSession(session.id);

    expect(store.loadDisplayMessages(session.id)).toEqual([]);
    expect(store.loadAgentMessages(session.id)).toEqual([]);
    expect(store.listSessions()).toEqual([]);
    store.close();
  });

  it('修复进程退出留下的运行状态和未配对工具消息', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    const session = buildSession({
      memoryExtractionStatus: 'running',
    });
    store.createSession(session);
    store.beginTurn(
      session.id,
      buildDisplayMessage(),
      { role: 'user', content: '执行工具' },
    );
    store.appendAgentMessages(session.id, [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'readFile', arguments: '{}' },
      }],
    }]);

    store.recoverInterruptedWork();

    expect(store.getSession(session.id)).toMatchObject({
      status: 'interrupted',
      memoryExtractionStatus: 'failed',
      memoryExtractionError: '服务重启，记忆提取未完成',
    });
    expect(store.loadAgentMessages(session.id).at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: '{"error":"服务中断，工具结果未知"}',
    });
    store.close();
  });

  it('事务失败不留下半写数据', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    const session = buildSession();
    store.createSession(session);
    getTestDatabase(store).exec(`
      CREATE TRIGGER failAgentInsert
      BEFORE INSERT ON agentMessages
      BEGIN
        SELECT RAISE(ABORT, 'forced agent insert failure');
      END;
    `);

    expect(() => store.beginTurn(
      session.id,
      buildDisplayMessage(),
      { role: 'user', content: '模型输入' },
    )).toThrow('forced agent insert failure');

    expect(store.loadDisplayMessages(session.id)).toEqual([]);
    expect(store.loadAgentMessages(session.id)).toEqual([]);
    expect(store.getSession(session.id)).toEqual(session);
    store.close();
  });

  it('按 workspace 和 clientType 组合查询并稳定排序', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    const sessions = [
      buildSession({ id: 'web-b', updatedAt: 3 }),
      buildSession({ id: 'web-a', updatedAt: 3 }),
      buildSession({ id: 'cli-a', clientType: 'cli', updatedAt: 4 }),
      buildSession({ id: 'other-web', workspace: '/workspace/two', updatedAt: 5 }),
    ];
    sessions.forEach((session) => store.createSession(session));

    expect(store.listSessions().map(({ id }) => id)).toEqual([
      'other-web', 'cli-a', 'web-a', 'web-b',
    ]);
    expect(store.listSessions({ workspace: '/workspace/one' }).map(({ id }) => id)).toEqual([
      'cli-a', 'web-a', 'web-b',
    ]);
    expect(store.listSessions({ clientType: 'web' }).map(({ id }) => id)).toEqual([
      'other-web', 'web-a', 'web-b',
    ]);
    expect(store.listSessions({
      workspace: '/workspace/one',
      clientType: 'cli',
    }).map(({ id }) => id)).toEqual(['cli-a']);
    store.close();
  });

  it('分别维护严格递增的显示消息和 agent 消息序号', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    const session = buildSession();
    store.createSession(session);
    store.beginDisplayOnlyTurn(session.id, buildDisplayMessage());
    store.appendDisplayMessage(session.id, buildDisplayMessage({
      id: 'display-2',
      role: 'assistant',
      content: '第一条回复',
      createdAt: 3,
    }), {
      title: '已更新',
      updatedAt: 3,
    });
    store.appendDisplayMessage(session.id, buildDisplayMessage({
      id: 'display-3',
      role: 'notice',
      content: '提示',
      createdAt: 4,
    }), {});
    store.appendAgentMessages(session.id, [
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '第二条' },
    ]);
    store.appendAgentMessages(session.id, [
      { role: 'tool', tool_call_id: 'call-1', content: '第三条' },
    ]);

    expect(store.loadDisplayMessages(session.id).map(({ sequence }) => sequence)).toEqual([0, 1, 2]);
    expect(store.loadAgentMessages(session.id)).toEqual([
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '第二条' },
      { role: 'tool', tool_call_id: 'call-1', content: '第三条' },
    ]);
    expect(getTestDatabase(store).prepare(
      'SELECT sequence FROM agentMessages WHERE sessionId = ? ORDER BY sequence',
    ).all(session.id).map(({ sequence }) => Number(sequence))).toEqual([0, 1, 2]);
    expect(store.getSession(session.id)).toMatchObject({
      title: '已更新',
      status: 'running',
      turns: 1,
      updatedAt: 3,
    });
    store.close();
  });

  it('agent payload 写入和读取都执行严格 schema 校验', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    const session = buildSession();
    store.createSession(session);

    expect(() => store.appendAgentMessages(session.id, [{
      role: 'assistant',
      content: '',
    }])).toThrow();
    expect(store.loadAgentMessages(session.id)).toEqual([]);

    getTestDatabase(store).prepare(`
      INSERT INTO agentMessages (id, sessionId, sequence, payloadJson, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `).run('invalid-agent', session.id, 0, '{}', 2);
    expect(() => store.loadAgentMessages(session.id)).toThrow();
    store.close();
  });

  it('缺失会话返回一致错误并安全处理 patch 边界', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    const session = buildSession();
    const missingError = '会话不存在：missing';

    expect(() => store.getSession('missing')).toThrow(missingError);
    expect(() => store.beginDisplayOnlyTurn(
      'missing',
      buildDisplayMessage(),
    )).toThrow(missingError);
    expect(() => store.appendAgentMessages(
      'missing',
      [{ role: 'user', content: '输入' }],
    )).toThrow(missingError);
    expect(() => store.updateSession('missing', {})).toThrow(missingError);

    store.createSession(session);
    expect(() => store.updateSession(session.id, {})).not.toThrow();
    expect(() => store.updateSession(
      session.id,
      { turns: 99 } as never,
    )).toThrow('不支持的会话更新字段：turns');
    expect(store.getSession(session.id)).toEqual(session);
    store.close();
  });

  it.each([
    { field: 'title', patch: { title: 42 } },
    { field: 'title', patch: { title: undefined } },
    { field: 'status', patch: { status: 'paused' } },
    { field: 'memoryExtractionStatus', patch: { memoryExtractionStatus: 'pending' } },
    { field: 'memoryExtractionError', patch: { memoryExtractionError: 404 } },
    { field: 'updatedAt', patch: { updatedAt: Number.NaN } },
    { field: 'updatedAt', patch: { updatedAt: Number.POSITIVE_INFINITY } },
    { field: 'updatedAt', patch: { updatedAt: 1.5 } },
    { field: 'updatedAt', patch: { updatedAt: -1 } },
  ])('拒绝非法 $field patch 值且不修改会话', async ({ field, patch }) => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    const session = buildSession();
    store.createSession(session);

    expect(() => store.updateSession(session.id, patch as never))
      .toThrow(`无效的会话更新字段值：${field}`);
    expect(store.getSession(session.id)).toEqual(session);
    store.close();
  });

  it('恢复时不修补 idle 会话的未配对工具调用', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    const session = buildSession({ memoryExtractionStatus: 'running' });
    store.createSession(session);
    store.appendAgentMessages(session.id, [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-idle',
        type: 'function',
        function: { name: 'readFile', arguments: '{}' },
      }],
    }]);

    store.recoverInterruptedWork();

    expect(store.getSession(session.id)).toMatchObject({
      status: 'idle',
      memoryExtractionStatus: 'failed',
      memoryExtractionError: '服务重启，记忆提取未完成',
    });
    expect(store.loadAgentMessages(session.id)).toHaveLength(1);
    store.close();
  });

  it('恢复时不修补最后普通 assistant 回复之前的工具调用', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    const session = buildSession({ status: 'running' });
    store.createSession(session);
    store.appendAgentMessages(session.id, [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-earlier',
          type: 'function',
          function: { name: 'readFile', arguments: '{}' },
        }],
      },
      { role: 'assistant', content: '已完成' },
    ]);

    store.recoverInterruptedWork();

    expect(store.loadAgentMessages(session.id)).toHaveLength(2);
    expect(store.getSession(session.id).status).toBe('interrupted');
    store.close();
  });

  it('恢复 running 会话时仅补最后 assistant 的缺失调用且重复调用幂等', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    const firstSession = buildSession({ id: 'session-1', status: 'running' });
    const secondSession = buildSession({
      id: 'session-2',
      status: 'running',
      memoryExtractionStatus: 'running',
    });
    store.createSession(firstSession);
    store.createSession(secondSession);
    store.appendAgentMessages(firstSession.id, [{
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-paired',
          type: 'function',
          function: { name: 'readFile', arguments: '{}' },
        },
        {
          id: 'call-missing',
          type: 'function',
          function: { name: 'writeFile', arguments: '{}' },
        },
      ],
    }, {
      role: 'tool',
      tool_call_id: 'call-paired',
      content: '{"ok":true}',
    }]);
    store.appendAgentMessages(secondSession.id, [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-second',
        type: 'function',
        function: { name: 'search', arguments: '{}' },
      }],
    }]);

    store.recoverInterruptedWork();
    store.recoverInterruptedWork();

    expect(store.loadAgentMessages(firstSession.id).filter(
      (message) => message.role === 'tool',
    )).toEqual([
      { role: 'tool', tool_call_id: 'call-paired', content: '{"ok":true}' },
      {
        role: 'tool',
        tool_call_id: 'call-missing',
        content: '{"error":"服务中断，工具结果未知"}',
      },
    ]);
    expect(store.loadAgentMessages(secondSession.id).filter(
      (message) => message.role === 'tool',
    )).toEqual([{
      role: 'tool',
      tool_call_id: 'call-second',
      content: '{"error":"服务中断，工具结果未知"}',
    }]);
    expect(store.getSession(firstSession.id)).toMatchObject({
      status: 'interrupted',
      memoryExtractionStatus: 'idle',
      memoryExtractionError: null,
    });
    expect(store.getSession(secondSession.id)).toMatchObject({
      status: 'interrupted',
      memoryExtractionStatus: 'failed',
      memoryExtractionError: '服务重启，记忆提取未完成',
    });
    store.close();
  });
});

describe('persistedAgentMessageSchema', () => {
  it.each([
    { role: 'assistant', content: null },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '  ' },
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'assistant', content: ' ', tool_calls: [] },
  ])('拒绝没有有效文本或工具调用的 assistant 消息：%j', (message) => {
    expect(persistedAgentMessageSchema.safeParse(message).success).toBe(false);
  });

  it('接受非空文本或至少一个工具调用并保持 OpenAI 消息类型兼容', () => {
    const textMessage: ChatCompletionMessageParam = persistedAgentMessageSchema.parse({
      role: 'assistant',
      content: '已完成',
    });
    const toolMessageWithEmptyContent: ChatCompletionMessageParam = persistedAgentMessageSchema.parse({
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'readFile', arguments: '{}' },
      }],
    });
    const toolMessageWithNullContent: ChatCompletionMessageParam = persistedAgentMessageSchema.parse({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-2',
        type: 'function',
        function: { name: 'search', arguments: '{"query":"schema"}' },
      }],
    });

    expect(textMessage).toEqual({ role: 'assistant', content: '已完成' });
    expect(toolMessageWithEmptyContent).toMatchObject({ role: 'assistant', content: '' });
    expect(toolMessageWithNullContent).toMatchObject({ role: 'assistant', content: null });
  });
});

describe('PersistenceStore memory transactions', () => {
  /** 构造用于事务测试的待确认记忆候选。 */
  function buildMemoryCandidate(
    overrides: Partial<StoredMemoryCandidate> = {},
  ): StoredMemoryCandidate {
    return {
      id: 'candidate-1',
      workspace: '/workspace/one',
      sourceSessionId: 'session-1',
      sourceTurn: 1,
      category: 'rule',
      content: '使用 React 19',
      normalizedContent: '使用 react 19',
      status: 'pending',
      acceptedMemoryId: null,
      createdAt: 10,
      resolvedAt: null,
      ...overrides,
    };
  }

  it('批量候选插入失败时不留下部分数据', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    store.createSession(buildSession());
    getTestDatabase(store).exec(`
      CREATE TRIGGER failCandidateInsert
      BEFORE INSERT ON memoryCandidates
      WHEN NEW.id = 'candidate-fail'
      BEGIN
        SELECT RAISE(ABORT, 'forced candidate insert failure');
      END;
    `);

    expect(() => store.insertMemoryCandidates([
      buildMemoryCandidate(),
      buildMemoryCandidate({ id: 'candidate-fail', createdAt: 11 }),
    ])).toThrow('forced candidate insert failure');

    expect(store.listMemoryCandidates('session-1')).toEqual([]);
    store.close();
  });

  it('一次查询返回工作区全部非 ignored 候选去重键并隔离其他工作区', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    store.createSession(buildSession());
    store.createSession(buildSession({
      id: 'session-2',
      updatedAt: 2,
    }));
    store.createSession(buildSession({
      id: 'session-3',
      workspace: '/workspace/two',
      updatedAt: 3,
    }));
    store.insertMemoryCandidates([
      buildMemoryCandidate(),
      buildMemoryCandidate({
        id: 'candidate-2',
        sourceSessionId: 'session-2',
        content: '第二条候选',
        normalizedContent: '第二条候选',
        status: 'accepted',
        createdAt: 11,
      }),
      buildMemoryCandidate({
        id: 'candidate-ignored',
        sourceSessionId: 'session-2',
        content: '已忽略候选',
        normalizedContent: '已忽略候选',
        status: 'ignored',
        createdAt: 12,
      }),
      buildMemoryCandidate({
        id: 'candidate-other',
        workspace: '/workspace/two',
        sourceSessionId: 'session-3',
        content: '其他工作区候选',
        normalizedContent: '其他工作区候选',
        createdAt: 13,
      }),
    ]);

    expect(store.listNonIgnoredMemoryCandidateNormalizedContents('/workspace/one'))
      .toEqual(['使用 react 19', '第二条候选']);
    store.close();
  });

  it('一次查询返回工作区全部正式记忆去重键且包含停用项', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    store.createSession(buildSession());
    store.createSession(buildSession({
      id: 'session-2',
      workspace: '/workspace/two',
      updatedAt: 2,
    }));
    store.insertMemoryCandidates([
      buildMemoryCandidate(),
      buildMemoryCandidate({
        id: 'candidate-other',
        workspace: '/workspace/two',
        sourceSessionId: 'session-2',
        content: '其他工作区记忆',
        normalizedContent: '其他工作区记忆',
        createdAt: 11,
      }),
    ]);
    const memory = store.resolveMemoryCandidate('session-1', 'candidate-1', {
      action: 'accept',
      content: '使用 React 19',
      normalizedContent: '使用 react 19',
    }, 20);
    store.resolveMemoryCandidate('session-2', 'candidate-other', {
      action: 'accept',
      content: '其他工作区记忆',
      normalizedContent: '其他工作区记忆',
    }, 21);
    store.updateMemory('session-1', memory!.id, { active: false });

    expect(store.listMemoryNormalizedContents('/workspace/one'))
      .toEqual(['使用 react 19']);
    store.close();
  });

  it('listMemories 将安全正整数 limit 下推并拒绝无效值', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    store.createSession(buildSession());
    const candidates = Array.from({ length: 3 }, (_, index) => buildMemoryCandidate({
      id: `candidate-${index}`,
      content: `记忆-${index}`,
      normalizedContent: `记忆-${index}`,
      createdAt: index + 10,
    }));
    store.insertMemoryCandidates(candidates);
    candidates.forEach((candidate, index) => {
      store.resolveMemoryCandidate('session-1', candidate.id, {
        action: 'accept',
        content: candidate.content,
        normalizedContent: candidate.normalizedContent,
      }, index + 20);
    });

    expect(store.listMemories('/workspace/one', true, 2).map(({ content }) => content))
      .toEqual(['记忆-2', '记忆-1']);
    for (const limit of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => store.listMemories('/workspace/one', false, limit))
        .toThrow('记忆查询条数限制必须是安全正整数');
    }
    store.close();
  });

  it('空候选批次也会原子完成提取并清空旧错误', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    store.createSession(buildSession({
      memoryExtractionStatus: 'running',
      memoryExtractionError: '旧错误',
    }));

    store.completeMemoryExtraction('session-1', []);

    expect(store.getSession('session-1')).toMatchObject({
      memoryExtractionStatus: 'complete',
      memoryExtractionError: null,
    });
    expect(store.listMemoryCandidates('session-1')).toEqual([]);
    store.close();
  });

  it('候选插入失败时不留下候选或完成状态', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    store.createSession(buildSession({ memoryExtractionStatus: 'running' }));
    getTestDatabase(store).exec(`
      CREATE TRIGGER failExtractionCandidateInsert
      BEFORE INSERT ON memoryCandidates
      BEGIN
        SELECT RAISE(ABORT, 'forced extraction candidate failure');
      END;
    `);

    expect(() => store.completeMemoryExtraction(
      'session-1',
      [buildMemoryCandidate()],
    )).toThrow('forced extraction candidate failure');

    expect(store.listMemoryCandidates('session-1')).toEqual([]);
    expect(store.getSession('session-1')).toMatchObject({
      memoryExtractionStatus: 'running',
      memoryExtractionError: null,
    });
    store.close();
  });

  it('完成状态更新失败时回滚已插入候选', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    store.createSession(buildSession({ memoryExtractionStatus: 'running' }));
    getTestDatabase(store).exec(`
      CREATE TRIGGER failExtractionCompletion
      BEFORE UPDATE ON sessions
      WHEN NEW.memoryExtractionStatus = 'complete'
      BEGIN
        SELECT RAISE(ABORT, 'forced extraction completion failure');
      END;
    `);

    expect(() => store.completeMemoryExtraction(
      'session-1',
      [buildMemoryCandidate()],
    )).toThrow('forced extraction completion failure');

    expect(store.listMemoryCandidates('session-1')).toEqual([]);
    expect(store.getSession('session-1')).toMatchObject({
      memoryExtractionStatus: 'running',
      memoryExtractionError: null,
    });
    store.close();
  });

  it('接受候选的后半段失败时回滚新建的正式记忆', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    store.createSession(buildSession());
    store.insertMemoryCandidates([buildMemoryCandidate()]);
    getTestDatabase(store).exec(`
      CREATE TRIGGER failCandidateResolve
      BEFORE UPDATE ON memoryCandidates
      WHEN NEW.status = 'accepted'
      BEGIN
        SELECT RAISE(ABORT, 'forced candidate resolve failure');
      END;
    `);

    expect(() => store.resolveMemoryCandidate('session-1', 'candidate-1', {
      action: 'accept',
      content: '使用 React 19',
      normalizedContent: '使用 react 19',
    }, 20)).toThrow('forced candidate resolve failure');

    expect(store.listMemories('/workspace/one')).toEqual([]);
    expect(store.listMemoryCandidates('session-1')).toMatchObject([{
      status: 'pending',
      acceptedMemoryId: null,
      resolvedAt: null,
    }]);
    store.close();
  });
});
