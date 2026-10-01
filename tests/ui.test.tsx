import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { loadConfig } from '../src/config/loadConfig.js';
import { MemoryService } from '../src/memory/MemoryService.js';
import { PersistenceStore } from '../src/persistence/PersistenceStore.js';
import type { ModelProvider } from '../src/providers/types.js';
import { SessionService } from '../src/sessions/SessionService.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  cleanup();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});

/** 使用无网络 Provider，测试终端真实输入事件和 UI 状态。 */
function createProvider(): ModelProvider {
  return {
    /** 返回一条可见的流式回答。 */
    async chat(messages, _tools, onText) {
      if (String(messages[0]?.content).includes('提取可长期复用的项目记忆')) {
        return { content: '{"candidates":[]}', toolCalls: [] };
      }
      onText('你好，已收到');
      return { content: '你好，已收到', toolCalls: [] };
    },
    /** 图片确认拒绝时不应执行本方法。 */
    async generateImage() { throw new Error('不应生成图片'); },
  };
}

/** 创建 CLI 使用的真实临时会话服务。 */
async function setupCliTest(provider: ModelProvider = createProvider()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-cli-ui-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({
    apiKey: 'test-key',
    workspace: await realpath(directory),
    databasePath: path.join(directory, 'agent.db'),
  }, {});
  const store = new PersistenceStore(config.databasePath);
  const memoryService = new MemoryService(store, provider, (value) => value);
  const sessionService = new SessionService(
    config,
    provider,
    new ToolRegistry(),
    store,
    memoryService,
    (value) => value,
  );
  cleanups.push(async () => {
    await sessionService.close();
    store.close();
  });
  return { config, store, memoryService, sessionService };
}

/** 渲染使用共享服务的 CLI，并等待会话初始化完成。 */
async function renderCli(provider: ModelProvider = createProvider()) {
  const services = await setupCliTest(provider);
  const view = render(<App
    config={services.config}
    sessionService={services.sessionService}
    memoryService={services.memoryService}
  />);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('Agent CLI'));
  await vi.waitFor(() => expect(view.lastFrame()).toContain('❯'));
  return { ...services, view };
}

/** 等待 Ink 消费输入后，再发送回车以模拟真实终端。 */
async function submit(view: ReturnType<typeof render>, text: string) {
  view.stdin.write(text);
  await vi.waitFor(() => expect(view.lastFrame()).toContain(`❯ ${text}`));
  view.stdin.write('\r');
  await vi.waitFor(() => expect(view.lastFrame()).not.toContain(`❯ ${text}`));
}

/** 向持久化会话写入一轮已完成对话。 */
async function runCompletedTurn(
  sessionService: SessionService,
  sessionId: string,
  prompt: string,
): Promise<void> {
  const result = await sessionService.run(sessionId, prompt, {
    onAgentEvent: () => {},
    onDisplayMessage: () => {},
    onStatus: () => {},
    confirm: async () => true,
  }, new AbortController().signal);
  await result.memoryExtraction;
}

it('展示帮助、提交对话并清空历史', async () => {
  const { view } = await renderCli();
  await submit(view, '/help');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('/image'));
  await submit(view, '测试会话');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('你好，已收到'));
  await submit(view, '/clear');
  await vi.waitFor(() => expect(view.lastFrame()).not.toContain('你好，已收到'));
});

it('图片操作显示确认，按 n 拒绝后恢复输入', async () => {
  const { view } = await renderCli();
  await submit(view, '/image 一只小猫');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('y/N'));
  view.stdin.write('n');
  await vi.waitFor(() => expect(view.lastFrame()).not.toContain('y/N'));
  await vi.waitFor(() => expect(view.lastFrame()).toContain('就绪'));
});

it('Ctrl+C 取消等待中的模型请求后可以开始新任务', async () => {
  let requestCount = 0;
  const provider = createProvider();
  provider.chat = async (_messages, _tools, onText, signal) => {
    requestCount++;
    if (requestCount === 1) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    onText('重新执行成功');
    return { content: '重新执行成功', toolCalls: [] };
  };
  const { view } = await renderCli(provider);
  await submit(view, '等待模型');
  await vi.waitFor(() => expect(requestCount).toBe(1));
  view.stdin.write('\u0003');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('任务已中断'));
  await submit(view, '再次执行');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('重新执行成功'));
});

it('密钥分片和取消过程均不向终端发送密钥前缀', async () => {
  const secret = 'synthetic-private-key';
  const prefix = secret.slice(0, -1);
  const provider = createProvider();
  provider.chat = async (_messages, _tools, onText, signal) => {
    onText(`输出开始 ${prefix}`);
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    throw new Error('已取消');
  };
  const services = await setupCliTest(provider);
  services.config.apiKey = secret;
  const view = render(<App config={services.config}
    sessionService={services.sessionService}
    memoryService={services.memoryService} />);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('❯'));
  await submit(view, '开始输出');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('输出开始'));
  expect(view.frames.join('')).not.toContain(prefix);
  view.stdin.write('\u0003');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('任务已中断'));
  expect(view.frames.join('')).not.toContain(prefix);
});

it('启动恢复最近 CLI 会话并通过 clear 创建新会话', async () => {
  const { config, sessionService, memoryService } = await setupCliTest();
  const firstId = await sessionService.create('cli', config.workspace);
  await runCompletedTurn(sessionService, firstId, '旧问题');
  const view = render(<App
    config={config}
    sessionService={sessionService}
    memoryService={memoryService}
  />);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('已恢复'));
  expect(view.lastFrame()).toContain('旧问题');
  await submit(view, '/clear');
  await vi.waitFor(() => expect(view.lastFrame()).not.toContain('旧问题'));
  expect(sessionService.list({
    workspace: config.workspace,
    clientType: 'cli',
  })).toHaveLength(2);
});

it('列出、恢复和删除空闲 CLI 会话', async () => {
  const { config, sessionService, memoryService } = await setupCliTest();
  const firstId = await sessionService.create('cli', config.workspace);
  const secondId = await sessionService.create('cli', config.workspace);
  const view = render(<App
    config={config}
    sessionService={sessionService}
    memoryService={memoryService}
  />);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('❯'));
  await submit(view, '/sessions');
  await vi.waitFor(() => expect(view.lastFrame()).toContain(firstId.slice(0, 8)));
  await submit(view, `/resume ${firstId}`);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('已恢复会话'));
  await submit(view, `/delete-session ${secondId}`);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('已删除会话'));
  expect(sessionService.list({
    workspace: config.workspace,
    clientType: 'cli',
  }).map(({ id }) => id)).not.toContain(secondId);
});
