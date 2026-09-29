import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loadConfig.js';
import type { ModelProvider } from '../src/providers/types.js';
import { startWebServer } from '../src/web/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** 启动使用假模型和独立工作区的 HTTP 服务。 */
async function setup(provider: ModelProvider) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-web-'));
  cleanups.push(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, 'README.md'), '# Web test');
  const config = loadConfig({ apiKey: 'private-test-key', workspace }, {});
  const server = await startWebServer({ config, provider, port: 0, token: 'test-web-token' });
  cleanups.push(() => server.close());
  /** 对测试服务发起具备本地访问凭据的 JSON 请求。 */
  async function request(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    return fetch(`${server.origin}${route}`, {
      method, headers: { authorization: 'Bearer test-web-token', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  return { server, request, workspace };
}

/** 等待异步任务的可观测状态，超时输出最后状态。 */
async function waitForState(request: (route: string) => Promise<Response>, predicate: (state: any) => boolean) {
  const deadline = Date.now() + 3000;
  let state: any;
  while (Date.now() < deadline) {
    state = await (await request('/api/state')).json();
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待状态超时：${JSON.stringify(state)}`);
}

/** 从 HTTP 响应中逐个读取 SSE data 事件，保留跨分片余量。 */
function createSseReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  return {
    reader,
    /** 返回下一条 JSON data 事件并跳过心跳。 */
    async read(): Promise<any> {
      while (true) {
        const boundary = pending.indexOf('\n\n');
        if (boundary >= 0) {
          const event = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (event.startsWith('data: ')) return JSON.parse(event.slice(6));
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE 提前结束');
        pending += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

const textProvider: ModelProvider = {
  /** 回复测试文本，包含密钥以验证服务器脱敏。 */
  async chat(_messages, _tools, onText) {
    onText('hello private-');
    onText('test-key');
    return { content: 'hello private-test-key', toolCalls: [] };
  },
  /** 测试不请求计费图片。 */
  async generateImage() { throw new Error('unused'); },
};

it('拒绝未鉴权、跨域和错误 Host 请求，不泄漏配置密钥', async () => {
  const { server, request } = await setup(textProvider);
  expect((await fetch(`${server.origin}/api/state`)).status).toBe(401);
  expect((await fetch(`${server.origin}/api/state`, {
    headers: { authorization: 'Bearer test-web-token', origin: 'https://other.example' },
  })).status).toBe(403);
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = httpRequest(`${server.origin}/api/state`, {
      headers: { authorization: 'Bearer test-web-token', host: 'evil.example' },
    }, (incoming) => { incoming.resume(); resolve(incoming.statusCode); });
    outgoing.on('error', reject);
    outgoing.end();
  });
  expect(hostStatus).toBe(403);
  const state = await (await request('/api/state')).text();
  expect(state).not.toContain('private-test-key');
  expect(state).not.toContain('test-web-token');
});

it('独立会话、流式事件、文件读取和任务结果均经过真实 HTTP 接口', async () => {
  const { request, server } = await setup(textProvider);
  const first = await (await request('/api/sessions', {})).json();
  const second = await (await request('/api/sessions', {})).json();
  const streamController = new AbortController();
  const events = await fetch(`${server.origin}/api/events`, {
    headers: { authorization: 'Bearer test-web-token' }, signal: streamController.signal,
  });
  const eventReader = createSseReader(events);
  expect(await eventReader.read()).toMatchObject({ type: 'state' });
  expect((await request(`/api/sessions/${first.id}/message`, { prompt: 'hello' })).status).toBe(202);
  const update = await eventReader.read();
  expect(update).toMatchObject({ type: 'session', session: { id: first.id } });
  expect(update).not.toHaveProperty('state.sessions');
  streamController.abort();
  await eventReader.reader.cancel().catch(() => {});
  const state = await waitForState(request, (value) => value.sessions.find((item: any) => item.id === first.id)?.messages.length === 2);
  const session = state.sessions.find((item: any) => item.id === first.id);
  expect(session.messages[1].content).toBe('hello [REDACTED]');
  expect(state.sessions.find((item: any) => item.id === second.id).messages).toHaveLength(0);
  const file = await (await request(`/api/sessions/${first.id}/inspect`, { kind: 'file', path: 'README.md' })).json();
  expect(JSON.stringify(file)).toContain('# Web test');
  expect((await request(`/api/sessions/${first.id}/inspect`, { kind: 'runCommand' })).status).toBe(400);
  expect((await request(`/api/sessions/${first.id}/inspect`, { kind: 'file', path: '.env' })).status).toBe(400);
});

it('写入等待批准，拒绝不落盘，过期审批无效，取消后可以继续', async () => {
  const provider: ModelProvider = {
    /** 每个新任务提出补丁，收到工具结果后结束。 */
    async chat(messages) {
      if (messages.at(-1)?.role === 'tool') return { content: 'done', toolCalls: [] };
      return { content: '', toolCalls: [{
        id: 'write-1', name: 'applyPatch',
        arguments: JSON.stringify({ patch: '--- /dev/null\n+++ b/result.txt\n@@ -0,0 +1 @@\n+created\n' }),
      }] };
    },
    generateImage: textProvider.generateImage,
  };
  const { request, workspace } = await setup(provider);
  const { id } = await (await request('/api/sessions', {})).json();
  await request(`/api/sessions/${id}/message`, { prompt: 'write' });
  let state = await waitForState(request, (value) => Boolean(value.sessions[0].permission));
  const rejectedId = state.sessions[0].permission.id;
  expect((await request(`/api/sessions/${id}/permission`, { id: 'stale', approved: true })).status).toBe(409);
  await request(`/api/sessions/${id}/permission`, { id: rejectedId, approved: false });
  await waitForState(request, (value) => !value.sessions[0].busy);
  await expect(readFile(path.join(workspace, 'result.txt'))).rejects.toThrow();
  await request(`/api/sessions/${id}/message`, { prompt: 'write again' });
  state = await waitForState(request, (value) => Boolean(value.sessions[0].permission));
  await request(`/api/sessions/${id}/cancel`, {});
  await waitForState(request, (value) => !value.sessions[0].busy);
  expect((await request(`/api/sessions/${id}/permission`, { id: state.sessions[0].permission.id, approved: true })).status).toBe(409);
  await request(`/api/sessions/${id}/message`, { prompt: 'write approved' });
  state = await waitForState(request, (value) => Boolean(value.sessions[0].permission));
  await request(`/api/sessions/${id}/permission`, { id: state.sessions[0].permission.id, approved: true });
  await waitForState(request, (value) => !value.sessions[0].busy);
  expect(await readFile(path.join(workspace, 'result.txt'), 'utf8')).toBe('created\n');
});

it('完整消息保留与密钥前缀相同的普通结尾', async () => {
  const provider: ModelProvider = {
    /** 返回恰好以密钥前缀结尾的正常文本。 */
    async chat(_messages, _tools, onText) {
      onText('task private-');
      return { content: 'task private-', toolCalls: [] };
    },
    generateImage: textProvider.generateImage,
  };
  const { request } = await setup(provider);
  const { id } = await (await request('/api/sessions', {})).json();
  await request(`/api/sessions/${id}/message`, { prompt: 'prefix' });
  const state = await waitForState(request, (value) => !value.sessions[0].busy && value.sessions[0].messages.length === 2);
  expect(state.sessions[0].messages[1].content).toBe('task private-');
});

it('图片生成失败显示请求失败而不是已完成', async () => {
  const provider: ModelProvider = {
    /** 聊天路径不应在图片快捷命令中调用。 */
    async chat() { throw new Error('unused'); },
    /** 模拟图片服务明确失败。 */
    async generateImage() { throw new Error('image unavailable'); },
  };
  const { request } = await setup(provider);
  const { id } = await (await request('/api/sessions', {})).json();
  await request(`/api/sessions/${id}/message`, { prompt: '/image test' });
  let state = await waitForState(request, (value) => Boolean(value.sessions[0].permission));
  await request(`/api/sessions/${id}/permission`, { id: state.sessions[0].permission.id, approved: true });
  state = await waitForState(request, (value) => !value.sessions[0].busy);
  expect(state.sessions[0].status).toBe('请求失败');
  expect(state.sessions[0].messages.at(-1)).toMatchObject({ role: 'notice' });
  expect(state.sessions[0].tools[0]).toMatchObject({ status: 'error' });
});

it('流式失败只记录未完成提示，不伪造模型历史', async () => {
  const observedMessages: unknown[][] = [];
  let calls = 0;
  const provider: ModelProvider = {
    /** 第一次在输出分片后失败，第二次记录实际模型历史。 */
    async chat(messages, _tools, onText) {
      observedMessages.push(structuredClone(messages));
      if (calls++ === 0) {
        onText('partial');
        throw new Error('stream failed');
      }
      return { content: 'recovered', toolCalls: [] };
    },
    generateImage: textProvider.generateImage,
  };
  const { request } = await setup(provider);
  const { id } = await (await request('/api/sessions', {})).json();
  await request(`/api/sessions/${id}/message`, { prompt: 'first' });
  let state = await waitForState(request, (value) => !value.sessions[0].busy);
  expect(state.sessions[0].messages.map((message: any) => message.role)).toEqual(['user', 'notice']);
  expect(state.sessions[0].messages[1].content).toContain('partial');
  await request(`/api/sessions/${id}/message`, { prompt: 'second' });
  state = await waitForState(request, (value) => !value.sessions[0].busy && value.sessions[0].messages.length === 4);
  expect(state.sessions[0].messages.at(-1).content).toBe('recovered');
  expect(JSON.stringify(observedMessages[1])).not.toContain('partial');
});
