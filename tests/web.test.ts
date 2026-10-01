import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loadConfig.js';
import type { ModelProvider } from '../src/providers/types.js';
import {
  activateSession,
  beginSessionDetailRequest,
  clearActiveSessionIfCurrent,
  mergeCreatedSessionSummary,
  mergeSessionSummary,
  mergeServerStateWithPendingSessions,
  setActiveFromRequest,
  setActiveFromUpdate,
} from '../src/web/activeSession.js';
import type { WebSession, WebState } from '../src/web/types.js';
import { startWebServer } from '../src/web/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** 创建由测试清理的独立 SQLite 数据库路径。 */
async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-web-database-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'agent.db');
}

/** 启动使用假模型和独立工作区的 HTTP 服务。 */
async function setup(provider: ModelProvider, databasePath?: string, existingWorkspace?: string) {
  const workspace = existingWorkspace ?? await mkdtemp(path.join(os.tmpdir(), 'agent-web-'));
  if (!existingWorkspace) {
    cleanups.push(() => rm(workspace, { recursive: true, force: true }));
    await writeFile(path.join(workspace, 'README.md'), '# Web test');
  }
  const targetDatabasePath = databasePath ?? await createDatabasePath();
  const config = loadConfig({
    apiKey: 'private-test-key',
    workspace,
    databasePath: targetDatabasePath,
  }, {});
  const server = await startWebServer({
    config,
    provider,
    port: 0,
    token: 'test-web-token',
    databasePath: targetDatabasePath,
  });
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

/** 等待指定会话详情满足异步任务状态。 */
async function waitForSession(
  request: (route: string) => Promise<Response>,
  id: string,
  predicate: (session: any) => boolean,
) {
  const deadline = Date.now() + 3000;
  let session: any;
  while (Date.now() < deadline) {
    session = await (await request(`/api/sessions/${id}`)).json();
    if (predicate(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待会话超时：${JSON.stringify(session)}`);
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

/** 构造可按需覆盖字段的完整 Web 会话。 */
function buildWebSession(overrides: Partial<WebSession> = {}): WebSession {
  return {
    id: 'new',
    title: '新任务',
    workspace: '/workspace',
    createdAt: 1,
    updatedAt: 2,
    busy: false,
    status: 'idle',
    startedAt: null,
    pendingMemoryCount: 0,
    memoryExtractionStatus: 'idle',
    messages: [],
    response: '',
    tools: [],
    permission: null,
    ...overrides,
  };
}

it('创建详情返回后把显式摘要合并到本地状态', () => {
  const state: WebState = {
    model: 'test-model',
    imageModel: 'test-image-model',
    workspace: '/workspace',
    sessions: [],
  };
  const session = buildWebSession({
    messages: [{ id: 'message', role: 'user', content: 'secret', createdAt: 2 }],
    response: 'response',
  });

  const merged = mergeSessionSummary(state, session);

  expect(merged.sessions).toEqual([{
    id: 'new',
    title: '新任务',
    workspace: '/workspace',
    createdAt: 1,
    updatedAt: 2,
    busy: false,
    status: 'idle',
    startedAt: null,
    pendingMemoryCount: 0,
    memoryExtractionStatus: 'idle',
  }]);
  expect(merged.sessions[0]).not.toHaveProperty('messages');
  expect(merged.sessions[0]).not.toHaveProperty('response');
});

it('仅在服务端确认前保护本地创建的会话摘要', () => {
  const initialState: WebState = {
    model: 'test-model',
    imageModel: 'test-image-model',
    workspace: '/workspace',
    sessions: [],
  };
  const session = buildWebSession({
    title: '本地新任务',
  });
  const pendingCreatedIds = new Set<string>();
  const optimisticState = mergeCreatedSessionSummary(
    initialState,
    session,
    pendingCreatedIds,
  );

  const afterOldState = mergeServerStateWithPendingSessions(
    initialState,
    optimisticState,
    pendingCreatedIds,
  );
  expect(afterOldState.sessions).toEqual(optimisticState.sessions);
  expect(pendingCreatedIds.has('new')).toBe(true);

  const confirmedState: WebState = {
    ...initialState,
    sessions: [{ ...optimisticState.sessions[0], title: '服务端新任务' }],
  };
  const afterConfirmation = mergeServerStateWithPendingSessions(
    confirmedState,
    afterOldState,
    pendingCreatedIds,
  );
  expect(afterConfirmation).toEqual(confirmedState);
  expect(pendingCreatedIds.has('new')).toBe(false);

  const afterDeletion = mergeServerStateWithPendingSessions(
    initialState,
    afterConfirmation,
    pendingCreatedIds,
  );
  expect(afterDeletion).toEqual(initialState);
});

it('服务端已确认的会话不会重新进入创建保护', () => {
  const session = buildWebSession({
    title: '服务端新任务',
  });
  const confirmedState = mergeSessionSummary({
    model: 'test-model',
    imageModel: 'test-image-model',
    workspace: '/workspace',
    sessions: [],
  }, session);
  const pendingCreatedIds = new Set<string>();

  mergeCreatedSessionSummary(confirmedState, session, pendingCreatedIds);

  expect(pendingCreatedIds.size).toBe(0);
});

it('同一会话的较新 GET 和 SSE 更新都会使旧 GET 失效', () => {
  const activeIdRef = { current: 'same' };
  const epochRef = { current: 0 };
  const activeSessions: Array<{ id: string; value: string }> = [];
  const firstRequest = beginSessionDetailRequest('same', epochRef);
  const secondRequest = beginSessionDetailRequest('same', epochRef);

  expect(setActiveFromRequest(
    firstRequest,
    activeIdRef,
    epochRef,
    { id: 'same', value: 'first GET' },
    (current) => activeSessions.push(current),
  )).toBe(false);
  expect(setActiveFromRequest(
    secondRequest,
    activeIdRef,
    epochRef,
    { id: 'same', value: 'second GET' },
    (current) => activeSessions.push(current),
  )).toBe(true);

  const staleRequest = beginSessionDetailRequest('same', epochRef);
  expect(setActiveFromUpdate(
    activeIdRef,
    epochRef,
    { id: 'same', value: 'SSE' },
    (current) => activeSessions.push(current),
  )).toBe(true);
  expect(setActiveFromRequest(
    staleRequest,
    activeIdRef,
    epochRef,
    { id: 'same', value: 'stale GET' },
    (current) => activeSessions.push(current),
  )).toBe(false);

  expect(activeSessions).toEqual([
    { id: 'same', value: 'second GET' },
    { id: 'same', value: 'SSE' },
  ]);
});

it('删除等待期间切换会话不会清空新 active', () => {
  const activeIdRef = { current: '' };
  const epochRef = { current: 0 };
  const activeIds: string[] = [];
  activateSession('A', activeIdRef, epochRef, (id) => activeIds.push(id));

  activateSession('B', activeIdRef, epochRef, (id) => activeIds.push(id));

  expect(clearActiveSessionIfCurrent(
    'A',
    activeIdRef,
    epochRef,
    (id) => activeIds.push(id),
  )).toBe(false);
  expect(activeIdRef.current).toBe('B');
  expect(clearActiveSessionIfCurrent(
    'B',
    activeIdRef,
    epochRef,
    (id) => activeIds.push(id),
  )).toBe(true);
  expect(activeIdRef.current).toBe('');
  expect(activeIds).toEqual(['A', 'B', '']);
});

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

it('同批 full-state 后仍按顺序发送存活会话详情', async () => {
  const provider: ModelProvider = {
    /** 保持任务运行，确保测试只观察同一广播批次。 */
    async chat(_messages, _tools, _onText, signal) {
      return await new Promise((_, reject) => {
        const abort = (): void => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },
    generateImage: textProvider.generateImage,
  };
  const { request, server } = await setup(provider);
  const streamController = new AbortController();
  const events = await fetch(`${server.origin}/api/events`, {
    headers: { authorization: 'Bearer test-web-token' },
    signal: streamController.signal,
  });
  const eventReader = createSseReader(events);
  expect(await eventReader.read()).toMatchObject({ type: 'state' });

  const { id } = await (await request('/api/sessions', {})).json();
  await request(`/api/sessions/${id}/message`, { prompt: '保持运行' });

  try {
    expect(await eventReader.read()).toMatchObject({
      type: 'state',
      state: { sessions: expect.arrayContaining([expect.objectContaining({ id })]) },
    });
    const detail = await Promise.race([
      eventReader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('等待 sessionDetail 超时')), 500);
      }),
    ]);
    expect(detail).toMatchObject({ type: 'sessionDetail', session: { id } });
  } finally {
    streamController.abort();
    await eventReader.reader.cancel().catch(() => {});
  }
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
  expect(update).toMatchObject({ type: 'sessionSummary', session: { id: first.id } });
  expect(update.session).not.toHaveProperty('messages');
  expect(update).not.toHaveProperty('state.sessions');
  streamController.abort();
  await eventReader.reader.cancel().catch(() => {});
  const state = await waitForState(request, (value) =>
    value.sessions.find((item: any) => item.id === first.id)?.status === 'idle');
  expect(state.sessions.find((item: any) => item.id === first.id)).not.toHaveProperty('messages');
  const session = await (await request(`/api/sessions/${first.id}`)).json();
  expect(session.messages[1].content).toBe('hello [REDACTED]');
  expect((await (await request(`/api/sessions/${second.id}`)).json()).messages).toHaveLength(0);
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
  let session = await waitForSession(request, id, (value) => Boolean(value.permission));
  const rejectedId = session.permission.id;
  expect((await request(`/api/sessions/${id}/permission`, { id: 'stale', approved: true })).status).toBe(409);
  await request(`/api/sessions/${id}/permission`, { id: rejectedId, approved: false });
  await waitForState(request, (value) => !value.sessions[0].busy);
  await expect(readFile(path.join(workspace, 'result.txt'))).rejects.toThrow();
  await request(`/api/sessions/${id}/message`, { prompt: 'write again' });
  session = await waitForSession(request, id, (value) => Boolean(value.permission));
  await request(`/api/sessions/${id}/cancel`, {});
  await waitForState(request, (value) => !value.sessions[0].busy);
  expect((await request(`/api/sessions/${id}/permission`, { id: session.permission.id, approved: true })).status).toBe(409);
  await request(`/api/sessions/${id}/message`, { prompt: 'write approved' });
  session = await waitForSession(request, id, (value) => Boolean(value.permission));
  await request(`/api/sessions/${id}/permission`, { id: session.permission.id, approved: true });
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
  await waitForState(request, (value) => !value.sessions[0].busy && value.sessions[0].status === 'idle');
  const session = await (await request(`/api/sessions/${id}`)).json();
  expect(session.messages[1].content).toBe('task private-');
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
  let session = await waitForSession(request, id, (value) => Boolean(value.permission));
  await request(`/api/sessions/${id}/permission`, { id: session.permission.id, approved: true });
  await waitForState(request, (value) => !value.sessions[0].busy);
  session = await (await request(`/api/sessions/${id}`)).json();
  expect(session.status).toBe('failed');
  expect(session.messages.at(-1)).toMatchObject({ role: 'notice' });
  expect(session.tools[0]).toMatchObject({ status: 'error' });
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
  await waitForState(request, (value) => !value.sessions[0].busy);
  let session = await (await request(`/api/sessions/${id}`)).json();
  expect(session.messages.map((message: any) => message.role)).toEqual(['user', 'notice']);
  expect(session.messages[1].content).toContain('stream failed');
  await request(`/api/sessions/${id}/message`, { prompt: 'second' });
  await waitForState(request, (value) => !value.sessions[0].busy && value.sessions[0].status === 'idle');
  session = await (await request(`/api/sessions/${id}`)).json();
  expect(session.messages).toHaveLength(4);
  expect(session.messages.at(-1).content).toBe('recovered');
  expect(JSON.stringify(observedMessages[1])).not.toContain('partial');
});

it('服务重启后保留首轮 prompt 标题并按需恢复会话详情', async () => {
  const databasePath = await createDatabasePath();
  const first = await setup(textProvider, databasePath);
  const { id } = await (await first.request('/api/sessions', {})).json();
  await first.request(`/api/sessions/${id}/message`, { prompt: 'persist me' });
  await waitForState(first.request, (state) =>
    state.sessions.find((item: any) => item.id === id)?.status === 'idle');
  await first.server.close();

  const second = await setup(textProvider, databasePath, first.workspace);
  const state = await (await second.request('/api/state')).json();
  expect(state.sessions.find((item: any) => item.id === id)).toMatchObject({
    title: 'persist me',
  });
  expect(state.sessions.find((item: any) => item.id === id)).not.toHaveProperty('messages');
  const detail = await (await second.request(`/api/sessions/${id}`)).json();
  expect(detail.title).toBe('persist me');
  expect(detail.messages.map((message: any) => message.role)).toEqual(['user', 'assistant']);
});

it('服务重启后恢复其他工作区的 Web 会话', async () => {
  const databasePath = await createDatabasePath();
  const otherWorkspace = await mkdtemp(path.join(os.tmpdir(), 'agent-web-other-'));
  cleanups.push(() => rm(otherWorkspace, { recursive: true, force: true }));
  const first = await setup(textProvider, databasePath);
  const { id } = await (await first.request('/api/sessions', {
    workspace: otherWorkspace,
  })).json();
  await first.request(`/api/sessions/${id}/message`, { prompt: 'other workspace' });
  await waitForState(first.request, (state) =>
    state.sessions.find((item: any) => item.id === id)?.status === 'idle');
  await first.server.close();

  const second = await setup(textProvider, databasePath, first.workspace);
  const state = await (await second.request('/api/state')).json();
  expect(state.sessions.map((session: any) => session.id)).toContain(id);
  const detail = await (await second.request(`/api/sessions/${id}`)).json();
  expect(detail).toMatchObject({ id, workspace: await realpath(otherWorkspace) });
});

it('通过会话作用域接口管理记忆并拒绝跨工作区操作', async () => {
  const otherWorkspace = await mkdtemp(path.join(os.tmpdir(), 'agent-web-memory-other-'));
  cleanups.push(() => rm(otherWorkspace, { recursive: true, force: true }));
  const provider: ModelProvider = {
    /** 普通任务返回固定回答，记忆提取返回两条可确认候选。 */
    async chat(messages) {
      const content = messages[0]?.content;
      if (messages.length === 1 && typeof content === 'string' &&
        content.includes('提取可长期复用的项目记忆')) {
        return {
          content: JSON.stringify({
            candidates: [
              { category: 'rule', content: '使用 React 19' },
              { category: 'preference', content: '保持最小改动' },
              { category: 'fact', content: '运行在 Node.js 22' },
            ],
          }),
          toolCalls: [],
        };
      }
      return { content: '已记录要求', toolCalls: [] };
    },
    generateImage: textProvider.generateImage,
  };
  const { request } = await setup(provider);
  const { id } = await (await request('/api/sessions', {})).json();
  const { id: otherId } = await (await request('/api/sessions', {
    workspace: otherWorkspace,
  })).json();
  await request(`/api/sessions/${id}/message`, { prompt: '记住项目约束' });
  await waitForState(request, (state) =>
    state.sessions.find((session: any) => session.id === id)
      ?.memoryExtractionStatus === 'complete');

  let memoryState = await (await request(`/api/sessions/${id}/memories`)).json();
  expect(memoryState).toMatchObject({
    extractionStatus: 'complete',
    extractionError: null,
    memories: [],
  });
  expect(memoryState.candidates).toEqual(expect.arrayContaining([
    expect.objectContaining({ category: 'rule', content: '使用 React 19' }),
    expect.objectContaining({ category: 'preference', content: '保持最小改动' }),
    expect.objectContaining({ category: 'fact', content: '运行在 Node.js 22' }),
  ]));
  /** 断言无效记忆请求被拒绝，且不会改变当前记忆状态。 */
  async function expectRejectedMemoryRequest(
    name: string,
    route: string,
    body: unknown,
    method: string,
    expectedStatus: 400 | 405,
  ): Promise<void> {
    const before = await (await request(`/api/sessions/${id}/memories`)).json();
    const response = await request(route, body, method);
    expect(response.status, name).toBe(expectedStatus);
    const after = await (await request(`/api/sessions/${id}/memories`)).json();
    expect(after, `${name} 不应改变记忆状态`).toEqual(before);
  }

  for (const invalidMethod of [
    {
      name: 'GET memories',
      route: `/api/sessions/${id}/memories`,
      body: {},
      method: 'POST',
    },
    {
      name: 'retry',
      route: `/api/sessions/${id}/memory-extraction/retry`,
      body: undefined,
      method: 'GET',
    },
  ]) {
    await expectRejectedMemoryRequest(
      invalidMethod.name,
      invalidMethod.route,
      invalidMethod.body,
      invalidMethod.method,
      405,
    );
  }

  const retryResponse = await request(
    `/api/sessions/${id}/memory-extraction/retry`,
    {},
  );
  expect(retryResponse.status).toBe(200);
  expect((await retryResponse.json()).candidates).toHaveLength(3);
  const originalCandidate = memoryState.candidates.find(
    (item: any) => item.category === 'rule',
  );
  const editedCandidate = memoryState.candidates.find(
    (item: any) => item.category === 'preference',
  );
  const ignoredCandidate = memoryState.candidates.find(
    (item: any) => item.category === 'fact',
  );
  for (const invalidCandidateRequest of [
    {
      name: 'candidate 错误方法',
      body: { action: 'accept' },
      method: 'POST',
      expectedStatus: 405 as const,
    },
    {
      name: 'accept 空白内容',
      body: { action: 'accept', content: '   ' },
      method: 'PATCH',
      expectedStatus: 400 as const,
    },
    {
      name: 'accept 超长内容',
      body: { action: 'accept', content: 'x'.repeat(1001) },
      method: 'PATCH',
      expectedStatus: 400 as const,
    },
    {
      name: 'accept 额外字段',
      body: { action: 'accept', extra: true },
      method: 'PATCH',
      expectedStatus: 400 as const,
    },
    {
      name: 'ignore 非法字段',
      body: { action: 'ignore', content: '不应接受' },
      method: 'PATCH',
      expectedStatus: 400 as const,
    },
  ]) {
    await expectRejectedMemoryRequest(
      invalidCandidateRequest.name,
      `/api/sessions/${id}/memory-candidates/${originalCandidate.id}`,
      invalidCandidateRequest.body,
      invalidCandidateRequest.method,
      invalidCandidateRequest.expectedStatus,
    );
  }
  expect((await request(
    `/api/sessions/${otherId}/memory-candidates/${originalCandidate.id}`,
    { action: 'accept' },
    'PATCH',
  )).status).toBe(400);

  expect((await request(
    `/api/sessions/${id}/memory-candidates/${ignoredCandidate.id}`,
    { action: 'ignore' },
    'PATCH',
  )).status).toBe(200);
  expect((await request(
    `/api/sessions/${id}/memory-candidates/${originalCandidate.id}`,
    { action: 'accept' },
    'PATCH',
  )).status).toBe(200);
  expect((await request(
    `/api/sessions/${id}/memory-candidates/${editedCandidate.id}`,
    { action: 'accept', content: '  偏好 minimal diff  ' },
    'PATCH',
  )).status).toBe(200);

  memoryState = await (await request(`/api/sessions/${id}/memories`)).json();
  expect(memoryState.candidates).toEqual([]);
  expect(memoryState.memories).toEqual(expect.arrayContaining([
    expect.objectContaining({ category: 'rule', content: '使用 React 19', active: true }),
    expect.objectContaining({ category: 'preference', content: '偏好 minimal diff', active: true }),
  ]));
  const memory = memoryState.memories.find((item: any) => item.category === 'preference');

  for (const invalidMemoryRequest of [
    {
      name: 'memory patch 空对象',
      body: {},
      method: 'PATCH',
      expectedStatus: 400 as const,
    },
    {
      name: 'memory patch 额外字段',
      body: { active: true, extra: true },
      method: 'PATCH',
      expectedStatus: 400 as const,
    },
    {
      name: 'memory patch 空白内容',
      body: { content: '   ' },
      method: 'PATCH',
      expectedStatus: 400 as const,
    },
    {
      name: 'memory patch 超长内容',
      body: { content: 'x'.repeat(1001) },
      method: 'PATCH',
      expectedStatus: 400 as const,
    },
    {
      name: 'memory patch 非 boolean active',
      body: { active: 'false' },
      method: 'PATCH',
      expectedStatus: 400 as const,
    },
    {
      name: 'memory item 错误方法',
      body: {},
      method: 'POST',
      expectedStatus: 405 as const,
    },
  ]) {
    await expectRejectedMemoryRequest(
      invalidMemoryRequest.name,
      `/api/sessions/${id}/memories/${memory.id}`,
      invalidMemoryRequest.body,
      invalidMemoryRequest.method,
      invalidMemoryRequest.expectedStatus,
    );
  }
  expect((await request(
    `/api/sessions/${otherId}/memories/${memory.id}`,
    { content: '越权修改' },
    'PATCH',
  )).status).toBe(400);
  expect((await request(
    `/api/sessions/${otherId}/memories/${memory.id}`,
    undefined,
    'DELETE',
  )).status).toBe(400);
  expect((await request(
    `/api/sessions/${id}/memories/${memory.id}`,
    { content: '  只做必要修改  ' },
    'PATCH',
  )).status).toBe(200);
  expect((await request(
    `/api/sessions/${id}/memories/${memory.id}`,
    { active: false },
    'PATCH',
  )).status).toBe(200);
  memoryState = await (await request(`/api/sessions/${id}/memories`)).json();
  expect(memoryState.memories).toContainEqual(expect.objectContaining({
    id: memory.id,
    content: '只做必要修改',
    active: false,
  }));

  expect((await request(
    `/api/sessions/${id}/memories/${memory.id}`,
    { active: true },
    'PATCH',
  )).status).toBe(200);
  expect((await request(
    `/api/sessions/${id}/memories/${memory.id}`,
    undefined,
    'DELETE',
  )).status).toBe(200);
  memoryState = await (await request(`/api/sessions/${id}/memories`)).json();
  expect(memoryState.memories).not.toContainEqual(expect.objectContaining({ id: memory.id }));
});
