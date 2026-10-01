# Redis Optional Cache Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, fail-open Redis Cache-Aside and Pub/Sub layer while keeping SQLite as the only durable source of truth.

**Architecture:** `MemoryService` reads active project memories through a small `CacheService` interface and falls back to `PersistenceStore` on every miss or Redis error. Memory writes commit to SQLite first, then invalidate the Redis key and publish a content-free event; Web servers subscribe to the event and refresh SSE state. A `NullCacheService` preserves existing behavior when Redis is not configured.

**Tech Stack:** TypeScript, Node.js 22, official `redis` client, Zod, SQLite, Vitest, HTTP/SSE

---

## File Map

**Create**

- `src/cache/CacheService.ts`: cache contract, invalidation listener type, no-op implementation.
- `src/cache/cacheKeys.ts`: workspace hashing, Redis keys, cached-memory and event schemas.
- `src/cache/RedisCacheService.ts`: fail-open Redis command and subscriber connections.
- `src/cache/createCacheService.ts`: optional Redis connection and Null fallback.
- `tests/cache.test.ts`: unit tests for Null/Redis implementations and factory fallback.
- `tests/redis.integration.test.ts`: opt-in integration test using `TEST_REDIS_URL`.

**Modify**

- `package.json`, `pnpm-lock.yaml`: add official `redis` dependency.
- `src/config/loadConfig.ts`: optional Redis URL and bounded TTL.
- `src/main.tsx`: CLI arguments, cache construction, sanitization, and shutdown.
- `src/web/main.ts`: Web arguments and fatal-error sanitization.
- `src/web/server.ts`: cache injection, Pub/Sub subscription, refresh, and shutdown.
- `src/memory/MemoryService.ts`: active-memory Cache-Aside and post-commit invalidation.
- `src/tools/services/process.ts`: remove Redis credentials from tool subprocesses.
- `tests/provider.test.ts`: Redis configuration and URL redaction.
- `tests/memory.test.ts`: hit, miss, corrupt payload, and invalidation behavior.
- `tests/tools.test.ts`: Redis environment filtering.
- `tests/web.test.ts`: Pub/Sub-driven Web refresh and cache shutdown.
- `.env.example`, `README.md`: local macOS setup and cache experiment.

## Task 1: Redis Configuration and Dependency

**Files:**

- Modify: `tests/provider.test.ts:35-70`
- Modify: `src/config/loadConfig.ts:5-64`
- Modify: `src/main.tsx:17-36`
- Modify: `src/web/main.ts:12-29`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing Redis configuration tests**

Add these cases to the existing `配置` suite:

```ts
it('读取可选 Redis 地址和有界 TTL，参数覆盖环境变量', () => {
  const config = loadConfig({
    apiKey: 'key',
    redisUrl: 'redis://127.0.0.1:6380',
    redisCacheTtlSeconds: 60,
  }, {
    REDIS_URL: 'redis://127.0.0.1:6379',
    REDIS_CACHE_TTL_SECONDS: '300',
  });
  expect(config.redisUrl).toBe('redis://127.0.0.1:6380');
  expect(config.redisCacheTtlSeconds).toBe(60);

  const disabled = loadConfig({ apiKey: 'key' }, {});
  expect(disabled.redisUrl).toBeNull();
  expect(disabled.redisCacheTtlSeconds).toBe(300);
});

it('拒绝非 Redis 协议和超出范围的缓存 TTL', () => {
  expect(() => loadConfig({ apiKey: 'key', redisUrl: 'https://localhost' }, {}))
    .toThrow('redisUrl');
  expect(() => loadConfig({ apiKey: 'key', redisCacheTtlSeconds: 0 }, {}))
    .toThrow('redisCacheTtlSeconds');
  expect(() => loadConfig({ apiKey: 'key' }, {
    REDIS_CACHE_TTL_SECONDS: 'not-a-number',
  })).toThrow('redisCacheTtlSeconds');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm vitest run tests/provider.test.ts
```

Expected: TypeScript or assertion failure because Redis config fields do not exist.

- [ ] **Step 3: Add validated Redis configuration**

Extend `ConfigInput`:

```ts
redisUrl?: string;
redisCacheTtlSeconds?: number;
```

Add schemas:

```ts
const redisUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return ['redis:', 'rediss:'].includes(url.protocol);
}, 'Redis 地址必须使用 redis:// 或 rediss://');
```

