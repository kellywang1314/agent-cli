# Agent Long-Term Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Web 工作台和 Ink CLI 增加基于 SQLite 的会话恢复，以及经用户确认后生效的工作区级长期记忆。

**Architecture:** 使用 `PersistenceStore` 独占 SQLite 访问，`SessionService` 统一编排会话和 Agent 执行，`MemoryService` 负责候选提取、确认、去重和动态注入。Web 与 CLI 只维护各自的展示状态和交互，复用相同的服务层；系统提示词和项目记忆在每次模型请求时动态组合，不持久化到模型消息表。

**Tech Stack:** Node.js 22.5+、TypeScript、`node:sqlite`、Zod、React 19、Ink 6、原生 HTTP/SSE、Vitest、Playwright Core。

---

## 实施前提与文件边界

当前 Git 只有长期记忆设计文档一个提交，现有源码仍未跟踪。执行任务 0 后再创建 worktree 或分派实现子任务，避免新 worktree 中缺少项目源码。

新增模块：

- `src/persistence/databasePath.ts`：解析 macOS 默认数据库路径和配置覆盖。
- `src/persistence/types.ts`：持久化实体及输入类型。
- `src/persistence/messageSchema.ts`：模型消息 JSON 的运行时校验。
- `src/persistence/PersistenceStore.ts`：Schema、迁移、事务和全部 SQLite 查询。
- `src/memory/types.ts`：记忆类别、候选操作和展示模型。
- `src/memory/memoryPrompt.ts`：提取提示词与注入提示词。
- `src/memory/MemoryService.ts`：提取、校验、敏感信息过滤、去重和确认。
- `src/sessions/types.ts`：共享会话摘要、详情、运行 Hook 和结果。
- `src/sessions/SessionService.ts`：Web/CLI 共用的会话生命周期和 Agent 编排。
- `src/web/MemoryPanel.tsx`：Web 记忆管理面板。
- `src/ui/MemoryPrompt.tsx`：Ink 候选记忆逐条确认界面。
- `tests/persistence.test.ts`：数据库和恢复协议测试。
- `tests/memory.test.ts`：记忆提取与生命周期测试。
- `tests/sessionService.test.ts`：共享会话服务测试。

主要修改：

- `src/agent/AgentLoop.ts`：恢复历史、动态系统上下文、可靠追加回调。
- `src/config/loadConfig.ts`：数据库路径配置。
- `src/web/sessions.ts`：改为 `SessionService` 的 Web 适配层。
- `src/web/server.ts`：会话详情和记忆 API。
- `src/web/types.ts`、`src/web/api.ts`、`src/web/Workbench.tsx`、`src/web/Inspector.tsx`、`src/web/styles.css`：摘要/详情分离和记忆 UI。
- `src/main.tsx`、`src/ui/App.tsx`：CLI 恢复、会话命令和候选确认。
- `README.md`、`.env.example`、`package.json`：运行要求、配置和交互说明。

## Task 0: 建立可审查的项目基线

**Files:**
- Modify: `.gitignore`
- Commit existing: `.env.example`, `README.md`, `package.json`, `pnpm-lock.yaml`, `scripts/`, `src/`, `tests/`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `docs/superpowers/specs/`, `docs/superpowers/plans/`

- [ ] **Step 1: 验证运行时目录尚未被忽略**

Run:

```bash
git check-ignore .superpowers/brainstorm/11300-1790664710/state/server.pid
```

Expected: 命令退出码为 1，说明 `.superpowers/` 尚未被忽略。

- [ ] **Step 2: 忽略本地 brainstorming 运行产物**

在 `.gitignore` 末尾添加：

```gitignore
.superpowers/
```

- [ ] **Step 3: 验证忽略规则且执行当前基线测试**

Run:

```bash
git check-ignore .superpowers/brainstorm/11300-1790664710/state/server.pid
pnpm typecheck
pnpm test
pnpm build
```

Expected:

- `git check-ignore` 输出匹配路径。
- TypeScript 无错误。
- 当前全部 Vitest 用例通过。
- Web 资源和 Node 产物构建成功。

- [ ] **Step 4: 只暂存项目基线，不加入本地密钥和运行产物**

Run:

```bash
git add .gitignore .env.example README.md package.json pnpm-lock.yaml scripts src tests tsconfig.json tsconfig.build.json vitest.config.ts docs/superpowers/specs docs/superpowers/plans
git status --short
```

Expected: `.env` 和 `.superpowers/` 不在暂存列表中。

- [ ] **Step 5: 提交基线**

```bash
git commit -m "chore: establish agent cli baseline"
```

## Task 1: 增加数据库路径、Schema 与安全初始化

**Files:**
- Create: `src/persistence/databasePath.ts`
- Create: `src/persistence/types.ts`
- Create: `src/persistence/messageSchema.ts`
- Create: `src/persistence/PersistenceStore.ts`
- Create: `tests/persistence.test.ts`
- Modify: `src/config/loadConfig.ts`
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: 为默认路径和首次迁移编写失败测试**

在 `tests/persistence.test.ts` 写入：

```ts
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDatabasePath } from '../src/persistence/databasePath.js';
import { PersistenceStore } from '../src/persistence/PersistenceStore.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 创建独立数据库路径并在用例结束后清理。 */
async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-db-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'agent.db');
}

describe('PersistenceStore schema', () => {
  it('在 macOS 用户数据目录生成默认路径', () => {
    expect(resolveDatabasePath({}, '/Users/tester')).toBe(
      '/Users/tester/Library/Application Support/agent-cli/agent.db',
    );
    expect(resolveDatabasePath({ AGENT_CLI_DB_PATH: './custom.db' }, '/tmp')).toBe('/tmp/custom.db');
  });

  it('首次打开创建版本 1 Schema 和仅用户可访问的数据目录', async () => {
    const databasePath = await createDatabasePath();
    const store = new PersistenceStore(databasePath);
    expect(store.getSchemaVersion()).toBe(1);
    expect(store.listTableNames()).toEqual([
      'agentMessages', 'displayMessages', 'memories', 'memoryCandidates', 'sessions',
    ]);
    store.close();
    expect((await stat(path.dirname(databasePath))).mode & 0o777).toBe(0o700);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
  });
});
```

- [ ] **Step 2: 运行测试并确认模块尚不存在**

Run:

```bash
pnpm vitest run tests/persistence.test.ts
```

Expected: FAIL，提示无法解析 `src/persistence/databasePath.ts` 或 `PersistenceStore.ts`。

- [ ] **Step 3: 定义持久化实体和模型消息 Schema**

在 `src/persistence/types.ts` 定义：

```ts
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export type SessionClientType = 'web' | 'cli';
export type SessionStatus = 'idle' | 'running' | 'interrupted' | 'failed';
export type MemoryExtractionStatus = 'idle' | 'running' | 'failed' | 'complete';
export type DisplayMessageRole = 'user' | 'assistant' | 'notice';
export type MemoryCategory = 'rule' | 'decision' | 'fact' | 'preference';
export type MemoryCandidateStatus = 'pending' | 'accepted' | 'ignored';

export interface StoredSession {
  id: string;
  clientType: SessionClientType;
  workspace: string;
  title: string;
  status: SessionStatus;
  turns: number;
  memoryExtractionStatus: MemoryExtractionStatus;
  memoryExtractionError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredDisplayMessage {
  id: string;
  sessionId: string;
  sequence: number;
  role: DisplayMessageRole;
  content: string;
  createdAt: number;
}

export interface StoredAgentMessage {
  id: string;
  sessionId: string;
  sequence: number;
  message: ChatCompletionMessageParam;
  createdAt: number;
}

export interface StoredMemoryCandidate {
  id: string;
  workspace: string;
  sourceSessionId: string;
  sourceTurn: number;
  category: MemoryCategory;
  content: string;
  normalizedContent: string;
  status: MemoryCandidateStatus;
  acceptedMemoryId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface StoredMemory {
  id: string;
  workspace: string;
  category: MemoryCategory;
  content: string;
  normalizedContent: string;
  active: boolean;
  sourceSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}
```

在 `src/persistence/messageSchema.ts` 使用 Zod 只接受本项目会产生的消息：

```ts
import { z } from 'zod';

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});

export const persistedAgentMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    tool_calls: z.array(toolCallSchema).optional(),
  }),
  z.object({
    role: z.literal('tool'),
    tool_call_id: z.string().min(1),
    content: z.string(),
  }),
]);
```

- [ ] **Step 4: 实现数据库路径解析**

在 `src/persistence/databasePath.ts` 写入：

```ts
import path from 'node:path';

/** 解析数据库路径，显式配置相对当前目录，默认使用 macOS 用户数据目录。 */
export function resolveDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = process.env.HOME ?? '',
  currentDirectory = process.cwd(),
): string {
  const configured = env.AGENT_CLI_DB_PATH?.trim();
  if (configured) return path.resolve(currentDirectory, configured);
  if (!homeDirectory) throw new Error('无法确定用户目录，请配置 AGENT_CLI_DB_PATH');
  return path.join(homeDirectory, 'Library', 'Application Support', 'agent-cli', 'agent.db');
}
```

- [ ] **Step 5: 实现版本 1 Schema 和数据库权限**

在 `src/persistence/PersistenceStore.ts` 中实现构造、迁移、检查和关闭。迁移 SQL 必须完整包含：

