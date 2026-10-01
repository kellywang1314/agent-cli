import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { expect, it } from 'vitest';
import { AgentLoop } from '../src/agent/AgentLoop.js';
import { loadConfig, redactSecrets } from '../src/config/loadConfig.js';
import { MemoryService } from '../src/memory/MemoryService.js';
import { PersistenceStore } from '../src/persistence/PersistenceStore.js';
import { AidpProvider } from '../src/providers/AidpProvider.js';
import type { ModelProvider } from '../src/providers/types.js';
import { SessionService } from '../src/sessions/SessionService.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import type { PermissionRequest } from '../src/tools/types.js';

/** 创建无 UI 副作用且默认批准工具的会话 Hook。 */
function createSessionHooks() {
  return {
    onAgentEvent: () => {},
    onDisplayMessage: () => {},
    onStatus: () => {},
    confirm: async () => true,
  };
}

it('本地 HTTP 网关贯通真实读取、补丁确认、Shell 执行与最终回答', async () => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-integration-')));
  const requests: Record<string, unknown>[] = [];
  const approvals: PermissionRequest[] = [];
  const calls = [
    { name: 'readFile', arguments: JSON.stringify({ path: 'note.txt' }) },
    { name: 'applyPatch', arguments: JSON.stringify({ patch: '--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-old\n+new\n' }) },
    { name: 'runCommand', arguments: JSON.stringify({ command: 'cat note.txt' }) },
  ];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const index = requests.length - 1;
    const call = calls[index];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = call
      ? { tool_calls: [{ index: 0, id: `tool-${index}`, type: 'function', function: call }] }
      : { content: '修改和检查已完成' };
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  try {
    await writeFile(path.join(workspace, 'note.txt'), 'old\n');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无端口');
    const provider = new AidpProvider(loadConfig({ apiKey: 'test-key', chatUrl: `http://127.0.0.1:${address.port}/chat` }, {}));
    const agent = new AgentLoop(provider, new ToolRegistry(), { systemPrompt: 'test', maxRounds: 5 });
    const result = await agent.run('把 old 改为 new 并检查', {
      workspace, provider, signal: new AbortController().signal,
      /** 测试收集每次真实副作用前的确认请求。 */
      confirm: async (request) => { approvals.push(request); return true; },
    });
    expect(result).toBe('修改和检查已完成');
    expect(await readFile(path.join(workspace, 'note.txt'), 'utf8')).toBe('new\n');
    expect(approvals.map((request) => request.title)).toEqual(['应用补丁：note.txt', '执行 Shell 命令']);
    expect(requests).toHaveLength(4);
    expect(requests[0].tools).toHaveLength(7);
    expect(JSON.stringify(requests[3].messages)).toContain('new\\\\n');
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

it('跨进程式重开数据库后恢复会话并只注入已确认记忆', async () => {
  const workspace = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'agent-memory-integration-')),
  );
  const databasePath = path.join(workspace, 'agent.db');
  const config = loadConfig({
    apiKey: 'integration-key',
    workspace,
    databasePath,
  }, {});
  const providerSnapshots: ChatCompletionMessageParam[][] = [];
  let taskCalls = 0;
  const provider: ModelProvider = {
    /** 为主任务返回文本，为记忆提取返回严格 JSON。 */
    async chat(messages, _tools, onText) {
      if (String(messages[0]?.content).includes('提取可长期复用的项目记忆')) {
        return {
          content: '{"candidates":[{"category":"decision","content":"项目使用 SQLite。"}]}',
          toolCalls: [],
        };
      }
      providerSnapshots.push(structuredClone(messages));
      const content = `第 ${++taskCalls} 次完成`;
      onText(content);
      return { content, toolCalls: [] };
    },
    /** 集成测试不允许触发图片生成。 */
    async generateImage() {
      throw new Error('不应生成图片');
    },
  };
  let firstStore: PersistenceStore | undefined;
  let secondStore: PersistenceStore | undefined;

  try {
    firstStore = new PersistenceStore(databasePath);
    const firstMemories = new MemoryService(firstStore, provider, (value) => value);
    const firstSessions = new SessionService(
      config,
      provider,
      new ToolRegistry(),
      firstStore,
      firstMemories,
      (value) => value,
    );
    const sessionId = await firstSessions.create('cli', workspace);
    const firstResult = await firstSessions.run(
      sessionId,
      '记住项目存储方案',
      createSessionHooks(),
      new AbortController().signal,
    );
    const [candidate] = await firstResult.memoryExtraction!;
    expect(candidate).toBeDefined();
    const pendingResult = await firstSessions.run(
      sessionId,
      '确认前继续',
      createSessionHooks(),
      new AbortController().signal,
    );
    await pendingResult.memoryExtraction;
    expect(JSON.stringify(providerSnapshots.at(-1))).not.toContain('项目使用 SQLite。');
    await firstMemories.resolveCandidate(sessionId, candidate!.id, { action: 'accept' });
    await firstSessions.close();
    firstStore.close();
    firstStore = undefined;

    secondStore = new PersistenceStore(databasePath);
    secondStore.recoverInterruptedWork();
    const secondMemories = new MemoryService(secondStore, provider, (value) => value);
    const secondSessions = new SessionService(
      config,
      provider,
      new ToolRegistry(),
      secondStore,
      secondMemories,
      (value) => value,
    );
    const restored = secondSessions.load(sessionId);
    expect(restored.messages.map((item) => item.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    const secondResult = await secondSessions.run(
      sessionId,
      '继续',
      createSessionHooks(),
      new AbortController().signal,
    );
    await secondResult.memoryExtraction;
    const latestRequest = JSON.stringify(providerSnapshots.at(-1));
    expect(latestRequest).toContain('当前工作区已确认的项目记忆');
    expect(latestRequest).toContain('项目使用 SQLite。');
    await secondSessions.close();
    secondStore.close();
    secondStore = undefined;
  } finally {
    firstStore?.close();
    secondStore?.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

it('数据库仅保存脱敏消息且候选拒绝疑似密钥', async () => {
  const workspace = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'agent-secret-integration-')),
  );
  const databasePath = path.join(workspace, 'agent.db');
  const config = loadConfig({
    apiKey: 'test-secret-token-123456',
    workspace,
    databasePath,
  }, {});
  let providerPrompt = '';
  const provider: ModelProvider = {
    /** 主任务回显原始输入，提取请求返回普通候选。 */
    async chat(messages, _tools, onText) {
      if (String(messages[0]?.content).includes('提取可长期复用的项目记忆')) {
        return {
          content: '{"candidates":[{"category":"fact","content":"普通候选"}]}',
          toolCalls: [],
        };
      }
      const content = String(messages.at(-1)?.content);
      providerPrompt = content;
      onText(content);
      return { content, toolCalls: [] };
    },
    /** 集成测试不允许触发图片生成。 */
    async generateImage() {
      throw new Error('不应生成图片');
    },
  };
  const store = new PersistenceStore(databasePath);
  const sanitize = (value: string) => redactSecrets(value, [config.apiKey]);
  const memoryService = new MemoryService(store, provider, sanitize);
  const service = new SessionService(
    config,
    provider,
    new ToolRegistry(),
    store,
    memoryService,
    sanitize,
  );

  try {
    const sessionId = await service.create('cli', workspace);
    const result = await service.run(
      sessionId,
      'Bearer test-secret-token-123456',
      createSessionHooks(),
      new AbortController().signal,
    );
    const [candidate] = await result.memoryExtraction!;
    expect(candidate).toBeDefined();
    expect(providerPrompt).toBe('Bearer test-secret-token-123456');
    expect(result.content).toBe('Bearer [REDACTED]');
    expect(JSON.stringify(store.loadAgentMessages(sessionId)))
      .not.toContain('test-secret-token-123456');
    await expect(memoryService.resolveCandidate(sessionId, candidate!.id, {
      action: 'accept',
      content: 'sk-abcdefghijklmnopqrstuvwxyz012345',
    })).rejects.toThrow('敏感信息');
    await service.close();
  } finally {
    await service.close();
    store.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
