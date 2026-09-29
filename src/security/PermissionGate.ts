import type { PermissionRequest } from '../tools/types.js';

/** 管理唯一的待确认操作，并在取消时清理界面和监听器。 */
export class PermissionGate {
  private pending?: { settle: (approved: boolean) => void };

  /** 注入权限弹窗的状态通知函数。 */
  constructor(private readonly onRequest: (request: PermissionRequest | null) => void) {}

  /** 发起确认请求，拒绝并发并传递中断原因。 */
  async request(request: PermissionRequest, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (this.pending) return Promise.reject(new Error('已有待处理的权限确认'));
    return new Promise<boolean>((resolve, reject) => {
      /** 释放待确认状态及取消监听。 */
      const cleanup = (): void => {
        this.pending = undefined;
        signal.removeEventListener('abort', onAbort);
        this.onRequest(null);
      };
      /** 中断时清理并拒绝等待方。 */
      const onAbort = (): void => {
        try { cleanup(); } finally { reject(signal.reason); }
      };
      this.pending = {
        /** 收取确认结果并释放资源。 */
        settle: (approved): void => {
          try { cleanup(); resolve(approved); } catch (error) { reject(error); }
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try { this.onRequest(request); } catch (error) {
        this.pending = undefined;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    });
  }

  /** 响应当前确认，没有待处理请求时忽略。 */
  respond(approved: boolean): void {
    this.pending?.settle(approved);
  }
}