```ts
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const schemaVersion = 1;

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

  /** 打开数据库、限制权限并执行顺序迁移。 */
  constructor(readonly databasePath: string) {
    const directory = path.dirname(databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    const version = this.getSchemaVersion();
    if (version === 0) this.database.exec(`BEGIN IMMEDIATE; ${migrationV1} COMMIT;`);
    else if (version !== schemaVersion) throw new Error(`不支持的数据库版本：${version}`);
  }

  /** 返回 SQLite Schema 版本。 */
  getSchemaVersion(): number {
    return Number(this.database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  }

  /** 返回业务表名称，供迁移测试使用。 */
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
```

构造失败时捕获错误，关闭已打开连接，并抛出不包含 SQL 内容的 `无法打开长期记忆数据库：<path>`。

- [ ] **Step 6: 接入配置并提高 Node 最低版本**

在 `src/config/loadConfig.ts`：

```ts
import { resolveDatabasePath } from '../persistence/databasePath.js';

export interface ConfigInput {
  apiKey?: string;
  chatUrl?: string;
  imageUrl?: string;
  model?: string;
  imageModel?: string;
  workspace?: string;
  maxRounds?: number;
  databasePath?: string;
}

const configSchema = z.object({
  apiKey: z.string().trim().min(1, '请通过 AIDP_API_KEY 配置密钥'),
  chatUrl: endpointSchema,
  imageUrl: endpointSchema,
  model: z.string().trim().min(1),
  imageModel: z.string().trim().min(1),
  workspace: z.string().min(1),
  maxRounds: z.number().int().min(1).max(100),
  databasePath: z.string().min(1),
});

const parsed = configSchema.safeParse({
  apiKey: input.apiKey ?? env.AIDP_API_KEY ?? '',
  chatUrl: input.chatUrl ?? env.AIDP_CHAT_URL ?? 'https://aidp.bytedance.net/api/modelhub/online/v2/crawl',
  imageUrl: input.imageUrl ?? env.AIDP_IMAGE_URL ??
    'https://aidp.bytedance.net/api/modelhub/online/v2/crawl/openai/images/generations',
  model,
  imageModel: input.imageModel || env.AIDP_IMAGE_MODEL || model,
  workspace: path.resolve(input.workspace ?? process.cwd()),
  maxRounds: input.maxRounds ?? 20,
  databasePath: path.resolve(input.databasePath ?? resolveDatabasePath(env)),
});
```

在 `package.json` 修改：

```json
"engines": {
  "node": ">=22.5.0"
}
```

在 `.env.example` 添加：

```dotenv
# 可选：覆盖本地会话与记忆数据库路径。
# AGENT_CLI_DB_PATH=/absolute/path/to/agent.db
```

- [ ] **Step 7: 运行测试和类型检查**

Run:

```bash
pnpm vitest run tests/persistence.test.ts
pnpm typecheck
```

Expected: 新测试通过，TypeScript 无错误。

- [ ] **Step 8: 提交数据库基础**

```bash
git add package.json .env.example src/config/loadConfig.ts src/persistence tests/persistence.test.ts
git commit -m "feat: add sqlite persistence foundation"
```

## Task 2: 实现会话、消息和恢复 CRUD

**Files:**
- Modify: `src/persistence/types.ts`
- Modify: `src/persistence/PersistenceStore.ts`
- Modify: `tests/persistence.test.ts`

- [ ] **Step 1: 编写会话事务、隔离和级联失败测试**

向 `tests/persistence.test.ts` 添加：

```ts
it('原子写入一轮开头并按工作区和客户端隔离会话', async () => {
  const store = new PersistenceStore(await createDatabasePath());
  const now = Date.now();
  store.createSession({
    id: 'web-1', clientType: 'web', workspace: '/repo/a', title: '任务',
    status: 'idle', turns: 0, memoryExtractionStatus: 'idle',
    memoryExtractionError: null, createdAt: now, updatedAt: now,
  });
  store.createSession({
    id: 'cli-1', clientType: 'cli', workspace: '/repo/a', title: '终端',
    status: 'idle', turns: 0, memoryExtractionStatus: 'idle',
    memoryExtractionError: null, createdAt: now, updatedAt: now,
  });
  store.beginTurn('web-1', {
    id: 'display-1', role: 'user', content: 'hello', createdAt: now,
  }, { role: 'user', content: 'hello' });

  expect(store.listSessions({ workspace: '/repo/a', clientType: 'web' })).toHaveLength(1);
  expect(store.loadDisplayMessages('web-1')[0].content).toBe('hello');
  expect(store.loadAgentMessages('web-1')).toEqual([{ role: 'user', content: 'hello' }]);
  expect(store.getSession('web-1').turns).toBe(1);
  expect(store.getSession('web-1').status).toBe('running');
  store.close();
});

it('删除会话级联删除两类消息', async () => {
  const store = new PersistenceStore(await createDatabasePath());
  const now = Date.now();
  store.createSession({
    id: 'session-1', clientType: 'web', workspace: '/repo/a', title: '任务',
    status: 'idle', turns: 0, memoryExtractionStatus: 'idle',
    memoryExtractionError: null, createdAt: now, updatedAt: now,
  });
  store.beginTurn('session-1', {
    id: 'display-1', role: 'user', content: 'hello', createdAt: now,
  }, { role: 'user', content: 'hello' });
  store.deleteSession('session-1');
  expect(store.loadDisplayMessages('session-1')).toEqual([]);
  expect(store.loadAgentMessages('session-1')).toEqual([]);
  expect(store.listSessions()).toEqual([]);
  store.close();
});

it('修复进程退出留下的运行状态和未配对工具消息', async () => {
  const store = new PersistenceStore(await createDatabasePath());
  const now = Date.now();
  store.createSession({
    id: 'session-1', clientType: 'web', workspace: '/repo/a', title: '任务',
    status: 'idle', turns: 0, memoryExtractionStatus: 'running',
    memoryExtractionError: null, createdAt: now, updatedAt: now,
  });
  store.beginTurn('session-1', {
    id: 'display-1', role: 'user', content: 'hello', createdAt: now,
  }, { role: 'user', content: 'hello' });
  store.appendAgentMessages('session-1', [{
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'call-1',
      type: 'function',
      function: { name: 'readFile', arguments: '{"path":"README.md"}' },
    }],
  }]);
  store.recoverInterruptedWork();
  expect(store.getSession('session-1').status).toBe('interrupted');
  expect(store.getSession('session-1').memoryExtractionStatus).toBe('failed');
  expect(store.loadAgentMessages('session-1').at(-1)).toMatchObject({
    role: 'tool', tool_call_id: 'call-1',
    content: '{"error":"服务中断，工具结果未知"}',
  });
  store.close();
});
```

- [ ] **Step 2: 运行测试并确认 CRUD 缺失**

Run:

```bash
pnpm vitest run tests/persistence.test.ts
```

Expected: FAIL，提示 `createSession`、`beginTurn` 或恢复方法不存在。

- [ ] **Step 3: 增加 CRUD 输入类型**

在 `src/persistence/types.ts` 添加：

```ts
export type SessionQuery = Partial<Pick<StoredSession, 'workspace' | 'clientType'>>;
export type NewDisplayMessage = Omit<StoredDisplayMessage, 'sessionId' | 'sequence'>;
export type SessionPatch = Partial<Pick<StoredSession,
  'title' | 'status' | 'memoryExtractionStatus' | 'memoryExtractionError' | 'updatedAt'
>>;
```

- [ ] **Step 4: 实现事务辅助和会话消息方法**

在 `PersistenceStore` 添加私有事务函数，并实现强类型方法：

```ts
/** 在 IMMEDIATE 事务中执行操作，异常时保证回滚。 */
private transaction<T>(action: () => T): T {
  this.database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    this.database.exec('COMMIT');
    return result;
  } catch (error) {
    this.database.exec('ROLLBACK');
    throw error;
  }
}

createSession(session: StoredSession): void;
getSession(id: string): StoredSession;
listSessions(query?: SessionQuery): StoredSession[];
beginTurn(sessionId: string, display: NewDisplayMessage, agent: ChatCompletionMessageParam): void;
beginDisplayOnlyTurn(sessionId: string, display: NewDisplayMessage): void;
appendAgentMessages(sessionId: string, messages: ChatCompletionMessageParam[]): void;
appendDisplayMessage(sessionId: string, message: NewDisplayMessage, patch: SessionPatch): void;
loadDisplayMessages(sessionId: string): StoredDisplayMessage[];
loadAgentMessages(sessionId: string): ChatCompletionMessageParam[];
updateSession(id: string, patch: SessionPatch): void;
deleteSession(id: string): void;
recoverInterruptedWork(): void;
```

实现约束：

- 所有 SQL 使用 `?` 参数绑定。
- `beginTurn` 在一个事务内插入两类消息、递增 `turns`、设置 `running`。
- sequence 使用同一事务内的 `COALESCE(MAX(sequence), -1) + 1`。
- `loadAgentMessages` 对每条 `payloadJson` 执行 `persistedAgentMessageSchema.parse(JSON.parse(...))`。
- `recoverInterruptedWork` 为每个缺失 `tool_call_id` 追加一条工具错误，并将 `running` 会话改为 `interrupted`。
- `memoryExtractionStatus = running` 在恢复时改为 `failed`，错误为“服务重启，记忆提取未完成”。

- [ ] **Step 5: 运行持久化测试**

Run:

```bash
pnpm vitest run tests/persistence.test.ts
```

Expected: 全部通过。

- [ ] **Step 6: 提交会话存储**

```bash
git add src/persistence tests/persistence.test.ts
git commit -m "feat: persist sessions and model history"
```

## Task 3: 让 AgentLoop 支持历史恢复和动态记忆上下文

**Files:**
- Modify: `src/agent/AgentLoop.ts`
- Modify: `tests/agent.test.ts`

