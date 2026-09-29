import { describe, expect, it } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { AgentLoop, type ToolExecutor } from '../src/agent/AgentLoop.js';
import type { ChatReply, ModelProvider } from '../src/providers/types.js';
import type { ToolContext } from '../src/tools/types.js';

/** 创建脚本化模型，在网络边界替换外部依赖。 */
function createProvider(replies: ChatReply[], snapshots: ChatCompletionMessageParam[][] = []): ModelProvider {
  return {
    /** 按顺序回答并捕获模型实际收到的历史。 */
    async chat(messages, _tools, onText, signal) {
      signal.throwIfAborted();
      snapshots.push(structuredClone(messages));
      const reply = replies.shift();
      if (!reply) throw new Error('没有后续响应');
      onText(reply.content);
      return reply;
    },
    /** 测试不调用图片接口。 */
    async generateImage() { return Buffer.from('image'); },
  };
}

/** 提供工具执行器，真实验证 Agent 是否把执行结果回传。 */
function createExecutor(execute: ToolExecutor['execute']): ToolExecutor {
  return { getDefinitions: () => [], execute };
}

/** 为每个任务构造独立取消信号和权限上下文。 */
function createContext(provider: ModelProvider, signal = new AbortController().signal): ToolContext {
  return { workspace: process.cwd(), signal, confirm: async () => false, provider };
}

describe('AgentLoop', () => {
  it('执行工具并把结果送入下一轮，持续保留会话上下文', async () => {
    const snapshots: ChatCompletionMessageParam[][] = [];
    const provider = createProvider([
      { content: '', toolCalls: [{ id: '1', name: 'readFile', arguments: '{"path":"readme"}' }] },
      { content: '找到了内容', toolCalls: [] },
      { content: '第二个回答', toolCalls: [] },
    ], snapshots);
    let received: unknown;
    const tools = createExecutor(async (_name, input) => { received = input; return { content: '真实文件内容' }; });
    const agent = new AgentLoop(provider, tools, { systemPrompt: '规则', maxRounds: 5 });
    expect(await agent.run('读文件', createContext(provider))).toBe('找到了内容');
    expect(received).toEqual({ path: 'readme' });
    expect(snapshots[1]).toContainEqual({ role: 'tool', tool_call_id: '1', content: '{"content":"真实文件内容"}' });
    await agent.run('继续', createContext(provider));
    expect(snapshots[2].filter((message) => message.role === 'user')).toHaveLength(2);
    agent.clear();
    expect(agent.getMessages()).toEqual([{ role: 'system', content: '规则' }]);
  });

  it('无效工具参数作为错误观察，模型可以修正', async () => {
    const snapshots: ChatCompletionMessageParam[][] = [];
    const provider = createProvider([
      { content: '', toolCalls: [{ id: 'bad', name: 'readFile', arguments: 'broken' }] },
      { content: '修复完成', toolCalls: [] },
    ], snapshots);
    const agent = new AgentLoop(provider, createExecutor(async () => { throw new Error('不应执行'); }), { systemPrompt: '', maxRounds: 3 });
    await agent.run('任务', createContext(provider));
    expect(snapshots[1].at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'bad' });
    expect(snapshots[1].at(-1)?.content).toContain('error');
  });

  it('中断后为全部待执行工具补齐结果，下一次请求协议仍有效', async () => {
    const controller = new AbortController();
    const provider = createProvider([
      { content: '', toolCalls: [{ id: '1', name: 'one', arguments: '{}' }, { id: '2', name: 'two', arguments: '{}' }] },
      { content: '新任务', toolCalls: [] },
    ]);
    const tools = createExecutor(async () => { controller.abort(); controller.signal.throwIfAborted(); });
    const agent = new AgentLoop(provider, tools, { systemPrompt: '', maxRounds: 3 });
    await expect(agent.run('任务', createContext(provider, controller.signal))).rejects.toThrow();
    expect(agent.getMessages().filter((message) => message.role === 'tool')).toHaveLength(2);
    expect(await agent.run('继续', createContext(provider))).toBe('新任务');
  });

  it('最大轮次和重复调用检测阻止无限工具执行', async () => {
    let executions = 0;
    const provider = createProvider(Array.from({ length: 5 }, (_, index) => ({
      content: '', toolCalls: [{ id: String(index), name: 'same', arguments: '{}' }],
    })));
    const agent = new AgentLoop(provider, createExecutor(async () => { executions++; return 'same'; }), { systemPrompt: '', maxRounds: 5 });
    expect(await agent.run('任务', createContext(provider))).toContain('重复');
    expect(executions).toBe(2);
  });

  it('轮次上限返回明确提示，保留配对的工具消息', async () => {
    const provider = createProvider([{ content: '', toolCalls: [{ id: '1', name: 'read', arguments: '{}' }] }]);
    const agent = new AgentLoop(provider, createExecutor(async () => 'ok'), { systemPrompt: '', maxRounds: 1 });
    expect(await agent.run('任务', createContext(provider))).toContain('轮次');
    expect(agent.getMessages().some((message) => message.role === 'tool')).toBe(true);
  });

  it('工具抛错后仍能完成最终回答，并对观察结果脱敏', async () => {
    const snapshots: ChatCompletionMessageParam[][] = [];
    const provider = createProvider([
      { content: '', toolCalls: [{ id: '1', name: 'read', arguments: '{}' }] },
      { content: '完成', toolCalls: [] },
    ], snapshots);
    const agent = new AgentLoop(provider, createExecutor(async () => { throw new Error('secret'); }),
      { systemPrompt: '', maxRounds: 2, sanitize: (text) => text.replaceAll('secret', '[hidden]') });
    expect(await agent.run('任务', createContext(provider))).toBe('完成');
    expect(snapshots[1].at(-1)?.content).not.toContain('secret');
  });
});
