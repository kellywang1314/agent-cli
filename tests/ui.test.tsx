import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { loadConfig } from '../src/config/loadConfig.js';
import type { ModelProvider } from '../src/providers/types.js';

afterEach(cleanup);

/** 使用无网络 Provider，测试终端真实输入事件和 UI 状态。 */
function createProvider(): ModelProvider {
  return {
    /** 返回一条可见的流式回答。 */
    async chat(_messages, _tools, onText) {
      onText('你好，已收到');
      return { content: '你好，已收到', toolCalls: [] };
    },
    /** 图片确认拒绝时不应执行本方法。 */
    async generateImage() { throw new Error('不应生成图片'); },
  };
}

/** 等待 Ink 消费输入后，再发送回车以模拟真实终端。 */
async function submit(view: ReturnType<typeof render>, text: string) {
  view.stdin.write(text);
  await vi.waitFor(() => expect(view.lastFrame()).toContain(`❯ ${text}`));
  view.stdin.write('\r');
}

it('展示帮助、提交对话并清空历史', async () => {
  const config = loadConfig({ apiKey: 'test-key' }, {});
  const view = render(<App config={config} provider={createProvider()} systemPrompt="test" />);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('Agent CLI'));
  await submit(view, '/help');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('/image'));
  await submit(view, '测试会话');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('你好，已收到'));
  await submit(view, '/clear');
  await vi.waitFor(() => expect(view.lastFrame()).not.toContain('你好，已收到'));
});

it('图片操作显示确认，按 n 拒绝后恢复输入', async () => {
  const config = loadConfig({ apiKey: 'test-key' }, {});
  const view = render(<App config={config} provider={createProvider()} systemPrompt="test" />);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('Agent CLI'));
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
  const view = render(<App config={loadConfig({ apiKey: 'test-key' }, {})} provider={provider} systemPrompt="test" />);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('Agent CLI'));
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
  const view = render(<App config={loadConfig({ apiKey: secret }, {})} provider={provider} systemPrompt="test" />);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('Agent CLI'));
  await submit(view, '开始输出');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('输出开始'));
  expect(view.frames.join('')).not.toContain(prefix);
  view.stdin.write('\u0003');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('任务已中断'));
  expect(view.frames.join('')).not.toContain(prefix);
});