- [ ] **Step 1: 编写恢复、动态上下文和持久化失败测试**

向 `tests/agent.test.ts` 添加：

```ts
it('恢复历史并在每轮请求时动态注入系统上下文', async () => {
  const snapshots: ChatCompletionMessageParam[][] = [];
  let instructions = '第一版记忆';
  const provider = createProvider([
    { content: '', toolCalls: [{ id: '1', name: 'read', arguments: '{}' }] },
    { content: '完成', toolCalls: [] },
  ], snapshots);
  const appended: ChatCompletionMessageParam[] = [];
  const agent = new AgentLoop(provider, createExecutor(async () => {
    instructions = '第二版记忆';
    return 'ok';
  }), {
    systemPrompt: '基础规则',
    maxRounds: 2,
    initialMessages: [{ role: 'user', content: '历史问题' }, { role: 'assistant', content: '历史回答' }],
    getRuntimeInstructions: async () => instructions,
    onMessagesAppended: async (messages) => { appended.push(...messages); },
  });

  await agent.run('继续', createContext(provider));
  expect(snapshots[0].slice(0, 2)).toEqual([
    { role: 'system', content: '基础规则' },
    { role: 'system', content: '第一版记忆' },
  ]);
  expect(snapshots[1][1]).toEqual({ role: 'system', content: '第二版记忆' });
  expect(appended.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
});

it('消息落库回调失败时不调用模型', async () => {
  let calls = 0;
  const provider = createProvider([]);
  provider.chat = async () => { calls++; throw new Error('不应调用'); };
  const agent = new AgentLoop(provider, createExecutor(async () => 'ok'), {
    systemPrompt: '规则',
    maxRounds: 1,
    onMessagesAppended: async () => { throw new Error('数据库写入失败'); },
  });
  await expect(agent.run('任务', createContext(provider))).rejects.toThrow('数据库写入失败');
  expect(calls).toBe(0);
});
```

- [ ] **Step 2: 运行目标测试并确认失败**

Run:

```bash
pnpm vitest run tests/agent.test.ts
```

Expected: FAIL，提示 `initialMessages`、`getRuntimeInstructions` 和 `onMessagesAppended` 不属于 `AgentOptions`。

- [ ] **Step 3: 重构 Agent 历史模型**

将 `AgentOptions` 扩展为：

```ts
interface AgentOptions {
  systemPrompt: string;
  maxRounds: number;
  initialMessages?: ChatCompletionMessageParam[];
  getRuntimeInstructions?: () => Promise<string>;
  onMessagesAppended?: (messages: ChatCompletionMessageParam[]) => Promise<void>;
  sanitize?: (text: string) => string;
  onEvent?: (event: AgentEvent) => void;
}
```

实现两个内部函数：

```ts
/** 先可靠持久化，再更新内存历史，避免模型看到无法恢复的消息。 */
private async appendMessages(messages: ChatCompletionMessageParam[]): Promise<void> {
  await this.options.onMessagesAppended?.(structuredClone(messages));
  this.messages.push(...messages);
}

/** 使用当前系统规则和当前记忆构造一次模型请求。 */
private async requestMessages(): Promise<ChatCompletionMessageParam[]> {
  const runtime = (await this.options.getRuntimeInstructions?.())?.trim();
  return [
    { role: 'system', content: this.options.systemPrompt },
    ...(runtime ? [{ role: 'system' as const, content: runtime }] : []),
    ...structuredClone(this.messages),
  ];
}
```

构造函数只把 `initialMessages` 放入 `this.messages`，不再把系统消息存入会话数组。所有现有 `this.messages.push(...)` 改为 `await this.appendMessages(...)`。取消时缺失工具结果以一个数组批量追加，保证回调可以原子保存。

保留兼容接口：

```ts
/** 返回包含当前基础系统提示词的请求历史副本。 */
getMessages(): ChatCompletionMessageParam[] {
  return [{ role: 'system', content: this.options.systemPrompt }, ...structuredClone(this.messages)];
}

/** 返回不含动态系统消息的可持久化会话历史。 */
getConversationMessages(): ChatCompletionMessageParam[] {
  return structuredClone(this.messages);
}
```

- [ ] **Step 4: 更新原有 clear 和循环保护测试预期**

`clear()` 只清空 `this.messages`。原测试继续断言：

```ts
agent.clear();
expect(agent.getMessages()).toEqual([{ role: 'system', content: '规则' }]);
expect(agent.getConversationMessages()).toEqual([]);
```

将同步 `finish` 改为异步 `finish`，所有调用点使用 `return this.finish(...)`。

- [ ] **Step 5: 运行 Agent 与集成测试**

Run:

```bash
pnpm vitest run tests/agent.test.ts tests/integration.test.ts
pnpm typecheck
```

Expected: 测试通过，现有工具调用和取消配对行为不变。

- [ ] **Step 6: 提交 Agent 历史协议**

```bash
git add src/agent/AgentLoop.ts tests/agent.test.ts
git commit -m "feat: make agent history restorable"
```

## Task 4: 实现项目记忆提取、确认和注入

**Files:**
- Create: `src/memory/types.ts`
- Create: `src/memory/memoryPrompt.ts`
- Create: `src/memory/MemoryService.ts`
- Create: `tests/memory.test.ts`
- Modify: `src/persistence/PersistenceStore.ts`
- Modify: `src/persistence/types.ts`

- [ ] **Step 1: 编写记忆提取和生命周期失败测试**

在 `tests/memory.test.ts` 先建立完整测试夹具：

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { MemoryService } from '../src/memory/MemoryService.js';
import { PersistenceStore } from '../src/persistence/PersistenceStore.js';
import type { ModelProvider } from '../src/providers/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 创建包含一个空闲会话的独立记忆服务。 */
async function setupMemoryTest(reply = '{"candidates":[]}') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new PersistenceStore(path.join(directory, 'agent.db'));
  const now = Date.now();
  store.createSession({
    id: 'session-1', clientType: 'web', workspace: '/repo/a', title: '记忆测试',
    status: 'idle', turns: 1, memoryExtractionStatus: 'idle',
    memoryExtractionError: null, createdAt: now, updatedAt: now,
  });
  const provider: ModelProvider = {
    /** 返回调用方提供的严格 JSON 提取结果。 */
    async chat() { return { content: reply, toolCalls: [] }; },
    /** 记忆测试不调用图片服务。 */
    async generateImage() { throw new Error('不应生成图片'); },
  };
  return {
    store,
    service: new MemoryService(store, provider, (value) => value),
  };
}

/** 使用固定的一轮对话执行记忆提取。 */
function runExtraction(service: MemoryService) {
  return service.extractTurn({
    workspace: '/repo/a',
    sessionId: 'session-1',
    sourceTurn: 1,
    userPrompt: '记住项目约定',
    assistantResponse: '已确认',
    toolResults: [],
    signal: new AbortController().signal,
  });
}
```

然后添加：

```ts
it('提取并保存最多五条经过规范化的候选记忆', async () => {
  const { service, store } = await setupMemoryTest(JSON.stringify({
    candidates: [
      { category: 'decision', content: '  使用 React 19   和原生 CSS。 ' },
      { category: 'rule', content: '函数名使用 camelCase。' },
      { category: 'fact', content: '包管理器是 pnpm。' },
      { category: 'preference', content: '保持最小代码变更。' },
      { category: 'fact', content: '项目使用 TypeScript。' },
    ],
  }));
  const candidates = await runExtraction(service);
  expect(candidates).toHaveLength(5);
  expect(candidates[0].normalizedContent).toBe('使用 react 19 和原生 css。');
  expect(candidates[1].normalizedContent).toBe('函数名使用 camelcase。');
  store.close();
});

it('接受前不注入，接受或编辑后立即进入当前工作区上下文', async () => {
  const { service, store } = await setupMemoryTest(
    '{"candidates":[{"category":"decision","content":"初始记忆"}]}',
  );
  const [candidate] = await runExtraction(service);
  expect(await service.buildRuntimeInstructions('/repo/a')).toBe('');
  await service.resolveCandidate('session-1', candidate.id, {
    action: 'accept', content: '项目使用 SQLite 持久化。',
  });
  expect(await service.buildRuntimeInstructions('/repo/a')).toContain('项目使用 SQLite 持久化。');
  expect(await service.buildRuntimeInstructions('/repo/b')).toBe('');
  store.deleteSession('session-1');
  expect(store.listMemories('/repo/a')).toMatchObject([{
    content: '项目使用 SQLite 持久化。',
    sourceSessionId: null,
  }]);
  store.close();
});

it.each([
  '-----BEGIN PRIVATE KEY-----',
  'Bearer abcdefghijklmnopqrstuvwxyz',
  'sk-abcdefghijklmnopqrstuvwxyz012345',
])('拒绝疑似凭据候选：%s', async (content) => {
  const { service, store } = await setupMemoryTest(
    '{"candidates":[{"category":"fact","content":"普通候选"}]}',
  );
  const [candidate] = await runExtraction(service);
  await expect(service.resolveCandidate('session-1', candidate.id, {
    action: 'accept', content,
  })).rejects.toThrow('敏感信息');
  store.close();
});

