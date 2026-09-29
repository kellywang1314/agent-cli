import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDatabasePath } from '../src/persistence/databasePath.js';
import { persistedAgentMessageSchema } from '../src/persistence/messageSchema.js';
import { PersistenceStore } from '../src/persistence/PersistenceStore.js';

const cleanups: Array<() => Promise<void>> = [];

/** 清理每个用例创建的临时数据库目录。 */
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 创建独立数据库路径并注册清理函数。 */
async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-db-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'agent.db');
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

/** 通过 IPC 屏障同时启动多个独立进程中的数据库初始化。 */
async function runConcurrentInitializers(databasePath: string, processCount = 12): Promise<Array<{ ok: boolean; error?: string }>> {
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
  const children = Array.from({ length: processCount }, () => spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', script,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_PATH: databasePath },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }));
  const readyPromises: Array<Promise<void>> = [];
  const resultPromises: Array<Promise<{ ok: boolean; error?: string }>> = [];
  const exitPromises: Array<Promise<void>> = [];
  for (const child of children) {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    readyPromises.push(new Promise((resolve, reject) => {
      child.once('error', reject);
      child.on('message', (message) => {
        if (message === 'ready') resolve();
      });
      child.once('exit', (code) => {
        reject(new Error(`初始化子进程未就绪即退出 (${code})：${stderr}`));
      });
    }));
    resultPromises.push(new Promise((resolve, reject) => {
      child.once('error', reject);
      child.on('message', (message) => {
        if (typeof message === 'object' && message !== null && 'ok' in message) {
          resolve(message as { ok: boolean; error?: string });
        }
      });
      child.once('exit', (code) => {
        reject(new Error(`初始化子进程未返回结果 (${code})：${stderr}`));
      });
    }));
    exitPromises.push(new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`初始化子进程失败 (${code})：${stderr}`));
      });
    }));
  }
  try {
    await Promise.all(readyPromises);
    for (const child of children) child.send('start');
    const results = await Promise.all(resultPromises);
    await Promise.all(exitPromises);
    return results;
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
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

  it('为数据库连接启用关键 PRAGMA', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    expect(store.getPragmaSettings()).toEqual({
      journalMode: 'wal',
      foreignKeys: true,
      busyTimeout: 5000,
    });
    store.close();
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
  });

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