Extend `configSchema`:

```ts
redisUrl: redisUrlSchema.nullable(),
redisCacheTtlSeconds: z.number().int().min(1).max(86_400),
```

Extend `loadConfig` input:

```ts
redisUrl: input.redisUrl ?? env.REDIS_URL?.trim() || null,
redisCacheTtlSeconds: input.redisCacheTtlSeconds ??
  Number(env.REDIS_CACHE_TTL_SECONDS ?? 300),
```

Parenthesize the mixed nullish/OR expression to satisfy JavaScript syntax:

```ts
redisUrl: input.redisUrl ?? (env.REDIS_URL?.trim() || null),
```

- [ ] **Step 4: Expose CLI arguments**

Add to both CLI entrypoints:

```ts
.option('redis-url', { type: 'string', describe: '可选 Redis 地址' })
.option('redis-cache-ttl', {
  type: 'number',
  describe: 'Redis 缓存 TTL 秒数',
  default: 300,
})
```

Pass them to `loadConfig`:

```ts
redisUrl: args.redisUrl,
redisCacheTtlSeconds: args.redisCacheTtl,
```

- [ ] **Step 5: Add the official Redis client**

Run:

```bash
pnpm add redis
```

Expected: `package.json` and `pnpm-lock.yaml` include `redis`.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
pnpm vitest run tests/provider.test.ts
pnpm typecheck
```

Expected: both commands pass.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/config/loadConfig.ts src/main.tsx src/web/main.ts tests/provider.test.ts
git commit -m "feat: configure optional redis"
```

## Task 2: Fail-Open Cache Service

**Files:**

- Create: `src/cache/CacheService.ts`
- Create: `src/cache/cacheKeys.ts`
- Create: `src/cache/RedisCacheService.ts`
- Create: `src/cache/createCacheService.ts`
- Create: `tests/cache.test.ts`

- [ ] **Step 1: Write failing cache contract and Redis behavior tests**

Create `tests/cache.test.ts` with a fake Redis client covering:

```ts
import { describe, expect, it, vi } from 'vitest';
import { NullCacheService } from '../src/cache/CacheService.js';
import { RedisCacheService } from '../src/cache/RedisCacheService.js';

it('NullCacheService 永远未命中且所有操作可安全调用', async () => {
  const cache = new NullCacheService();
  expect(await cache.getJson('key')).toBeNull();
  await expect(cache.setJson('key', { value: 1 }, 30)).resolves.toBeUndefined();
  await expect(cache.delete('key')).resolves.toBeUndefined();
  await expect(cache.publish('channel', { value: 1 })).resolves.toBeUndefined();
  await expect(cache.subscribe('channel', vi.fn())).resolves.toBeUndefined();
  await expect(cache.close()).resolves.toBeUndefined();
});

it('RedisCacheService 读写 JSON、设置 TTL、删除并发布', async () => {
  const command = {
    get: vi.fn(async () => '{"value":1}'),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    publish: vi.fn(async () => 1),
    isOpen: true,
    quit: vi.fn(async () => 'OK'),
    destroy: vi.fn(),
  };
  const subscriber = {
    subscribe: vi.fn(async (_channel: string, listener: (value: string) => void) => {
      listener('{"resource":"memory"}');
    }),
    isOpen: true,
    quit: vi.fn(async () => 'OK'),
    destroy: vi.fn(),
  };
  const listener = vi.fn();
  const cache = new RedisCacheService(command as never, subscriber as never, vi.fn());

  expect(await cache.getJson('key')).toEqual({ value: 1 });
  await cache.setJson('key', { value: 2 }, 30);
  await cache.delete('key');
  await cache.publish('channel', { value: 3 });
  await cache.subscribe('channel', listener);

  expect(command.set).toHaveBeenCalledWith('key', '{"value":2}', { EX: 30 });
  expect(listener).toHaveBeenCalledWith({ resource: 'memory' });
});

it('RedisCacheService 将命令错误降级为未命中或空操作', async () => {
  const warning = vi.fn();
  const command = {
    get: vi.fn(async () => { throw new Error('redis://user:secret@host failed'); }),
    set: vi.fn(async () => { throw new Error('write failed'); }),
    del: vi.fn(async () => { throw new Error('delete failed'); }),
    publish: vi.fn(async () => { throw new Error('publish failed'); }),
    isOpen: false,
    destroy: vi.fn(),
  };
  const cache = new RedisCacheService(command as never, null, warning);
  expect(await cache.getJson('key')).toBeNull();
  await expect(cache.setJson('key', {}, 30)).resolves.toBeUndefined();
  await expect(cache.delete('key')).resolves.toBeUndefined();
  await expect(cache.publish('channel', {})).resolves.toBeUndefined();
  expect(warning).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm vitest run tests/cache.test.ts
```