it('非法 JSON 不产生部分候选并记录可重试错误', async () => {
  const { service, store } = await setupMemoryTest('{"candidates": [');
  await expect(runExtraction(service)).rejects.toThrow('记忆提取结果格式无效');
  expect(store.listMemoryCandidates('session-1')).toEqual([]);
  expect(store.getSession('session-1').memoryExtractionStatus).toBe('failed');
  store.close();
});
```

- [ ] **Step 2: 运行测试并确认模块缺失**

Run:

```bash
pnpm vitest run tests/memory.test.ts
```

Expected: FAIL，提示无法解析 `MemoryService`。

- [ ] **Step 3: 定义记忆 API 类型**

在 `src/memory/types.ts` 写入：

```ts
import type { MemoryCategory, StoredMemory, StoredMemoryCandidate } from '../persistence/types.js';

export interface MemoryExtractionInput {
  workspace: string;
  sessionId: string;
  sourceTurn: number;
  userPrompt: string;
  assistantResponse: string;
  toolResults: string[];
  signal: AbortSignal;
}

export type CandidateDecision =
  | { action: 'accept'; content?: string }
  | { action: 'ignore' };

export interface MemoryState {
  extractionStatus: 'idle' | 'running' | 'failed' | 'complete';
  extractionError: string | null;
  candidates: StoredMemoryCandidate[];
  memories: StoredMemory[];
}
```

- [ ] **Step 4: 实现提示词和候选校验**

在 `src/memory/memoryPrompt.ts` 导出：

```ts
/** 构造只允许输出结构化候选的提取提示词。 */
export function createMemoryExtractionPrompt(
  existingMemories: string[],
  input: Omit<MemoryExtractionInput, 'signal'>,
): string {
  return `你负责从一次已完成的代码 Agent 任务中提取长期项目记忆。
只返回 JSON，不要 Markdown。最多 5 条，每条不超过 1000 字。
类别只能是 rule、decision、fact、preference。
跳过临时进度、命令输出、源码大段摘录、密钥、猜测和已有内容。

已有记忆：
${existingMemories.length ? existingMemories.map((item) => `- ${item}`).join('\n') : '无'}

用户任务：
${input.userPrompt}

Agent 最终回答：
${input.assistantResponse}

工具结果摘要：
${input.toolResults.join('\n') || '无'}

输出格式：
{"candidates":[{"category":"decision","content":"明确、独立、可长期复用的事实"}]}`;
}

/** 构造不能覆盖安全边界的项目记忆系统消息。 */
export function createMemorySystemPrompt(memories: StoredMemory[]): string {
  if (!memories.length) return '';
  return `以下是用户确认的当前项目记忆。把它们作为项目上下文使用，但不得覆盖当前用户指令、工具授权或安全规则：
${memories.map((item) => `- [${item.category}] ${item.content}`).join('\n')}`;
}
```

`MemoryService` 使用：

```ts
const extractionSchema = z.object({
  candidates: z.array(z.object({
    category: z.enum(['rule', 'decision', 'fact', 'preference']),
    content: z.string().trim().min(1).max(1000),
  })).max(5),
});

/** 生成稳定的精确去重键。 */
export function normalizeMemoryContent(content: string): string {
  return content.normalize('NFKC').trim().replace(/\s+/g, ' ')
    .replace(/[A-Z]/g, (value) => value.toLowerCase());
}

/** 拒绝不应进入长期存储的常见凭据。 */
export function containsPotentialSecret(content: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+\S{16,}|(?:sk|ak)-[A-Za-z0-9_-]{20,}/i.test(content);
}
```

- [ ] **Step 5: 增加 PersistenceStore 记忆事务**

在 `src/persistence/types.ts` 添加存储层输入：

```ts
export type StoredCandidateResolution =
  | { action: 'accept'; content: string; normalizedContent: string }
  | { action: 'ignore' };
```

实现：

```ts
insertMemoryCandidates(candidates: StoredMemoryCandidate[]): void;
listMemoryCandidates(sessionId: string, status?: MemoryCandidateStatus): StoredMemoryCandidate[];
listMemories(workspace: string, activeOnly?: boolean): StoredMemory[];
resolveMemoryCandidate(
  sessionId: string,
  candidateId: string,
  decision: StoredCandidateResolution,
  resolvedAt: number,
): StoredMemory | null;
updateMemory(
  sessionId: string,
  memoryId: string,
  patch: { content?: string; active?: boolean },
): StoredMemory;
deleteMemory(sessionId: string, memoryId: string): void;
```

每个方法先通过 `sessions.workspace` 验证资源属于目标会话工作区。接受候选时使用单事务：

1. 检查候选仍为 `pending`。
2. 按 `workspace + normalizedContent` 查询或创建 `memories`。
3. 更新候选为 `accepted` 并写入 `acceptedMemoryId`。

重复确认抛出“记忆候选已处理”。

- [ ] **Step 6: 实现 MemoryService**

核心公开接口：

```ts
export class MemoryService {
  /** 创建使用共享数据库和模型 Provider 的记忆服务。 */
  constructor(
    private readonly store: PersistenceStore,
    private readonly provider: ModelProvider,
    private readonly sanitize: (text: string) => string,
  ) {}

  /** 提取、严格校验并持久化本轮候选。 */
  async extractTurn(input: MemoryExtractionInput): Promise<StoredMemoryCandidate[]>;

  /** 返回当前工作区不超过 50 条和 12 KiB 的动态系统上下文。 */
  async buildRuntimeInstructions(workspace: string): Promise<string>;

  /** 接受、编辑后接受或忽略候选。 */
  async resolveCandidate(
    sessionId: string,
    candidateId: string,
    decision: CandidateDecision,
  ): Promise<StoredMemory | null>;

  /** 返回会话工作区的候选、正式记忆和提取状态。 */
  getState(sessionId: string): MemoryState;

  /** 编辑、停用或恢复正式记忆。 */
  updateMemory(sessionId: string, memoryId: string, patch: { content?: string; active?: boolean }): StoredMemory;

  /** 删除正式记忆。 */
  deleteMemory(sessionId: string, memoryId: string): void;
}
```

`extractTurn` 调用：

```ts
const reply = await this.provider.chat(
  [{ role: 'system', content: prompt }],
  [],
  () => {},
  input.signal,
);
const parsed = extractionSchema.parse(JSON.parse(reply.content));
```

开始前把会话提取状态设为 `running`；全部候选成功写入后设为 `complete`；任何解析或写入错误都设为 `failed`，并保存脱敏后的短错误。

`buildRuntimeInstructions` 按 `updatedAt DESC` 遍历有效记忆，达到 50 条或加入下一条会超过 `12 * 1024` UTF-8 字节时停止。

- [ ] **Step 7: 运行记忆和持久化测试**

Run:

```bash
pnpm vitest run tests/memory.test.ts tests/persistence.test.ts
pnpm typecheck
```

Expected: 全部通过。

- [ ] **Step 8: 提交记忆核心**

```bash
git add src/memory src/persistence tests/memory.test.ts tests/persistence.test.ts
git commit -m "feat: add confirmed project memory service"
```

## Task 5: 增加 Web/CLI 共享 SessionService

**Files:**
- Create: `src/sessions/types.ts`
- Create: `src/sessions/SessionService.ts`
- Create: `tests/sessionService.test.ts`

- [ ] **Step 1: 编写共享会话服务失败测试**

在 `tests/sessionService.test.ts` 建立以下夹具：

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/loadConfig.js';
import { MemoryService } from '../src/memory/MemoryService.js';
import { PersistenceStore } from '../src/persistence/PersistenceStore.js';
import type { ChatReply, ModelProvider } from '../src/providers/types.js';
import { SessionService } from '../src/sessions/SessionService.js';
import type { ToolExecutor } from '../src/agent/AgentLoop.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 创建可区分主任务和记忆提取请求的测试 Provider。 */
function createSessionProvider(
  onTask: ModelProvider['chat'],
): ModelProvider {
  return {
    async chat(messages, tools, onText, signal) {
      if (String(messages[0]?.content).includes('提取长期项目记忆')) {
        return { content: '{"candidates":[]}', toolCalls: [] };
      }
      return onTask(messages, tools, onText, signal);
    },
    async generateImage() { return Buffer.from('image'); },
  };
}

/** 创建真实临时数据库、工作区和共享服务。 */
async function setupSessionTest(provider: ModelProvider, tools: ToolExecutor) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-session-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({
    apiKey: 'test-key',
    workspace: directory,
    databasePath: path.join(directory, 'agent.db'),
  }, {});
  const store = new PersistenceStore(config.databasePath);
  cleanups.push(async () => store.close());
  const memoryService = new MemoryService(store, provider, (value) => value);
  const service = new SessionService(config, provider, tools, store, memoryService, (value) => value);
  const sessionId = await service.create('web', directory);
  const hooks = {
    onAgentEvent: () => {},
    onDisplayMessage: () => {},
    onStatus: () => {},
    confirm: async () => true,
  };
  return { store, service, memoryService, sessionId, hooks };
}
```

然后添加完整用例：

