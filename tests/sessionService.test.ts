import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/loadConfig.js';
import { MemoryService } from '../src/memory/MemoryService.js';
import { PersistenceStore } from '../src/persistence/PersistenceStore.js';
import type { ChatReply, ModelProvider } from '../src/providers/types.js';
import { SessionService } from '../src/sessions/SessionService.js';
import type { ToolExecutor } from '../src/agent/AgentLoop.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 创建可区分主任务和记忆提取请求的测试 Provider。 */
function createSessionProvider(
  onTask: ModelProvider['chat'],
): ModelProvider {
  return {
    async chat(messages, tools, onText, signal) {
      if (
        String(messages[0]?.content).includes('提取长期项目记忆') ||
        String(messages[0]?.content).includes('提取可长期复用的项目记忆')
      ) {
        return { content: '{"candidates":[]}', toolCalls: [] };
      }
      return onTask(messages, tools, onText, signal);
    },
    async generateImage() { return Buffer.from('image'); },
  };
}

/** 创建真实临时数据库、工作区和共享服务。 */
async function setupSessionTest(provider: ModelProvider, tools: ToolExecutor) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-session-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({
    apiKey: 'test-key',
    workspace: directory,
    databasePath: path.join(directory, 'agent.db'),
  }, {});
  const store = new PersistenceStore(config.databasePath);
  cleanups.push(async () => store.close());
  const memoryService = new MemoryService(store, provider, (value) => value);
  const service = new SessionService(config, provider, tools, store, memoryService, (value) => value);
  const sessionId = await service.create('web', directory);
  const hooks = {
    onAgentEvent: () => {},
    onDisplayMessage: () => {},
    onStatus: () => {},
    confirm: async () => true,
  };
  return { store, service, memoryService, sessionId, hooks, directory };
}

it('先持久化用户消息再调用模型，并在完成后启动记忆提取', async () => {
  const order: string[] = [];
  const provider = createSessionProvider(async (messages) => {
    order.push('model');
    expect(store.loadDisplayMessages(sessionId)).toHaveLength(1);
    expect(store.loadAgentMessages(sessionId).at(-1)).toEqual({ role: 'user', content: '任务' });
    return { content: '完成', toolCalls: [] };
  });
  const tools: ToolExecutor = { getDefinitions: () => [], execute: async () => 'ok' };
  const { store, service, sessionId, hooks } = await setupSessionTest(provider, tools);
  const beginTurn = store.beginTurn.bind(store);
  vi.spyOn(store, 'beginTurn').mockImplementation((...args) => {
    order.push('persist');
    beginTurn(...args);
  });
  const result = await service.run(sessionId, '任务', hooks, new AbortController().signal);
  expect(result.content).toBe('完成');
  expect(order[0]).toBe('persist');
  await expect(result.memoryExtraction).resolves.toEqual([]);
});

it('工具声明在执行前落库，工具结果写入失败时不请求下一轮', async () => {
  const order: string[] = [];
  let providerCallCount = 0;
  const provider = createSessionProvider(async () => {
    providerCallCount++;
    return {
      content: '',
      toolCalls: [{ id: 'call-1', name: 'testTool', arguments: '{}' }],
    };
  });
  const tools: ToolExecutor = {
    getDefinitions: () => [],
    execute: async () => { order.push('execute-tool'); return 'done'; },
  };
  const { store, service, sessionId, hooks } = await setupSessionTest(provider, tools);
  const append = store.appendAgentMessages.bind(store);
  let appendCount = 0;
  vi.spyOn(store, 'appendAgentMessages').mockImplementation((id, messages) => {
    appendCount++;
    order.push(appendCount === 1 ? 'persist-assistant' : 'persist-tool');
    if (appendCount === 2) throw new Error('数据库写入失败');
    append(id, messages);
  });
  await expect(service.run(
    sessionId, '任务', hooks, new AbortController().signal,
  )).rejects.toThrow('数据库写入失败');
  expect(order).toEqual(['persist-assistant', 'execute-tool', 'persist-tool']);
  expect(providerCallCount).toBe(1);
});

