import type { CacheListener, CacheService } from './CacheService.js';

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  del(key: string): Promise<number>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  readonly isOpen: boolean;
  quit(): Promise<unknown>;
  destroy(): void;
}

export class RedisCacheService implements CacheService {
  /** 保存已连接的命令、订阅客户端和脱敏告警出口。 */
  constructor(
    private readonly command: RedisClientLike,
    private readonly subscriber: RedisClientLike | null,
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
    try {
      await this.command.del(key);
    } catch (error) {
      this.warning(error);
    }
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
        try {
          listener(JSON.parse(value));
        } catch (error) {
          this.warning(error);
        }
      });
    } catch (error) {
      this.warning(error);
    }
  }

  /** 优先优雅退出连接，失败时强制销毁且不向业务抛错。 */
  private async closeClient(client: RedisClientLike | null): Promise<void> {
    if (!client) return;
    try {
      if (client.isOpen) await client.quit();
      else client.destroy();
    } catch (error) {
      this.warning(error);
      try {
        client.destroy();
      } catch {}
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