```ts
it('先持久化用户消息再调用模型，并在完成后启动记忆提取', async () => {
  const order: string[] = [];
  const provider = createSessionProvider(async (messages) => {
    order.push('model');
    expect(store.loadDisplayMessages(sessionId)).toHaveLength(1);
    expect(store.loadAgentMessages(sessionId).at(-1)).toEqual({ role: 'user', content: '任务' });
    return { content: '完成', toolCalls: [] };
  });
  const tools: ToolExecutor = { getDefinitions: () => [], execute: async () => 'ok' };
  const { store, service, sessionId, hooks } = await setupSessionTest(provider, tools);
  const beginTurn = store.beginTurn.bind(store);
  vi.spyOn(store, 'beginTurn').mockImplementation((...args) => {
    order.push('persist');
    beginTurn(...args);
  });
  const result = await service.run(sessionId, '任务', hooks, new AbortController().signal);
  expect(result.content).toBe('完成');
  expect(order[0]).toBe('persist');
  await expect(result.memoryExtraction).resolves.toEqual([]);
});

it('工具声明在执行前落库，工具结果写入失败时不请求下一轮', async () => {
  const order: string[] = [];
  let providerCallCount = 0;
  const provider = createSessionProvider(async () => {
    providerCallCount++;
    return {
      content: '',
      toolCalls: [{ id: 'call-1', name: 'testTool', arguments: '{}' }],
    };
  });
  const tools: ToolExecutor = {
    getDefinitions: () => [],
    execute: async () => { order.push('execute-tool'); return 'done'; },
  };
  const { store, service, sessionId, hooks } = await setupSessionTest(provider, tools);
  const append = store.appendAgentMessages.bind(store);
  let appendCount = 0;
  vi.spyOn(store, 'appendAgentMessages').mockImplementation((id, messages) => {
    appendCount++;
    order.push(appendCount === 1 ? 'persist-assistant' : 'persist-tool');
    if (appendCount === 2) throw new Error('数据库写入失败');
    append(id, messages);
  });
  await expect(service.run(
    sessionId, '任务', hooks, new AbortController().signal,
  )).rejects.toThrow('数据库写入失败');
  expect(order).toEqual(['persist-assistant', 'execute-tool', 'persist-tool']);
  expect(providerCallCount).toBe(1);
});

it('图片任务只写显示消息且不触发记忆提取', async () => {
  const provider = createSessionProvider(async () => {
    throw new Error('图片任务不应调用聊天接口');
  });
  const tools: ToolExecutor = {
    getDefinitions: () => [],
    execute: async (name) => ({ path: name === 'generateImage' ? 'generated/test.png' : '' }),
  };
  const { store, service, sessionId, hooks } = await setupSessionTest(provider, tools);
  const result = await service.run(
    sessionId, '/image test', hooks, new AbortController().signal,
  );
  expect(store.loadAgentMessages(sessionId)).toEqual([]);
  expect(result.memoryExtraction).toBeNull();
});
```

- [ ] **Step 2: 运行测试并确认 SessionService 不存在**

Run:

```bash
pnpm vitest run tests/sessionService.test.ts
```

Expected: FAIL，提示无法解析 `src/sessions/SessionService.ts`。

- [ ] **Step 3: 定义共享会话接口**

在 `src/sessions/types.ts` 写入：

```ts
import type { AgentEvent } from '../agent/AgentLoop.js';
import type { StoredDisplayMessage, StoredMemoryCandidate, StoredSession } from '../persistence/types.js';
import type { PermissionRequest } from '../tools/types.js';

export type SessionSummary = StoredSession;

export interface SessionDetail extends StoredSession {
  messages: StoredDisplayMessage[];
}

export interface SessionRunHooks {
  onAgentEvent: (event: AgentEvent) => void;
  onDisplayMessage: (message: StoredDisplayMessage) => void;
  onStatus: (status: StoredSession['status']) => void;
  confirm: (request: PermissionRequest, signal: AbortSignal) => Promise<boolean>;
}

export interface SessionRunResult {
  content: string;
  memoryExtraction: Promise<StoredMemoryCandidate[]> | null;
}
```

- [ ] **Step 4: 实现 SessionService**

构造函数依赖：

```ts
export class SessionService {
  private readonly running = new Set<string>();
  private readonly extractionTasks = new Set<Promise<unknown>>();

  constructor(
    private readonly config: AgentConfig,
    private readonly provider: ModelProvider,
    private readonly tools: ToolExecutor,
    private readonly persistence: PersistenceStore,
    private readonly memories: MemoryService,
    private readonly sanitize: (text: string) => string,
  ) {}
}
```

公开接口：

```ts
create(clientType: SessionClientType, workspace: string): Promise<string>;
list(query?: SessionQuery): SessionSummary[];
load(id: string): SessionDetail;
run(id: string, prompt: string, hooks: SessionRunHooks, signal: AbortSignal): Promise<SessionRunResult>;
remove(id: string): void;
retryMemoryExtraction(id: string, signal: AbortSignal): Promise<StoredMemoryCandidate[]>;
close(): Promise<void>;
```

`run` 的普通任务路径：

```ts
/** 复制并脱敏会写入 SQLite 的模型消息。 */
function sanitizeAgentMessage(
  message: ChatCompletionMessageParam,
  sanitize: (text: string) => string,
): ChatCompletionMessageParam {
  const copy = structuredClone(message);
  if ('content' in copy && typeof copy.content === 'string') copy.content = sanitize(copy.content);
  if (copy.role === 'assistant' && copy.tool_calls) {
    for (const call of copy.tool_calls) call.function.arguments = sanitize(call.function.arguments);
  }
  return copy;
}

const history = this.persistence.loadAgentMessages(id);
const now = Date.now();
const displayUserMessage = {
  id: randomUUID(),
  role: 'user' as const,
  content: this.sanitize(prompt),
  createdAt: now,
};
let firstAppend = true;
const agent = new AgentLoop(this.provider, this.tools, {
  systemPrompt: redactSecrets(createSystemPrompt(session.workspace, projectContext), [this.config.apiKey]),
  maxRounds: this.config.maxRounds,
  initialMessages: history,
  sanitize: this.sanitize,
  getRuntimeInstructions: () => this.memories.buildRuntimeInstructions(session.workspace),
  onEvent: hooks.onAgentEvent,
  onMessagesAppended: async (messages) => {
    if (firstAppend) {
      firstAppend = false;
      const user = messages[0];
      if (messages.length !== 1 || user?.role !== 'user' || typeof user.content !== 'string') {
        throw new Error('会话首条模型消息必须是用户文本');
      }
      this.persistence.beginTurn(id, displayUserMessage, sanitizeAgentMessage(user, this.sanitize));
      hooks.onDisplayMessage(this.persistence.loadDisplayMessages(id).at(-1)!);
      return;
    }
    this.persistence.appendAgentMessages(
      id,
      messages.map((message) => sanitizeAgentMessage(message, this.sanitize)),
    );
  },
});
const content = await agent.run(prompt, toolContext);
```

完成后追加脱敏的 assistant 显示消息并设置 `idle`。异常或取消时追加 notice，状态分别设为 `failed` 或 `interrupted`。成功的普通任务创建独立 `AbortController` 启动 `MemoryService.extractTurn`，把 Promise 加入 `extractionTasks` 并在 settled 后移除。

`create` 必须执行 `realpath` 和目录 `stat`，不保留原有 20 会话限制。

- [ ] **Step 5: 运行共享服务测试**

Run:

```bash
pnpm vitest run tests/sessionService.test.ts tests/agent.test.ts tests/memory.test.ts
pnpm typecheck
```

Expected: 全部通过。

- [ ] **Step 6: 提交共享会话服务**

```bash
git add src/sessions tests/sessionService.test.ts
git commit -m "feat: add shared persistent session service"
```

## Task 6: 将 Web 会话改为持久化摘要与按需详情

**Files:**
- Modify: `src/web/types.ts`
- Modify: `src/web/sessions.ts`
- Modify: `src/web/server.ts`
- Modify: `src/web/api.ts`
- Modify: `src/web/Workbench.tsx`
- Modify: `src/web/main.ts`
- Modify: `tests/web.test.ts`

- [ ] **Step 1: 编写 Web 重启恢复和按需详情失败测试**

调整 `tests/web.test.ts` 的 `setup` 接收可复用 `databasePath`，添加：

```ts
it('服务重启后只在摘要列表返回元数据并按需恢复会话详情', async () => {
  const databasePath = await createDatabasePath();
  const first = await setup(textProvider, databasePath);
  const { id } = await (await first.request('/api/sessions', {})).json();
  await first.request(`/api/sessions/${id}/message`, { prompt: 'persist me' });
  await waitForState(first.request, (state) =>
    state.sessions.find((item: any) => item.id === id)?.status === 'idle');
  await first.server.close();

  const second = await setup(textProvider, databasePath, first.workspace);
  const state = await (await second.request('/api/state')).json();
  expect(state.sessions.find((item: any) => item.id === id)).not.toHaveProperty('messages');
  const detail = await (await second.request(`/api/sessions/${id}`)).json();
  expect(detail.messages.map((message: any) => message.role)).toEqual(['user', 'assistant']);
});
```

同步修改原测试：列表断言使用摘要，消息断言通过 `GET /api/sessions/:id` 获取详情。

- [ ] **Step 2: 运行 Web 测试并确认失败**

Run:

```bash
pnpm vitest run tests/web.test.ts
```

Expected: FAIL，因为 `startWebServer` 不接收数据库路径，且详情 GET 路由不存在。

- [ ] **Step 3: 拆分 Web 摘要与详情类型**

在 `src/web/types.ts` 定义：

```ts
export interface WebSessionSummary {
  id: string;
  title: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  busy: boolean;
  status: string;
  startedAt: number | null;
  pendingMemoryCount: number;
  memoryExtractionStatus: 'idle' | 'running' | 'failed' | 'complete';
}

export interface WebSession extends WebSessionSummary {
  messages: WebMessage[];
  response: string;
  tools: WebTool[];
  permission: WebPermission | null;
}

export interface WebState {
  model: string;
  imageModel: string;
  workspace: string;
  sessions: WebSessionSummary[];
}

export type WebEvent =
  | { type: 'state'; state: WebState }
  | { type: 'sessionSummary'; session: WebSessionSummary }
  | { type: 'sessionDetail'; session: WebSession };
```

- [ ] **Step 4: 将 Web SessionStore 改为 SessionService 适配层**