Expected: module-not-found failures for the cache files.

- [ ] **Step 3: Implement the cache contract and Null implementation**

Create `src/cache/CacheService.ts`:

```ts
export type CacheListener = (payload: unknown) => void;

export interface CacheService {
  getJson(key: string): Promise<unknown | null>;
  setJson(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  publish(channel: string, value: unknown): Promise<void>;
  subscribe(channel: string, listener: CacheListener): Promise<void>;
  close(): Promise<void>;
}

export class NullCacheService implements CacheService {
  /** Null 缓存始终返回未命中。 */
  async getJson(): Promise<null> { return null; }
  /** Null 缓存忽略写入。 */
  async setJson(): Promise<void> {}
  /** Null 缓存忽略删除。 */
  async delete(): Promise<void> {}
  /** Null 缓存忽略发布。 */
  async publish(): Promise<void> {}
  /** Null 缓存忽略订阅。 */
  async subscribe(): Promise<void> {}
  /** Null 缓存没有连接需要关闭。 */
  async close(): Promise<void> {}
}
```

- [ ] **Step 4: Implement keys and strict payload schemas**

Create `src/cache/cacheKeys.ts`:

```ts
import { createHash } from 'node:crypto';
import { z } from 'zod';

const storedMemorySchema = z.object({
  id: z.string(),
  workspace: z.string(),
  category: z.enum(['rule', 'decision', 'fact', 'preference']),
  content: z.string(),
  normalizedContent: z.string(),
  active: z.boolean(),
  sourceSessionId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();

export const storedMemoriesCacheSchema = z.array(storedMemorySchema).max(50);
export const memoryInvalidationEventSchema = z.object({
  version: z.literal(1),
  resource: z.literal('memory'),
  workspaceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  action: z.literal('invalidate'),
}).strict();
export const memoryInvalidationChannel = 'agent-cli:v1:events:invalidate';

/** 将规范化工作区路径转换为不泄露原文的稳定摘要。 */
export function hashWorkspace(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex');
}

/** 生成启用记忆缓存 Key。 */
export function activeMemoriesCacheKey(workspace: string): string {
  return `agent-cli:v1:memory:${hashWorkspace(workspace)}:active`;
}
```

- [ ] **Step 5: Implement fail-open Redis commands**

Create `src/cache/RedisCacheService.ts`:

```ts
import type { RedisClientType } from 'redis';
import type { CacheListener, CacheService } from './CacheService.js';

export class RedisCacheService implements CacheService {
  /** 保存已连接的命令、订阅客户端和脱敏告警出口。 */
  constructor(
    private readonly command: RedisClientType,
    private readonly subscriber: RedisClientType | null,
    private readonly warning: (error: unknown) => void,
  ) {}

  /** 读取并解析 JSON；连接、命令或 JSON 错误均视为未命中。 */
  async getJson(key: string): Promise<unknown | null> {
    try {
      const value = await this.command.get(key);
      return value === null ? null : JSON.parse(value);
    } catch (error) {
      this.warning(error);
      return null;
    }
  }

  /** 使用 EX 写入有界生命周期的 JSON 缓存。 */
  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.command.set(key, JSON.stringify(value), { EX: ttlSeconds });
    } catch (error) {
      this.warning(error);
    }
  }

  /** 删除缓存 Key，错误仅记录。 */
  async delete(key: string): Promise<void> {
    try { await this.command.del(key); } catch (error) { this.warning(error); }
  }

  /** 发布不含正文的失效事件。 */
  async publish(channel: string, value: unknown): Promise<void> {
    try {
      await this.command.publish(channel, JSON.stringify(value));
    } catch (error) {
      this.warning(error);
    }
  }

  /** 订阅事件并在 JSON 校验边界前只传递解析结果。 */
  async subscribe(channel: string, listener: CacheListener): Promise<void> {
    if (!this.subscriber) return;
    try {
      await this.subscriber.subscribe(channel, (value) => {
        try { listener(JSON.parse(value)); } catch (error) { this.warning(error); }
      });
    } catch (error) {
      this.warning(error);
    }
  }

  /** 优先优雅退出连接，失败时强制销毁且不向业务抛错。 */
  private async closeClient(client: RedisClientType | null): Promise<void> {
    if (!client) return;
    try {
      if (client.isOpen) await client.quit();
      else client.destroy();
    } catch (error) {
      this.warning(error);
      try { client.destroy(); } catch {}
    }
  }

  /** 关闭命令与订阅连接。 */
  async close(): Promise<void> {
    await Promise.all([
      this.closeClient(this.command),
      this.closeClient(this.subscriber),
    ]);
  }
}
```