it('图片任务只写显示消息且不触发记忆提取', async () => {
  const provider = createSessionProvider(async () => {
    throw new Error('图片任务不应调用聊天接口');
  });
  const tools: ToolExecutor = {
    getDefinitions: () => [],
    execute: async (name) => ({ path: name === 'generateImage' ? 'generated/test.png' : '' }),
  };
  const { store, service, sessionId, hooks } = await setupSessionTest(provider, tools);
  const result = await service.run(
    sessionId, '/image test', hooks, new AbortController().signal,
  );
  expect(store.loadAgentMessages(sessionId)).toEqual([]);
  expect(result.memoryExtraction).toBeNull();
});

it('创建会话时持久化真实目录并且不限制为二十条', async () => {
  const provider = createSessionProvider(async () => ({ content: 'ok', toolCalls: [] }));
  const tools: ToolExecutor = { getDefinitions: () => [], execute: async () => 'ok' };
  const { service, directory } = await setupSessionTest(provider, tools);
  const linkedDirectory = path.join(path.dirname(directory), `${path.basename(directory)}-link`);
  await symlink(directory, linkedDirectory);
  cleanups.push(() => rm(linkedDirectory, { force: true }));

  const linkedSessionId = await service.create('cli', linkedDirectory);
  for (let index = 0; index < 20; index++) await service.create('web', directory);

  expect(service.load(linkedSessionId).workspace).toBe(await realpath(directory));
  expect(service.list()).toHaveLength(22);
  expect(service.list({ clientType: 'cli' }).map(({ id }) => id)).toEqual([linkedSessionId]);
});

it('拒绝以普通文件作为会话工作区', async () => {
  const provider = createSessionProvider(async () => ({ content: 'ok', toolCalls: [] }));
  const tools: ToolExecutor = { getDefinitions: () => [], execute: async () => 'ok' };
  const { service, directory } = await setupSessionTest(provider, tools);
  const filePath = path.join(directory, 'file.txt');
  await writeFile(filePath, 'content');

  await expect(service.create('web', filePath)).rejects.toThrow('工作区必须是目录');
});

it('恢复历史、注入动态记忆并传递正确工具上下文', async () => {
  const requests: Array<Parameters<ModelProvider['chat']>[0]> = [];
  let taskCall = 0;
  const provider = createSessionProvider(async (messages) => {
    requests.push(messages);
    taskCall++;
    if (taskCall === 1) {
      return {
        content: '',
        toolCalls: [{ id: 'call-1', name: 'testTool', arguments: '{"value":1}' }],
      };
    }
    return { content: taskCall === 2 ? '第一轮完成' : '第二轮完成', toolCalls: [] };
  });
  const contexts: Array<Parameters<ToolExecutor['execute']>[2]> = [];
  const tools: ToolExecutor = {
    getDefinitions: () => [],
    execute: async (_name, _input, context) => {
      contexts.push(context);
      return { value: 'result' };
    },
  };
  const { service, memoryService, sessionId, hooks, directory } =
    await setupSessionTest(provider, tools);
  vi.spyOn(memoryService, 'buildRuntimeInstructions').mockResolvedValue('动态记忆');

  await (await service.run(sessionId, '第一轮', hooks, new AbortController().signal)).memoryExtraction;
  const signal = new AbortController().signal;
  await service.run(sessionId, '第二轮', hooks, signal);

  expect(requests[0]?.[1]).toEqual({ role: 'system', content: '动态记忆' });
  expect(requests.at(-1)).toContainEqual({ role: 'user', content: '第一轮' });
  expect(requests.at(-1)).toContainEqual({ role: 'assistant', content: '第一轮完成' });
  expect(contexts[0]).toMatchObject({
    workspace: await realpath(directory),
    provider,
    signal: expect.any(AbortSignal),
  });
  await expect(contexts[0]?.confirm(
    { title: '确认', detail: '详情' },
    contexts[0].signal,
  )).resolves.toBe(true);
});

