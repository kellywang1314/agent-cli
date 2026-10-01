import { describe, expect, it, vi } from 'vitest';
import { NullCacheService } from '../src/cache/CacheService.js';
import { createCacheService } from '../src/cache/createCacheService.js';
import { RedisCacheService } from '../src/cache/RedisCacheService.js';

const redisMock = vi.hoisted(() => ({
  createClient: vi.fn(),
}));
vi.mock('redis', () => ({
  createClient: redisMock.createClient,
}));

describe('缓存服务', () => {
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

  it('首次 Redis 连接失败时停止重试并降级为空缓存', async () => {
    let initialReconnectDecision: false | number | Error | undefined;
    const command = {
      on: vi.fn(),
      connect: vi.fn(async () => {
        initialReconnectDecision = reconnectStrategy?.(0, new Error('offline'));
        throw new Error('offline');
      }),
      destroy: vi.fn(),
    };
    let reconnectStrategy:
      | ((retries: number, cause: Error) => false | number | Error)
      | undefined;
    redisMock.createClient.mockImplementation((options) => {
      reconnectStrategy = options.socket?.reconnectStrategy;
      return command;
    });
    const warning = vi.fn();

    const cache = await createCacheService('redis://127.0.0.1:6379', warning);

    expect(cache).toBeInstanceOf(NullCacheService);
    expect(initialReconnectDecision).toBe(false);
    expect(command.destroy).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
  });
});