保留 `src/web/sessions.ts` 中的流式响应、工具活动和权限 UI 状态，但：

- 构造函数接收 `SessionService` 和 `MemoryService`。
- `create`、`remove`、最终显示消息和模型执行全部委托给 `SessionService`。
- 内存 Map 只保存当前进程已打开或运行中的 `WebSession`。
- `snapshot()` 从数据库摘要生成 `WebState`。
- `getSessionSnapshot(id)` 首次访问时从 `SessionService.load(id)` 恢复显示消息。
- 进程启动调用 `persistence.recoverInterruptedWork()`。

运行 Hook 映射：

```ts
const hooks: SessionRunHooks = {
  onAgentEvent: (event) => this.handleEvent(view, event),
  onDisplayMessage: (message) => {
    view.messages.push(toWebMessage(message));
    this.onChange(view.id);
  },
  onStatus: () => this.onChange(view.id),
  confirm: (request, signal) => record.gate.request(request, signal),
};
```

- [ ] **Step 5: 接入数据库生命周期和详情路由**

`ServerOptions` 增加：

```ts
databasePath?: string;
```

`startWebServer` 创建：

```ts
const persistence = new PersistenceStore(options.databasePath ?? options.config.databasePath);
const provider = options.provider ?? new AidpProvider(options.config);
const memories = new MemoryService(persistence, provider, (text) =>
  redactSecrets(text, [options.config.apiKey]));
const sessions = new SessionService(
  options.config, provider, new ToolRegistry(), persistence, memories,
  (text) => redactSecrets(text, [options.config.apiKey]),
);
const store = new SessionStore(options.config, sessions, memories, broadcast);
```

在通用 session 路由处理 `GET /api/sessions/:id`，返回 `store.getSessionSnapshot(id)`。`close()` 最后调用 `persistence.close()`。

`src/web/main.ts` 增加 `--database-path` 参数，并传入 `loadConfig`。

- [ ] **Step 6: 更新 SSE 客户端和 Workbench 按需加载**

`subscribe` 改为：

```ts
export function subscribe(
  onState: (state: WebState) => void,
  onSession: (session: WebSession) => void,
  onConnection: (connected: boolean, error?: string) => void,
): () => void;
```

`Workbench` 增加：

```ts
const [active, setActive] = useState<WebSession | undefined>();

useEffect(() => {
  if (!activeId) { setActive(undefined); return; }
  let stale = false;
  void api<WebSession>(`/api/sessions/${activeId}`).then((session) => {
    if (!stale) setActive(session);
  }).catch((error) => {
    if (!stale) setActionError(error instanceof Error ? error.message : '加载会话失败');
  });
  return () => { stale = true; };
}, [activeId]);
```

SSE `sessionDetail` 只在 ID 等于 `activeId` 时替换 `active`；`sessionSummary` 更新列表摘要。创建和提交后不再依赖全量 `/api/state` 携带消息。

- [ ] **Step 7: 运行 Web 回归**

Run:

```bash
pnpm vitest run tests/web.test.ts tests/sessionService.test.ts
pnpm typecheck
pnpm build:web
```

Expected: Web API 测试通过，浏览器包构建成功。

- [ ] **Step 8: 提交 Web 持久化**

```bash
git add src/web tests/web.test.ts
git commit -m "feat: restore persisted web sessions"
```

## Task 7: 增加 Web 记忆 API 与管理面板

**Files:**
- Create: `src/web/MemoryPanel.tsx`
- Modify: `src/web/types.ts`
- Modify: `src/web/server.ts`
- Modify: `src/web/Inspector.tsx`
- Modify: `src/web/Workbench.tsx`
- Modify: `src/web/components.tsx`
- Modify: `src/web/styles.css`
- Modify: `tests/web.test.ts`

- [ ] **Step 1: 编写记忆 API 失败测试**

向 `tests/web.test.ts` 添加：

```ts
it('通过会话作用域接口确认、编辑、停用和删除记忆', async () => {
  const { request } = await setup(memoryProvider);
  const { id } = await (await request('/api/sessions', {})).json();
  await request(`/api/sessions/${id}/message`, { prompt: '记住使用 SQLite' });
  await waitForState(request, (state) =>
    state.sessions.find((item: any) => item.id === id)?.memoryExtractionStatus === 'complete');

  let memoryState = await (await request(`/api/sessions/${id}/memories`)).json();
  const candidateId = memoryState.candidates[0].id;
  await request(`/api/sessions/${id}/memory-candidates/${candidateId}`, {
    action: 'accept', content: '项目使用 SQLite。',
  }, 'PATCH');
  memoryState = await (await request(`/api/sessions/${id}/memories`)).json();
  expect(memoryState.memories[0].content).toBe('项目使用 SQLite。');

  const memoryId = memoryState.memories[0].id;
  await request(`/api/sessions/${id}/memories/${memoryId}`, { active: false }, 'PATCH');
  expect((await (await request(`/api/sessions/${id}/memories`)).json()).memories[0].active).toBe(false);
  await request(`/api/sessions/${id}/memories/${memoryId}`, undefined, 'DELETE');
  expect((await (await request(`/api/sessions/${id}/memories`)).json()).memories).toEqual([]);
});

it('拒绝通过其他工作区会话操作记忆', async () => {
  const response = await request(
    `/api/sessions/${otherSessionId}/memories/${memoryId}`,
    { active: false },
    'PATCH',
  );
  expect(response.status).toBe(400);
});
```

- [ ] **Step 2: 运行 Web 测试并确认路由不存在**

Run:

```bash
pnpm vitest run tests/web.test.ts
```

Expected: FAIL，记忆接口返回 404。

- [ ] **Step 3: 增加 Zod 路由和 SessionStore 委托**

在 `src/web/server.ts` 定义：

```ts
const candidateDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), content: z.string().trim().min(1).max(1000).optional() }),
  z.object({ action: z.literal('ignore') }),
]);
const memoryPatchSchema = z.object({
  content: z.string().trim().min(1).max(1000).optional(),
  active: z.boolean().optional(),
}).refine((value) => value.content !== undefined || value.active !== undefined);
```

严格匹配以下路由，不允许自由拼接资源 ID：

```text
GET    /api/sessions/:sessionId/memories
POST   /api/sessions/:sessionId/memory-extraction/retry
PATCH  /api/sessions/:sessionId/memory-candidates/:candidateId
PATCH  /api/sessions/:sessionId/memories/:memoryId
DELETE /api/sessions/:sessionId/memories/:memoryId
```

每次写入成功后广播对应会话摘要和详情。

- [ ] **Step 4: 定义 Web 记忆类型并创建 MemoryPanel**

在 `src/web/types.ts` 添加：

```ts
export interface WebMemoryCandidate {
  id: string;
  category: 'rule' | 'decision' | 'fact' | 'preference';
  content: string;
  createdAt: number;
}

export interface WebMemory {
  id: string;
  category: WebMemoryCandidate['category'];
  content: string;
  active: boolean;
  updatedAt: number;
}

export interface WebMemoryState {
  extractionStatus: 'idle' | 'running' | 'failed' | 'complete';
  extractionError: string | null;
  candidates: WebMemoryCandidate[];
  memories: WebMemory[];
}
```

`MemoryPanel` Props：

```ts
export function MemoryPanel({ sessionId }: { sessionId?: string })
```

组件行为：

- `sessionId` 变化时请求 `/memories`。
- 候选接受使用默认内容，编辑后接受先切换为 `<textarea>`。
- 忽略、停用、恢复和删除均通过 `perform` 串行执行。
- 删除正式记忆前调用 `window.confirm`。
- 所有按钮使用现有 `Icon`；增加 `memory`、`edit`、`pause` 图标路径。
- 空状态只说明当前没有已确认记忆，不加入功能说明卡片。

- [ ] **Step 5: 将记忆标签接入 Inspector**

修改标签联合类型：

```ts
const [tab, setTab] = useState<'activity' | 'files' | 'diff' | 'memory'>('activity');
```

标签配置：

```ts
[
  ['activity', '活动'],
  ['files', '文件'],
  ['diff', '变更'],
  ['memory', '记忆'],
]
```

`memory` 分支直接渲染：

```tsx
<MemoryPanel sessionId={session?.id} />
```

`useEffect` 中只有 `files` 和 `diff` 调用 `inspect`，避免把 `memory` 误传给只读文件接口。

- [ ] **Step 6: 增加克制的记忆样式**

在 `src/web/styles.css` 添加独立、非嵌套卡片样式：

```css
.memory-panel { overflow-y: auto; flex: 1; padding: 14px; }
.memory-section { padding: 4px 0 16px; border-bottom: 1px solid #edf0e6; }
.memory-section:last-child { border-bottom: 0; }
.memory-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; font-size: 10px; color: #8b987e; }
.memory-row { padding: 11px 0; border-bottom: 1px solid #f0f2ec; }
.memory-row:last-child { border-bottom: 0; }
.memory-row p { margin: 6px 0 9px; color: #59644f; font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
.memory-category { color: #849871; font-size: 9px; text-transform: uppercase; }
.memory-actions { display: flex; gap: 7px; justify-content: flex-end; }
.memory-editor { width: 100%; min-height: 86px; resize: vertical; border: 1px solid #dfe7d5; border-radius: 6px; padding: 9px; color: #56634c; background: #fff; }
.memory-row.inactive { opacity: .58; }
```

在 760px 媒体查询中保证 `.memory-actions` 可换行，按钮文本不溢出。

- [ ] **Step 7: 运行 API、类型和构建验证**

Run:

```bash
pnpm vitest run tests/web.test.ts tests/memory.test.ts
pnpm typecheck
pnpm build:web
```

Expected: 全部通过。

- [ ] **Step 8: 提交 Web 记忆界面**

```bash
git add src/web tests/web.test.ts
git commit -m "feat: manage project memories in workbench"
```

## Task 8: 为 CLI 增加持久化会话和恢复命令

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/ui/App.tsx`
- Modify: `tests/ui.test.tsx`

- [ ] **Step 1: 编写 CLI 恢复和会话命令失败测试**

将 `tests/ui.test.tsx` 的 `afterEach(cleanup)` 扩展为同时清理临时目录和数据库，并增加：

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryService } from '../src/memory/MemoryService.js';
import { PersistenceStore } from '../src/persistence/PersistenceStore.js';
import { SessionService } from '../src/sessions/SessionService.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  cleanup();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});

/** 创建 CLI 使用的真实临时会话服务。 */
async function setupCliTest() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-cli-ui-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({
    apiKey: 'test-key',
    workspace: directory,
    databasePath: path.join(directory, 'agent.db'),
  }, {});
  const provider = createProvider();
  const store = new PersistenceStore(config.databasePath);
  const memoryService = new MemoryService(store, provider, (value) => value);
  const sessionService = new SessionService(
    config,
    provider,
    { getDefinitions: () => [], execute: async () => 'ok' },
    store,
    memoryService,
    (value) => value,
  );
  cleanups.push(async () => {
    await sessionService.close();
    store.close();
  });
  return { config, store, memoryService, sessionService };
}

/** 向持久化会话写入一轮已完成对话。 */
async function runCompletedTurn(
  sessionService: SessionService,
  sessionId: string,
  prompt: string,
): Promise<void> {
  const result = await sessionService.run(sessionId, prompt, {
    onAgentEvent: () => {},
    onDisplayMessage: () => {},
    onStatus: () => {},
    confirm: async () => true,
  }, new AbortController().signal);
  await result.memoryExtraction;
}
```

添加：

```ts
it('启动恢复最近 CLI 会话并通过 clear 创建新会话', async () => {
  const { config, sessionService, memoryService } = await setupCliTest();
  const firstId = await sessionService.create('cli', config.workspace);
  await runCompletedTurn(sessionService, firstId, '旧问题');
  const view = render(<App config={config} sessionService={sessionService} memoryService={memoryService} />);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('已恢复'));
  expect(view.lastFrame()).toContain('旧问题');
  await submit(view, '/clear');
  await vi.waitFor(() => expect(view.lastFrame()).not.toContain('旧问题'));
  expect(sessionService.list({ workspace: config.workspace, clientType: 'cli' })).toHaveLength(2);
});

it('列出、恢复和删除空闲 CLI 会话', async () => {
  const { config, sessionService, memoryService } = await setupCliTest();
  const firstId = await sessionService.create('cli', config.workspace);
  const secondId = await sessionService.create('cli', config.workspace);
  const view = render(<App config={config} sessionService={sessionService} memoryService={memoryService} />);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('Agent CLI'));
  await submit(view, '/sessions');
  await vi.waitFor(() => expect(view.lastFrame()).toContain(firstId.slice(0, 8)));
  await submit(view, `/resume ${firstId}`);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('已恢复会话'));
  await submit(view, `/delete-session ${secondId}`);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('已删除会话'));
});
```

- [ ] **Step 2: 运行 CLI 测试并确认 Props 不匹配**

Run:

```bash
pnpm vitest run tests/ui.test.tsx
```

Expected: FAIL，`App` 尚不接收共享服务。

- [ ] **Step 3: 在 CLI 入口创建共享服务**

`src/main.tsx` 增加 `--database-path`，然后创建：

```ts
const persistence = new PersistenceStore(config.databasePath);
persistence.recoverInterruptedWork();
const provider = new AidpProvider(config);
const memories = new MemoryService(
  persistence,
  provider,
  (text) => redactSecrets(text, [config.apiKey]),
);
const sessions = new SessionService(
  config,
  provider,
  new ToolRegistry(),
  persistence,
  memories,
  (text) => redactSecrets(text, [config.apiKey]),
);
```

把 `sessions` 和 `memories` 传给 `App`。`waitUntilExit()` 后在 `finally` 中执行：

```ts
await sessions.close();
persistence.close();
```

- [ ] **Step 4: 将 App 改为会话服务客户端**

新 Props：

```ts
interface AppProps {
  config: AgentConfig;
  sessionService: SessionService;
  memoryService: MemoryService;
}
```

挂载时：

1. 查询当前工作区 `clientType: 'cli'` 的最近会话。
2. 存在则加载详情和消息；不存在则创建。
3. 初始化完成前显示“正在恢复会话”。

普通任务调用：

```ts
const result = await sessionService.run(sessionId, prompt, {
  onAgentEvent,
  onDisplayMessage: appendStoredMessage,
  onStatus: (nextStatus) => setStatus(statusLabel(nextStatus)),
  confirm: (request, signal) => gate.request(request, signal),
}, controller.signal);
```

命令解析必须先于普通提交：

```ts
if (prompt === '/new' || prompt === '/clear') await createNewSession();
else if (prompt === '/sessions') showSessions();
else if (prompt.startsWith('/resume ')) await resumeSession(prompt.slice(8).trim());
else if (prompt.startsWith('/delete-session ')) deleteSession(prompt.slice(16).trim());
else if (prompt === '/memory') openMemoryManager();
else runTask(prompt);
```

ID 支持完整 UUID 或当前工作区内唯一的 8 位前缀；前缀不唯一时拒绝操作。

- [ ] **Step 5: 更新帮助文本**

```ts
const helpText = [
  '/help 帮助 · /new 新会话 · /clear 新会话 · /exit 退出',
  '/sessions 列出会话 · /resume <id> 恢复 · /delete-session <id> 删除',
  '/memory 管理项目记忆 · /image <提示词> 生成图片',
  '写文件、执行命令和图片生成均需确认；Ctrl+C 中断，再按退出。',
].join('\n');
```

- [ ] **Step 6: 运行 CLI 回归**

Run:

```bash
pnpm vitest run tests/ui.test.tsx tests/permissionUi.test.tsx tests/sessionService.test.ts
pnpm typecheck
```

Expected: 全部通过。

- [ ] **Step 7: 提交 CLI 会话恢复**

```bash
git add src/main.tsx src/ui/App.tsx tests/ui.test.tsx
git commit -m "feat: restore persistent cli sessions"
```

## Task 9: 为 CLI 增加候选确认和记忆管理

**Files:**
- Create: `src/ui/MemoryPrompt.tsx`
- Modify: `src/ui/App.tsx`
- Modify: `tests/ui.test.tsx`

- [ ] **Step 1: 编写 CLI 候选确认失败测试**

向 `tests/ui.test.tsx` 添加：

```ts
it('任务完成后逐条接受、编辑或忽略候选记忆', async () => {
  await submit(view, '记住项目约定');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('候选记忆 1/3'));
  view.stdin.write('a');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('候选记忆 2/3'));
  view.stdin.write('e');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('编辑记忆'));
  view.stdin.write('修改后的记忆');
  view.stdin.write('\r');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('候选记忆 3/3'));
  view.stdin.write('i');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('已处理 3 条候选记忆'));
  expect(memoryService.getState(sessionId).memories.map((item) => item.content)).toContain('修改后的记忆');
});

it('memory 命令展示正式记忆并支持停用', async () => {
  await submit(view, '/memory');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('项目记忆'));
  view.stdin.write('1');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('已停用'));
});
```

- [ ] **Step 2: 运行测试并确认 MemoryPrompt 缺失**

Run:

```bash
pnpm vitest run tests/ui.test.tsx
```

Expected: FAIL，候选确认界面不存在。

- [ ] **Step 3: 创建 MemoryPrompt**

组件 Props：

```ts
interface MemoryPromptProps {
  candidates: StoredMemoryCandidate[];
  onAccept: (candidateId: string, content?: string) => Promise<void>;
  onIgnore: (candidateId: string) => Promise<void>;
  onDone: () => void;
}
```

状态：

```ts
const [index, setIndex] = useState(0);
const [mode, setMode] = useState<'choose' | 'edit'>('choose');
const [draft, setDraft] = useState(candidates[0]?.content ?? '');
const [error, setError] = useState('');
const [pending, setPending] = useState(false);
```

交互：

- choose 模式按 `a` 接受、`e` 编辑、`i` 忽略。
- edit 模式使用 `TextInput`，Enter 提交编辑内容，Esc 返回选择。
- 每次操作成功后移动到下一条；结束调用 `onDone`。
- 操作期间禁用重复输入，错误显示脱敏后的单行文本。

渲染保持 24 行内，长内容使用现有 `wrap-ansi` 截断预览，不新增装饰性容器。

- [ ] **Step 4: App 等待提取并进入候选状态**

任务主回答完成后先恢复输入和显示消息，再等待 `result.memoryExtraction`：

```ts
const candidates = await result.memoryExtraction?.catch((error) => {
  setMessages((items) => [...items, {
    role: '提示',
    content: `记忆提取失败：${sanitize(error instanceof Error ? error.message : String(error))}`,
  }]);
  return [];
});
if (candidates?.length) setMemoryCandidates(candidates);
```

存在 `memoryCandidates` 时优先渲染 `MemoryPrompt`，但不把它接入写文件的 `PermissionGate`。

`/memory` 首期使用编号选择一条正式记忆，再用 `e` 编辑、`t` 停用或恢复、`d` 删除、Esc 返回。所有操作调用 `MemoryService`，不在组件内直接访问数据库。

