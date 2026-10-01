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
  async getJson(_key: string): Promise<null> {
    return null;
  }

  /** Null 缓存忽略写入。 */
  async setJson(_key: string, _value: unknown, _ttlSeconds: number): Promise<void> {}

  /** Null 缓存忽略删除。 */
  async delete(_key: string): Promise<void> {}

  /** Null 缓存忽略发布。 */
  async publish(_channel: string, _value: unknown): Promise<void> {}

  /** Null 缓存忽略订阅。 */
  async subscribe(_channel: string, _listener: CacheListener): Promise<void> {}

  /** Null 缓存没有连接需要关闭。 */
  async close(): Promise<void> {}
}