- [ ] **Step 6: Implement optional connection factory**

Create `src/cache/createCacheService.ts`:

```ts
import { createClient } from 'redis';
import {
  NullCacheService,
  type CacheService,
} from './CacheService.js';
import { RedisCacheService } from './RedisCacheService.js';

/** 安全销毁未完成连接的 Redis Client。 */
function destroyClient(client: ReturnType<typeof createClient> | null): void {
  if (!client) return;
  try { client.destroy(); } catch {}
}

/** 创建可选 Redis 缓存，首次连接失败时降级为空实现。 */
export async function createCacheService(
  url: string | null,
  warning: (error: unknown) => void,
): Promise<CacheService> {
  if (!url) return new NullCacheService();
  const command = createClient({
    url,
    socket: {
      connectTimeout: 1_000,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 1_000),
    },
  });
  let subscriber: ReturnType<typeof createClient> | null = null;
  let connected = false;
  const onError = (error: unknown): void => {
    if (connected) warning(error);
  };
  command.on('error', onError);
  try {
    await command.connect();
    subscriber = command.duplicate();
    subscriber.on('error', onError);
    await subscriber.connect();
    connected = true;
    return new RedisCacheService(command, subscriber, warning);
  } catch (error) {
    warning(error);
    destroyClient(subscriber);
    destroyClient(command);
    return new NullCacheService();
  }
}
```

- [ ] **Step 7: Verify GREEN**

Run:

```bash
pnpm vitest run tests/cache.test.ts
pnpm typecheck
```

Expected: all cache tests and typecheck pass.

- [ ] **Step 8: Commit**

```bash
git add src/cache tests/cache.test.ts
git commit -m "feat: add fail-open redis cache service"
```

## Task 3: Active-Memory Cache-Aside

**Files:**

- Modify: `src/memory/MemoryService.ts:77-289`
- Modify: `tests/memory.test.ts`

- [ ] **Step 1: Add a controllable fake cache to memory tests**

Add a `FakeCacheService` implementing `CacheService` with:

```ts
class FakeCacheService implements CacheService {
  value: unknown | null = null;
  readonly getJson = vi.fn(async () => this.value);
  readonly setJson = vi.fn(async (_key: string, value: unknown) => {
    this.value = value;
  });
  readonly delete = vi.fn(async () => { this.value = null; });
  readonly publish = vi.fn(async () => {});
  readonly subscribe = vi.fn(async () => {});
  readonly close = vi.fn(async () => {});
}
```

- [ ] **Step 2: Write failing hit, miss, corrupt-cache and invalidation tests**

Add tests proving:

```ts
it('运行时记忆缓存命中时不查询 SQLite', async () => {
  const store = await createStore();
  store.createSession(buildSession());
  const cache = new FakeCacheService();
  cache.value = [{
    id: 'cached', workspace: '/workspace/one', category: 'rule',
    content: '来自 Redis', normalizedContent: '来自 redis', active: true,
    sourceSessionId: null, createdAt: 1, updatedAt: 1,
  }];
  const listMemories = vi.spyOn(store, 'listMemories');
  const service = new MemoryService(
    store,
    createProvider('{"candidates":[]}'),
    (text) => text,
    cache,
    60,
  );

  expect(await service.buildRuntimeInstructions('/workspace/one')).toContain('来自 Redis');
  expect(listMemories).not.toHaveBeenCalled();
});

it('缓存未命中时读取 SQLite 并使用配置 TTL 回填', async () => {
  const store = await createStore();
  store.createSession(buildSession());
  const memory = acceptCandidate(store, buildCandidate());
  const cache = new FakeCacheService();
  const listMemories = vi.spyOn(store, 'listMemories');
  const service = new MemoryService(
    store,
    createProvider('{"candidates":[]}'),
    (text) => text,
    cache,
    60,
  );

  expect(await service.buildRuntimeInstructions('/workspace/one'))
    .toContain(memory!.content);
  expect(listMemories).toHaveBeenCalledWith('/workspace/one', true, 50);
  expect(cache.setJson).toHaveBeenCalledWith(
    activeMemoriesCacheKey('/workspace/one'),
    [memory],
    60,
  );
});

it('缓存结构无效时删除损坏 Key 并回源 SQLite', async () => {
  const store = await createStore();
  store.createSession(buildSession());
  const memory = acceptCandidate(store, buildCandidate());
  const cache = new FakeCacheService();
  cache.value = { invalid: true };
  const service = new MemoryService(
    store,
    createProvider('{"candidates":[]}'),
    (text) => text,
    cache,
    60,
  );

  expect(await service.buildRuntimeInstructions('/workspace/one'))
    .toContain(memory!.content);
  expect(cache.delete).toHaveBeenCalledWith(
    activeMemoriesCacheKey('/workspace/one'),
  );
  expect(cache.setJson).toHaveBeenCalledWith(
    activeMemoriesCacheKey('/workspace/one'),
    [memory],
    60,
  );
});

it('接受、编辑、启停和删除记忆只在 SQLite 成功后失效并发布', async () => {
  const store = await createStore();
  store.createSession(buildSession());
  store.createSession(buildSession({
    id: 'session-2',
    workspace: '/workspace/two',
  }));
  store.insertMemoryCandidates([buildCandidate()]);
  const cache = new FakeCacheService();
  const service = new MemoryService(
    store,
    createProvider('{"candidates":[]}'),
    (text) => text,
    cache,
    60,
  );

  const memory = await service.resolveCandidate(
    'session-1',
    'candidate-1',
    { action: 'accept' },
  );
  expect(cache.delete).toHaveBeenCalledTimes(1);
  expect(cache.publish).toHaveBeenCalledTimes(1);

  service.updateMemory('session-1', memory!.id, { active: false });
  service.deleteMemory('session-1', memory!.id);
  await vi.waitFor(() => {
    expect(cache.delete).toHaveBeenCalledTimes(3);
    expect(cache.publish).toHaveBeenCalledTimes(3);
  });

  expect(() => service.updateMemory(
    'session-2',
    memory!.id,
    { active: true },
  )).toThrow('记忆不存在');
  expect(cache.delete).toHaveBeenCalledTimes(3);
  expect(cache.publish).toHaveBeenCalledTimes(3);
});
```

- [ ] **Step 3: Run the tests and verify RED**

Run:

```bash
pnpm vitest run tests/memory.test.ts
```

Expected: constructor/cache assertions fail because `MemoryService` does not use `CacheService`.

- [ ] **Step 4: Add Cache-Aside to `MemoryService`**

Add optional constructor arguments to preserve all existing callers:

```ts
constructor(
  private readonly store: PersistenceStore,
  private readonly provider: ModelProvider,
  private readonly sanitize: (text: string) => string,
  private readonly cache: CacheService = new NullCacheService(),
  private readonly cacheTtlSeconds = 300,
) {}
```

Add:

```ts
/** 从 Redis 读取启用记忆，未命中或数据无效时回源 SQLite。 */
private async listActiveMemories(workspace: string): Promise<StoredMemory[]> {
  const key = activeMemoriesCacheKey(workspace);
  const cached = await this.cache.getJson(key);
  if (cached !== null) {
    const parsed = storedMemoriesCacheSchema.safeParse(cached);
    if (parsed.success) return parsed.data;
    await this.cache.delete(key);
  }
  const memories = this.store.listMemories(workspace, true, maxRuntimeMemoryCount);
  await this.cache.setJson(key, memories, this.cacheTtlSeconds);
  return memories;
}

/** 在 SQLite 成功写入后依次失效共享缓存并发布无正文事件。 */
private async invalidateMemoryCache(workspace: string): Promise<void> {
  await this.cache.delete(activeMemoriesCacheKey(workspace));
  await this.cache.publish(memoryInvalidationChannel, {
    version: 1,
    resource: 'memory',
    workspaceHash: hashWorkspace(workspace),
    action: 'invalidate',
  });
}
```