- [ ] **Step 5: 运行 CLI 与记忆测试**

Run:

```bash
pnpm vitest run tests/ui.test.tsx tests/memory.test.ts
pnpm typecheck
```

Expected: 全部通过。

- [ ] **Step 6: 提交 CLI 记忆交互**

```bash
git add src/ui tests/ui.test.tsx
git commit -m "feat: confirm project memories in cli"
```

## Task 10: 完成恢复、安全、文档和端到端验收

**Files:**
- Modify: `tests/web.test.ts`
- Modify: `tests/integration.test.ts`
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: 增加完整重启与记忆注入集成测试**

向 `tests/integration.test.ts` 增加导入和共享 Hook：

```ts
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { redactSecrets } from '../src/config/loadConfig.js';
import { MemoryService } from '../src/memory/MemoryService.js';
import { PersistenceStore } from '../src/persistence/PersistenceStore.js';
import type { ModelProvider } from '../src/providers/types.js';
import { SessionService } from '../src/sessions/SessionService.js';

/** 创建无 UI 副作用且默认批准工具的会话 Hook。 */
function createSessionHooks() {
  return {
    onAgentEvent: () => {},
    onDisplayMessage: () => {},
    onStatus: () => {},
    confirm: async () => true,
  };
}
```

添加完整重启测试：

```ts
it('跨进程式重开数据库后恢复会话并只注入已确认记忆', async () => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-memory-integration-')));
  const databasePath = path.join(workspace, 'agent.db');
  const config = loadConfig({ apiKey: 'integration-key', workspace, databasePath }, {});
  const providerSnapshots: ChatCompletionMessageParam[][] = [];
  let taskCalls = 0;
  const provider: ModelProvider = {
    /** 为主任务返回文本，为记忆提取返回严格 JSON。 */
    async chat(messages, _tools, onText) {
      if (String(messages[0]?.content).includes('提取长期项目记忆')) {
        return {
          content: '{"candidates":[{"category":"decision","content":"项目使用 SQLite。"}]}',
          toolCalls: [],
        };
      }
      providerSnapshots.push(structuredClone(messages));
      const content = taskCalls++ === 0 ? '第一次完成' : '第二次完成';
      onText(content);
      return { content, toolCalls: [] };
    },
    async generateImage() { throw new Error('不应生成图片'); },
  };
  const firstStore = new PersistenceStore(databasePath);
  const firstMemories = new MemoryService(firstStore, provider, (value) => value);
  const firstSessions = new SessionService(
    config, provider, new ToolRegistry(), firstStore, firstMemories, (value) => value,
  );
  const sessionId = await firstSessions.create('cli', workspace);
  const firstResult = await firstSessions.run(
    sessionId, '记住项目存储方案', createSessionHooks(), new AbortController().signal,
  );
  const [candidate] = await firstResult.memoryExtraction!;
  await firstMemories.resolveCandidate(sessionId, candidate.id, { action: 'accept' });
  await firstSessions.close();
  firstStore.close();

  const secondStore = new PersistenceStore(databasePath);
  secondStore.recoverInterruptedWork();
  const secondMemories = new MemoryService(secondStore, provider, (value) => value);
  const secondSessions = new SessionService(
    config, provider, new ToolRegistry(), secondStore, secondMemories, (value) => value,
  );
  const restored = secondSessions.load(sessionId);
  expect(restored.messages.map((item) => item.role)).toEqual(['user', 'assistant']);
  const secondResult = await secondSessions.run(
    sessionId, '继续', createSessionHooks(), new AbortController().signal,
  );
  await secondResult.memoryExtraction;
  expect(JSON.stringify(providerSnapshots.at(-1))).toContain('用户确认的当前项目记忆');
  expect(JSON.stringify(providerSnapshots.at(-1))).toContain('项目使用 SQLite。');
  await secondSessions.close();
  secondStore.close();
  await rm(workspace, { recursive: true, force: true });
});
```

添加完整持久化脱敏测试：

```ts
it('数据库仅保存脱敏消息且候选拒绝疑似密钥', async () => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-secret-integration-')));
  const databasePath = path.join(workspace, 'agent.db');
  const config = loadConfig({ apiKey: 'test-secret-token-123456', workspace, databasePath }, {});
  const provider: ModelProvider = {
    /** 主任务回显输入，提取请求返回普通候选。 */
    async chat(messages, _tools, onText) {
      if (String(messages[0]?.content).includes('提取长期项目记忆')) {
        return { content: '{"candidates":[{"category":"fact","content":"普通候选"}]}', toolCalls: [] };
      }
      const content = String(messages.at(-1)?.content);
      onText(content);
      return { content, toolCalls: [] };
    },
    async generateImage() { throw new Error('不应生成图片'); },
  };
  const store = new PersistenceStore(databasePath);
  const sanitize = (value: string) => redactSecrets(value, [config.apiKey]);
  const memoryService = new MemoryService(store, provider, sanitize);
  const service = new SessionService(
    config, provider, new ToolRegistry(), store, memoryService, sanitize,
  );
  const sessionId = await service.create('cli', workspace);
  const result = await service.run(
    sessionId,
    'Bearer test-secret-token-123456',
    createSessionHooks(),
    new AbortController().signal,
  );
  const [candidate] = await result.memoryExtraction!;
  expect(JSON.stringify(store.loadAgentMessages(sessionId))).not.toContain('test-secret-token-123456');
  await expect(memoryService.resolveCandidate(sessionId, candidate.id, {
    action: 'accept', content: 'sk-abcdefghijklmnopqrstuvwxyz012345',
  })).rejects.toThrow('敏感信息');
  await service.close();
  store.close();
  await rm(workspace, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行新增集成测试**

Run:

```bash
pnpm vitest run tests/integration.test.ts tests/web.test.ts
```

Expected: 全部通过，并证明以下不变量：

- Provider 调用前用户消息已持久化。
- 数据库存储的是脱敏版本。
- 当前进程仍可使用原始任务文本完成本轮请求。
- 未确认候选从不进入模型消息。
- 关闭时等待工具和提取任务 settled。

- [ ] **Step 3: 更新 README 配置、交互和源码入口**

修改内容必须包括：

```markdown
## 本地数据

会话和已确认项目记忆默认保存在：

`~/Library/Application Support/agent-cli/agent.db`

可通过 `AGENT_CLI_DB_PATH` 或 `--database-path` 覆盖。数据库可能包含脱敏后的对话和代码片段，不要上传或提交该文件。删除会话不会删除已确认的项目记忆。
```

同步更新：

- Node 要求为 22.5+。
- 删除“服务重启后清空”“最多保留 20 个会话”“首版不包含会话持久化”。
- 增加 Web 记忆面板说明。
- 增加 CLI `/new`、`/sessions`、`/resume`、`/delete-session`、`/memory`。
- 源码入口增加 `src/persistence/`、`src/memory/`、`src/sessions/`。
- 明确 SQLite 未全库加密，只受本机用户权限保护。

- [ ] **Step 4: 运行完整自动验证**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Expected:

- TypeScript 零错误。
- 全部 Vitest 测试通过。
- Web 资源与 Web/CLI Node 构建成功。

- [ ] **Step 5: 启动 Web 服务并执行桌面、移动端检查**

Run:

```bash
pnpm dev --no-open --port 4317
```

保持服务运行，使用 Playwright Core 检查：

- `1440x900`：会话摘要、对话和四标签检查面板无重叠。
- `390x844`：侧栏抽屉和记忆面板不横向溢出。
- 创建任务后出现候选数量。
- 接受、编辑、忽略、停用和恢复均更新界面。
- 浏览器控制台无 error。

截屏保存到临时目录而不是仓库。完成后终止服务，确认没有遗留 Node 子进程。

- [ ] **Step 6: 执行真实 AIDP 只读联调**

使用现有 `.env`：

```bash
pnpm dev:cli --workspace /Users/bytedance/Documents/trae_projects/agent-cli
```

依次验证：

1. 输入“只回复 OK，不调用工具”。
2. 输入“记住：这个项目使用 pnpm”。
3. 检查候选只在确认后进入 `/memory`。
4. 退出并重新启动，确认会话和记忆恢复。
5. 新建会话，询问包管理器，确认模型收到已确认记忆。

不运行图片生成，不执行写文件或 Shell。

- [ ] **Step 7: 检查最终差异和本地数据**

Run:

```bash
git diff --check
git status --short
find "$HOME/Library/Application Support/agent-cli" -maxdepth 1 -type f -ls
```

Expected:

- `git diff --check` 无输出。
- `.env`、数据库、WAL 和 `.superpowers/` 均未进入 Git。
- 数据库及相关文件权限不向 group/other 开放。

- [ ] **Step 8: 提交验收与文档**

```bash
git add README.md .env.example tests/integration.test.ts tests/web.test.ts src
git commit -m "test: verify persistent memory workflows"
```

## 最终完成标准

- Web 和 CLI 重启后均能恢复各自会话。
- Web 会话列表只携带摘要，详情按需加载。
- 运行中断恢复不会重放工具，并补齐缺失工具结果。
- 普通成功任务自动提取候选，图片、失败和取消不提取。
- 候选只有接受或编辑后接受才成为正式记忆。
- 正式记忆只在相同 `realpath` 工作区中注入。
- 注入限制为最多 50 条和 12 KiB。
- 会话删除不删除已确认记忆。
- 已知密钥和常见凭据不会写入持久化消息或正式记忆。
- 所有数据库、服务、Web、CLI 和回归测试通过。
