import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { createCacheService } from '../src/cache/createCacheService.js';

const redisUrl = process.env.TEST_REDIS_URL;
const run = redisUrl ? it : it.skip;
let close: (() => Promise<void>) | undefined;

afterAll(async () => close?.());

run('真实 Redis 支持 TTL、删除和 Pub/Sub', async () => {
  const warnings: unknown[] = [];
  const cache = await createCacheService(
    redisUrl!,
    (error) => warnings.push(error),
  );
  close = () => cache.close();
  const suffix = randomUUID();
  const key = `agent-cli:test:${suffix}`;
  const channel = `agent-cli:test:${suffix}:events`;
  let resolveReceived!: (payload: unknown) => void;
  const received = new Promise<unknown>((resolve) => {
    resolveReceived = resolve;
  });

  await cache.subscribe(channel, resolveReceived);
  await cache.setJson(key, { value: suffix }, 30);
  expect(await cache.getJson(key)).toEqual({ value: suffix });
  await cache.publish(channel, { action: 'invalidate' });
  expect(await received).toEqual({ action: 'invalidate' });
  await cache.delete(key);
  expect(await cache.getJson(key)).toBeNull();
  expect(warnings).toEqual([]);
});
