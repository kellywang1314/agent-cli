import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { redactSecrets, type AgentConfig } from '../config/loadConfig.js';
import { AidpProvider } from '../providers/AidpProvider.js';
import type { ModelProvider } from '../providers/types.js';
import { SessionStore } from './sessions.js';
import type { WebEvent } from './types.js';

interface ServerOptions {
  config: AgentConfig;
  provider?: ModelProvider;
  port?: number;
  token?: string;
}

const inspectSchema = z.object({
  kind: z.enum(['files', 'file', 'diff']),
  path: z.string().max(4096).optional(),
});

/** 有界读取 JSON 输入，拒绝错误 MIME、超大请求和无效 JSON。 */
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('请发送 application/json');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65_536) throw new Error('请求超过 64 KiB');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** 发送不可缓存的 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** 启动仅供本机访问的鉴权 HTTP/SSE 服务。 */
export async function startWebServer(options: ServerOptions) {
  const token = options.token ?? randomBytes(32).toString('hex');
  const peers = new Set<ServerResponse>();
  let origin = '';
  let broadcastTimer: NodeJS.Timeout | undefined;
  let disconnectTimer: NodeJS.Timeout | undefined;
  let pendingFullState = false;
  const pendingSessionIds = new Set<string>();
  const store = new SessionStore(options.config, options.provider ?? new AidpProvider(options.config), broadcast);
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ]);
  const assetRoot = new URL('../../dist/web-assets/', import.meta.url);

  /** 向全部 SSE 客户端写入一个事件，并断开无法及时消费的连接。 */
  function writeEvent(event: WebEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const peer of peers) if (!peer.write(data)) peer.destroy();
  }

  /** 合并高频模型分片；普通更新只序列化发生变化的会话。 */
  function broadcast(sessionId?: string): void {
    if (!peers.size) return;
    if (sessionId) pendingSessionIds.add(sessionId);
    else pendingFullState = true;
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      if (!peers.size) {
        pendingFullState = false;
        pendingSessionIds.clear();
        return;
      }
      if (pendingFullState) {
        writeEvent({ type: 'state', state: store.snapshot() });
      } else {
        for (const id of pendingSessionIds) {
          try { writeEvent({ type: 'session', session: store.getSessionSnapshot(id) }); } catch { /* 会话可能已删除。 */ }
        }
      }
      pendingFullState = false;
      pendingSessionIds.clear();
    }, 100);
  }

  /** 检查 localhost 来源和常量时间令牌，拒绝 DNS rebinding 与跨站调用。 */
  function authorized(request: IncomingMessage, response: ServerResponse): boolean {
    const host = new URL(origin).host;
    if (request.headers.host !== host ||
      (request.headers.origin && request.headers.origin !== origin) ||
      request.headers['sec-fetch-site'] === 'cross-site') {
      sendJson(response, 403, { error: '只允许本机工作台访问' });
      return false;
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      sendJson(response, 401, { error: '访问令牌无效，请使用启动终端提供的完整链接' });
      return false;
    }
    return true;
  }

  /** 路由 HTTP 请求，所有 API 共享来源校验与鉴权。 */
  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url = new URL(request.url ?? '/', origin);
    if (!url.pathname.startsWith('/api/')) {
      if (request.headers.host !== new URL(origin).host) { sendJson(response, 403, { error: '无效 Host' }); return; }
      const asset = assets.get(url.pathname);
      if (request.method !== 'GET' || !asset) { sendJson(response, 404, { error: '未找到资源' }); return; }
      try {
        const content = await readFile(fileURLToPath(new URL(asset[0]!, assetRoot)));
        response.writeHead(200, { 'Content-Type': asset[1]!, 'Cache-Control': 'no-store' });
        response.end(content);
      } catch { sendJson(response, 503, { error: '界面尚未构建，请运行 pnpm build:web' }); }
      return;
    }
    if (!authorized(request, response)) return;
    if (request.method === 'GET' && url.pathname === '/api/state') {
      sendJson(response, 200, store.snapshot());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      if (peers.size >= 8) { sendJson(response, 429, { error: '打开的工作台页面过多' }); return; }
      clearTimeout(disconnectTimer);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      });
      response.write(`data: ${JSON.stringify({ type: 'state', state: store.snapshot() } satisfies WebEvent)}\n\n`);
      peers.add(response);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 10_000);
      response.on('close', () => {
        clearInterval(heartbeat);
        peers.delete(response);
        if (!peers.size) disconnectTimer = setTimeout(() => store.cancelAll(), 15_000);
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      const body = z.object({ workspace: z.string().min(1).max(4096).optional() }).parse(await readJson(request));
      const id = await store.create(body.workspace);
      sendJson(response, 201, { id });
      return;
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(message|cancel|permission|inspect))?$/.exec(url.pathname);
    if (!match) { sendJson(response, 404, { error: '接口不存在' }); return; }
    const id = match[1]!;
    if (request.method === 'DELETE' && !match[2]) {
      store.remove(id);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method !== 'POST') { sendJson(response, 405, { error: '方法不支持' }); return; }
    const body = await readJson(request);
    if (match[2] === 'message') {
      const { prompt } = z.object({ prompt: z.string().trim().min(1).max(16_384) }).parse(body);
      store.submit(id, prompt);
      sendJson(response, 202, { ok: true });
    } else if (match[2] === 'cancel') {
      store.cancel(id);
      sendJson(response, 200, { ok: true });
    } else if (match[2] === 'permission') {
      const input = z.object({ id: z.string(), approved: z.boolean() }).parse(body);
      store.respond(id, input.id, input.approved);
      sendJson(response, 200, { ok: true });
    } else if (match[2] === 'inspect') {
      sendJson(response, 200, await store.inspect(id, inspectSchema.parse(body)));
    } else { sendJson(response, 404, { error: '接口不存在' }); }
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (response.headersSent) { response.destroy(); return; }
      const message = error instanceof z.ZodError ? '请求参数无效' :
        error instanceof Error ? error.message : '请求失败';
      sendJson(response, message === '审批已过期' || message === '已有任务正在执行' ? 409 : 400, {
        error: redactSecrets(message, [options.config.apiKey, token]),
      });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4317, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取本地服务端口');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    url: `${origin}/#token=${token}`,
    store,
    /** 中断工具、关闭 SSE 与连接，并清理后台计时器。 */
    async close(): Promise<void> {
      for (const peer of peers) peer.destroy();
      peers.clear();
      await store.close();
      clearTimeout(broadcastTimer);
      clearTimeout(disconnectTimer);
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      clearTimeout(disconnectTimer);
    },
  };
}