it('提取输入只包含当前轮新增工具结果并使用独立取消信号', async () => {
  const replies: ChatReply[] = [
    {
      content: '',
      toolCalls: [{ id: 'call-1', name: 'testTool', arguments: '{}' }],
    },
    { content: '完成', toolCalls: [] },
  ];
  const provider = createSessionProvider(async () => replies.shift()!);
  const tools: ToolExecutor = {
    getDefinitions: () => [],
    execute: async () => ({ result: '工具结果' }),
  };
  const { service, memoryService, sessionId, hooks } = await setupSessionTest(provider, tools);
  const extraction = vi.spyOn(memoryService, 'extractTurn').mockResolvedValue([]);
  const runController = new AbortController();

  const result = await service.run(sessionId, '任务', hooks, runController.signal);
  await result.memoryExtraction;

  expect(extraction).toHaveBeenCalledWith(expect.objectContaining({
    sessionId,
    sourceTurn: 1,
    userPrompt: '任务',
    assistantResponse: '完成',
    toolResults: ['{"result":"工具结果"}'],
    signal: expect.any(AbortSignal),
  }));
  expect(extraction.mock.calls[0]?.[0].signal).not.toBe(runController.signal);
});

it('失败和取消时写入 notice、更新状态并继续抛出原始错误', async () => {
  const provider = createSessionProvider(async (_messages, _tools, _onText, signal) => {
    signal.throwIfAborted();
    throw new Error('模型失败');
  });
  const tools: ToolExecutor = { getDefinitions: () => [], execute: async () => 'ok' };
  const failed = await setupSessionTest(provider, tools);
  const failedStatuses: string[] = [];

  await expect(failed.service.run(
    failed.sessionId,
    '任务',
    { ...failed.hooks, onStatus: (status) => failedStatuses.push(status) },
    new AbortController().signal,
  )).rejects.toThrow('模型失败');
  expect(failed.store.getSession(failed.sessionId).status).toBe('failed');
  expect(failed.store.loadDisplayMessages(failed.sessionId).at(-1)?.role).toBe('notice');
  expect(failedStatuses).toContain('failed');

  const cancelled = await setupSessionTest(provider, tools);
  const controller = new AbortController();
  controller.abort(new Error('主动取消'));
  await expect(cancelled.service.run(
    cancelled.sessionId, '任务', cancelled.hooks, controller.signal,
  )).rejects.toThrow();
  expect(cancelled.store.getSession(cancelled.sessionId).status).toBe('interrupted');
  expect(cancelled.store.loadDisplayMessages(cancelled.sessionId).at(-1)?.role).toBe('notice');
});

it('同一会话运行期间拒绝并发执行和删除，并在结束后释放', async () => {
  let finish!: (reply: ChatReply) => void;
  const provider = createSessionProvider(() => new Promise<ChatReply>((resolve) => {
    finish = resolve;
  }));
  const tools: ToolExecutor = { getDefinitions: () => [], execute: async () => 'ok' };
  const { service, sessionId, hooks } = await setupSessionTest(provider, tools);

  const firstRun = service.run(sessionId, '任务', hooks, new AbortController().signal);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await expect(service.run(
    sessionId, '并发任务', hooks, new AbortController().signal,
  )).rejects.toThrow('已有任务正在执行');
  expect(() => service.remove(sessionId)).toThrow('请先停止正在执行的任务');
  finish({ content: '完成', toolCalls: [] });
  await firstRun;
  expect(() => service.remove(sessionId)).not.toThrow();
});

it('重试时使用最后一轮已持久化内容并由 close 等待提取任务', async () => {
  const provider = createSessionProvider(async () => ({ content: '完成', toolCalls: [] }));
  const tools: ToolExecutor = { getDefinitions: () => [], execute: async () => 'ok' };
  const { service, memoryService, sessionId, hooks } = await setupSessionTest(provider, tools);
  await (await service.run(sessionId, '第一轮', hooks, new AbortController().signal)).memoryExtraction;
  let finishExtraction!: () => void;
  const extraction = vi.spyOn(memoryService, 'extractTurn').mockImplementation(async () => {
    await new Promise<void>((resolve) => { finishExtraction = resolve; });
    return [];
  });

  const retry = service.retryMemoryExtraction(sessionId, new AbortController().signal);
  await vi.waitFor(() => expect(finishExtraction).toBeTypeOf('function'));
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(extraction).toHaveBeenCalledWith(expect.objectContaining({
    sessionId,
    sourceTurn: 1,
    userPrompt: '第一轮',
    assistantResponse: '完成',
    toolResults: [],
  }));
  finishExtraction();
  await expect(retry).resolves.toEqual([]);
  await closing;
  expect(closed).toBe(true);
});