Use `await listActiveMemories` in both `extractTurnNow` and `buildRuntimeInstructions`.
Await `invalidateMemoryCache(...)` before returning an accepted candidate because that API is
already asynchronous. Call it with `void` after successful synchronous `updateMemory` and
`deleteMemory`. Ignore decisions do not invalidate. The CacheService contract guarantees
fail-open methods, so the background sequence cannot reject into the task path.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
pnpm vitest run tests/memory.test.ts
pnpm typecheck
```

Expected: memory tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add src/memory/MemoryService.ts tests/memory.test.ts
git commit -m "feat: cache active project memories"
```

## Task 4: CLI/Web Lifecycle and Pub/Sub Refresh

**Files:**

- Modify: `src/main.tsx:40-62`
- Modify: `src/web/server.ts:16-332`
- Modify: `tests/web.test.ts`

- [ ] **Step 1: Write a failing Web Pub/Sub lifecycle test**

Extend the Web `setup` helper to accept `cacheService?: CacheService` and pass it to
`startWebServer`. Add:

```ts
it('Redis 失效事件触发完整 Web 状态刷新且关闭缓存连接', async () => {
  let listener: ((payload: unknown) => void) | undefined;
  const cache = {
    getJson: vi.fn(async () => null),
    setJson: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(async (_channel, nextListener) => { listener = nextListener; }),
    close: vi.fn(async () => {}),
  } satisfies CacheService;
  const { server, request } = await setup(provider, undefined, undefined, cache);
  const events = await request('/api/events');
  const reader = createSseReader(events);
  await reader.read();

  listener?.({
    version: 1,
    resource: 'memory',
    workspaceHash: 'a'.repeat(64),
    action: 'invalidate',
  });

  expect((await reader.read()).type).toBe('state');
  await server.close();
  expect(cache.close).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm vitest run tests/web.test.ts
```

Expected: `cacheService` option and subscription behavior do not exist.

- [ ] **Step 3: Wire cache lifecycle into the CLI**

In `src/main.tsx`, create the cache after `sanitize`:

```ts
const cache = await createCacheService(
  config.redisUrl,
  (error) => console.error(`Redis 已降级：${sanitize(String(error))}`),
);
const memories = new MemoryService(
  persistence,
  provider,
  sanitize,
  cache,
  config.redisCacheTtlSeconds,
);
```

Add `await cache.close()` in `finally`, before closing SQLite.

- [ ] **Step 4: Wire cache and subscriptions into the Web server**

Add optional injection:

```ts
cacheService?: CacheService;
```

Create or reuse the cache, pass it to `MemoryService`, then subscribe after `broadcast` is defined:

```ts
await cache.subscribe(memoryInvalidationChannel, (payload) => {
  if (memoryInvalidationEventSchema.safeParse(payload).success) broadcast();
});
```

On listen failure and normal shutdown, close the cache exactly once. Keep the existing idempotent
`closePromise` behavior.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
pnpm vitest run tests/web.test.ts tests/ui.test.tsx tests/sessionService.test.ts
pnpm typecheck
```

Expected: Web, CLI-related UI/service tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add src/main.tsx src/web/server.ts tests/web.test.ts
git commit -m "feat: broadcast redis memory invalidations"
```

## Task 5: Credential Boundaries and Learning Documentation

**Files:**

- Modify: `src/config/loadConfig.ts:54-64`
- Modify: `src/tools/services/process.ts:10-13`
- Modify: `src/main.tsx:65-71`
- Modify: `src/web/main.ts:54-56`
- Modify: `tests/provider.test.ts:54-59`
- Modify: `tests/tools.test.ts:312-322`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Write failing Redis credential tests**

Add:

```ts
it('Redis URL 用户信息会被脱敏', () => {
  const text = redactSecrets(
    'connect redis://student:private-password@127.0.0.1:6379 failed',
  );
  expect(text).toBe('connect redis://[REDACTED]@127.0.0.1:6379 failed');
});
```

Extend the child-process test:

```ts
vi.stubEnv('REDIS_URL', 'redis://student:private-password@127.0.0.1:6379');
// shell output must show REDIS_URL as unset.
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm vitest run tests/provider.test.ts tests/tools.test.ts
```

Expected: Redis credentials remain visible and `REDIS_URL` reaches the child process.

- [ ] **Step 3: Harden redaction and child environments**

Add to `redactSecrets`:

```ts
.replace(/\b(rediss?:\/\/)([^@\s/]+)@/gi, '$1[REDACTED]@')
```

Change the child environment filter to:

```ts
!/^(AIDP|OPENAI|REDIS|GIT_)/i.test(key)
```

Include `process.env.REDIS_URL` and the `--redis-url` argument in fatal-error secret lists.

- [ ] **Step 4: Document configuration and an observable macOS exercise**

Update `.env.example` with commented optional Redis settings.

Add a README section containing:

```bash
brew install redis
brew services start redis
redis-cli ping
redis-cli --scan --pattern 'agent-cli:v1:*'
redis-cli TTL '<key>'
brew services stop redis
```

Explain:

- cache hit, miss, backfill, invalidation and TTL;
- SQLite remains the source of truth;
- Pub/Sub is ephemeral and is not a durable queue;
- stopping Redis demonstrates fail-open fallback;
- remote Redis should use `rediss://`, authentication and least privilege.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
pnpm vitest run tests/provider.test.ts tests/tools.test.ts
pnpm typecheck
git diff --check
```

Expected: tests, typecheck and whitespace check pass.

- [ ] **Step 6: Commit**

```bash
git add src/config/loadConfig.ts src/tools/services/process.ts src/main.tsx src/web/main.ts \
  tests/provider.test.ts tests/tools.test.ts .env.example README.md
git commit -m "docs: explain redis cache workflow"
```

## Task 6: Optional Real Redis Integration and Final Verification

**Files:**

- Create: `tests/redis.integration.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write opt-in real Redis integration tests**

Create a suite skipped unless `TEST_REDIS_URL` is present:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { createCacheService } from '../src/cache/createCacheService.js';

const redisUrl = process.env.TEST_REDIS_URL;
const run = redisUrl ? it : it.skip;
let close: (() => Promise<void>) | undefined;

afterAll(async () => close?.());

run('真实 Redis 支持 TTL、删除和 Pub/Sub', async () => {
  const warnings: unknown[] = [];
  const cache = await createCacheService(redisUrl!, (error) => warnings.push(error));
  close = () => cache.close();
  const suffix = randomUUID();
  const key = `agent-cli:test:${suffix}`;
  const channel = `agent-cli:test:${suffix}:events`;
  const received = new Promise<unknown>((resolve) => {
    void cache.subscribe(channel, resolve);
  });

  await cache.setJson(key, { value: suffix }, 30);
  expect(await cache.getJson(key)).toEqual({ value: suffix });
  await cache.publish(channel, { action: 'invalidate' });
  expect(await received).toEqual({ action: 'invalidate' });
  await cache.delete(key);
  expect(await cache.getJson(key)).toBeNull();
  expect(warnings).toEqual([]);
});
```

Ensure subscription is awaited before publishing by exposing a local readiness promise or by
awaiting `subscribe` directly before `publish`.

- [ ] **Step 2: Run default verification without Redis**

Run:

```bash
env -u REDIS_URL -u TEST_REDIS_URL pnpm typecheck
env -u REDIS_URL -u TEST_REDIS_URL pnpm test
env -u REDIS_URL -u TEST_REDIS_URL pnpm build
```

Expected: all commands pass and the Redis integration suite is skipped.

- [ ] **Step 3: Run real Redis verification when available**

On macOS:

```bash
brew services start redis
TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm vitest run tests/redis.integration.test.ts
```

Expected: TTL/cache/delete/PubSub test passes and no credentials appear in output. If Homebrew
Redis is not installed, record the skipped optional test; do not make the default suite fail.

- [ ] **Step 4: Manually verify fail-open behavior**

Start the Web app with Redis, load project memories, then stop Redis:

```bash
REDIS_URL=redis://127.0.0.1:6379 pnpm dev --no-open
brew services stop redis
```

Expected: memory reads and Agent tasks continue from SQLite, with one sanitized degradation warning
and no unhandled rejection.

- [ ] **Step 5: Inspect final security and repository state**

Run:

```bash
rg -n 'redis://[^[:space:]]+@|REDIS_URL=' src tests README.md .env.example
git diff --check
git status --short
```

Expected: only synthetic/example credentials appear in tests; `.env.example` contains no password;
the worktree contains only intended changes.

- [ ] **Step 6: Commit**

```bash
git add tests/redis.integration.test.ts README.md
git commit -m "test: verify optional redis workflows"
```

- [ ] **Step 7: Push the completed branch**

```bash
git push
```

Expected: `origin/feat/agent-cli` advances without push-protection violations.
