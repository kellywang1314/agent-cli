import { createClient } from 'redis';
import {
  NullCacheService,
  type CacheService,
} from './CacheService.js';
import { RedisCacheService } from './RedisCacheService.js';

/** 安全销毁未完成连接的 Redis Client。 */
function destroyClient(client: { destroy(): void } | null): void {
  if (!client) return;
  try {
    client.destroy();
  } catch {}
}

/** 创建可选 Redis 缓存，首次连接失败时降级为空实现。 */
export async function createCacheService(
  url: string | null,
  warning: (error: unknown) => void,
): Promise<CacheService> {
  if (!url) return new NullCacheService();
  let connected = false;
  const command = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 1_000,
      reconnectStrategy: (retries) => (
        connected ? Math.min(100 * 2 ** retries, 1_000) : false
      ),
    },
  });
  let subscriber: typeof command | null = null;
  /** 仅在首次连接成功后报告运行时连接错误。 */
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
