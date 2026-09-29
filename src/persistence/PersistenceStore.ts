import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const schemaVersion = 1;

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
      database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
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

  /** 返回 SQLite Schema 版本。 */
  getSchemaVersion(): number {
    return Number(this.database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  }

  /** 返回当前连接的关键 SQLite 初始化设置。 */
  getPragmaSettings(): { journalMode: string; foreignKeys: boolean; busyTimeout: number } {
    return {
      journalMode: String(this.database.prepare('PRAGMA journal_mode').get()?.journal_mode ?? ''),
      foreignKeys: Boolean(Number(this.database.prepare('PRAGMA foreign_keys').get()?.foreign_keys ?? 0)),
      busyTimeout: Number(this.database.prepare('PRAGMA busy_timeout').get()?.timeout ?? 0),
    };
  }

  /** 返回按名称排序的业务表，供迁移检查使用。 */
  listTableNames(): string[] {
    return this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((row) => String(row.name));
  }

  /** 关闭 SQLite 连接。 */
  close(): void {
    this.database.close();
  }
}
