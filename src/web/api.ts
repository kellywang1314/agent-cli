import type { WebEvent, WebState } from './types.js';

const incomingToken = new URLSearchParams(window.location.hash.slice(1)).get('token');
if (incomingToken) {
  sessionStorage.setItem('agentAccessToken', incomingToken);
  history.replaceState(null, '', window.location.pathname);
}
const accessToken = incomingToken ?? sessionStorage.getItem('agentAccessToken') ?? '';

/** 调用本机服务，凭据仅用于工作台访问，不包含模型 AK。 */
export async function api<T>(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(route, {
    method, headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `请求失败 (${response.status})`);
  return result as T;
}

/** 订阅 SSE 快照，取消组件挂载时同步终止连接和重试。 */
export function subscribe(
  onState: (state: WebState) => void,
  onConnection: (connected: boolean, error?: string) => void,
): () => void {
  const controller = new AbortController();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let currentState: WebState | undefined;
  /** 合并完整快照或单会话增量，然后交给 React。 */
  function receive(event: WebEvent): void {
    if (event.type === 'state') {
      currentState = event.state;
    } else if (currentState) {
      const sessions = currentState.sessions.some((session) => session.id === event.session.id) ?
        currentState.sessions.map((session) => session.id === event.session.id ? event.session : session) :
        [...currentState.sessions, event.session];
      currentState = { ...currentState, sessions };
    }
    if (currentState) onState(currentState);
  }
  /** 读取完整 SSE 事件，暂存跨网络分片的数据。 */
  async function connect(): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch('/api/events', {
        headers: { authorization: `Bearer ${accessToken}` }, signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        onConnection(false, '请使用启动终端中的完整链接打开工作台。');
        return;
      }
      if (!response.ok || !response.body) throw new Error('本地服务连接中断');
      onConnection(true);
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('本地服务连接中断');
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (event.startsWith('data: ')) receive(JSON.parse(event.slice(6)) as WebEvent);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      onConnection(false, error instanceof Error ? error.message : '连接失败');
      retryTimer = setTimeout(() => void connect(), 1500);
    } finally { await reader?.cancel().catch(() => {}); }
  }
  void connect();
  return () => { clearTimeout(retryTimer); controller.abort(); };
}
