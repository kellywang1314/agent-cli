import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDatabasePath } from '../src/persistence/databasePath.js';
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

  it('限制数据目录和数据库文件为仅用户可访问', async () => {
    const databasePath = await createDatabasePath();
    await chmod(path.dirname(databasePath), 0o755);
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
    database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    database.close();

    const error = captureConstructionError(databasePath);
    expect(error.message).toBe(`无法打开长期记忆数据库：${databasePath}`);
    expect(error).not.toHaveProperty('cause');

    const verificationDatabase = new DatabaseSync(databasePath);
    try {
      expect(() => verificationDatabase.exec('BEGIN IMMEDIATE; ROLLBACK;')).not.toThrow();
    } finally {
      verificationDatabase.close();
    }
  });
});
