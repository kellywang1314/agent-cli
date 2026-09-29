import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ModelProvider } from '../providers/types.js';
import type { ToolContext } from '../tools/types.js';

export interface ToolExecutor {
  /** 返回发送给模型的工具声明。 */
  getDefinitions(): ChatCompletionTool[];
  /** 校验并执行一个工具。 */
  execute(name: string, input: unknown, context: ToolContext): Promise<unknown>;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; round: number }
  | { type: 'toolStart'; name: string }
  | { type: 'toolEnd'; name: string; result: string; elapsedMs: number };

interface AgentOptions {
  systemPrompt: string;
  maxRounds: number;
  sanitize?: (text: string) => string;
  onEvent?: (event: AgentEvent) => void;
}

/** 对对象键排序，让重复调用检测不依赖 JSON 属性顺序。 */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableKey(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export class AgentLoop {
  private messages: ChatCompletionMessageParam[];
  private busy = false;

  /** 创建拥有独立会话历史的 Agent。 */
  constructor(
    private readonly provider: ModelProvider,
    private readonly tools: ToolExecutor,
    private readonly options: AgentOptions,
  ) {
    this.messages = [{ role: 'system', content: options.systemPrompt }];
  }

  /** 返回历史副本，防止外部改坏工具消息配对。 */
  getMessages(): ChatCompletionMessageParam[] {
    return structuredClone(this.messages);
  }

  /** 清空空闲会话，保留系统和项目约束。 */
  clear(): void {
    if (this.busy) throw new Error('请先中断当前任务');
    this.messages = [{ role: 'system', content: this.options.systemPrompt }];
  }

  /** 记录并返回因循环保护而终止的结果。 */
  private finish(message: string): string {
    this.messages.push({ role: 'assistant', content: message });
    this.options.onEvent?.({ type: 'text', text: message });
    return message;
  }

  /** 执行完整决策循环，工具串行执行且取消后补齐所有工具消息。 */
  async run(prompt: string, context: ToolContext): Promise<string> {
    if (this.busy) throw new Error('已有任务运行中');
    if (!prompt.trim()) throw new Error('请输入任务');
    context.signal.throwIfAborted();
    this.busy = true;
    this.messages.push({ role: 'user', content: prompt });
    const signatures = new Map<string, number>();
    try {
      for (let round = 1; round <= this.options.maxRounds; round++) {
        context.signal.throwIfAborted();
        this.options.onEvent?.({ type: 'thinking', round });
        const reply = await this.provider.chat(this.messages, this.tools.getDefinitions(),
          (text) => this.options.onEvent?.({ type: 'text', text }), context.signal);
        context.signal.throwIfAborted();
        if (!reply.toolCalls.length) {
          this.messages.push({ role: 'assistant', content: reply.content });
          return reply.content;
        }
        if (reply.toolCalls.length > 16) return this.finish('单轮工具调用超过 16 个，已停止，请拆分任务。');
        this.messages.push({
          role: 'assistant',
          content: reply.content || null,
          tool_calls: reply.toolCalls.map((call) => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
          })),
        });
        let repeated = false;
        for (const [index, call] of reply.toolCalls.entries()) {
          const startedAt = Date.now();
          let result: unknown;
          try {
            context.signal.throwIfAborted();
            const input: unknown = JSON.parse(call.arguments);
            const signature = `${call.name}:${stableKey(input)}`;
            const count = (signatures.get(signature) ?? 0) + 1;
            signatures.set(signature, count);
            if (count >= 3 || repeated) {
              repeated = true;
              result = { error: '重复工具调用已停止，请调整策略' };
            } else {
              this.options.onEvent?.({ type: 'toolStart', name: call.name });
              result = await this.tools.execute(call.name, input, context);
            }
          } catch (error) {
            if (context.signal.aborted) {
              for (const pending of reply.toolCalls.slice(index)) {
                this.messages.push({ role: 'tool', tool_call_id: pending.id, content: '{"error":"用户已中断，未完成"}' });
              }
              context.signal.throwIfAborted();
            }
            result = { error: error instanceof Error ? error.message : String(error) };
          }
          const serialized = JSON.stringify(result) ?? 'null';
          const content = this.options.sanitize?.(serialized) ?? serialized;
          this.messages.push({ role: 'tool', tool_call_id: call.id, content });
          this.options.onEvent?.({ type: 'toolEnd', name: call.name, result: content, elapsedMs: Date.now() - startedAt });
        }
        context.signal.throwIfAborted();
        if (repeated) return this.finish('检测到重复调用，任务已停止。请补充信息或调整目标后继续。');
      }
      return this.finish(`已达到 ${this.options.maxRounds} 轮次上限。已保留执行结果，可输入新指令继续。`);
    } finally {
      this.busy = false;
    }
  }
}
