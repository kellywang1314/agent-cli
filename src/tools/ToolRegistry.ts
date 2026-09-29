import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { z } from 'zod';
import { createBuiltinTools } from './builtin/index.js';
import type { AgentTool, ToolContext } from './types.js';

export { createBuiltinTools } from './builtin/index.js';

/** 将工具 schema 转为模型定义，并统一验证参数、错误和中断。 */
export class ToolRegistry {
  private readonly tools: Map<string, AgentTool>;

  /** 注册内置或调用方提供的工具，拒绝重复名称。 */
  constructor(tools: AgentTool[] = createBuiltinTools()) {
    this.tools = new Map();
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`工具重复注册：${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  /** 返回 OpenAI 兼容的函数工具定义。 */
  getDefinitions(): ChatCompletionTool[] {
    return Array.from(this.tools.values(), (tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: z.toJSONSchema(tool.schema, { io: 'input' }),
      },
    }));
  }

  /** 校验工具入参并将普通异常转换为错误结果，保持取消异常可传播。 */
  async execute(name: string, args: unknown, context: ToolContext): Promise<unknown> {
    context.signal.throwIfAborted();
    try {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`未知工具：${name}`);
      const input = await tool.schema.parseAsync(args);
      context.signal.throwIfAborted();
      const result = await tool.execute(input, context);
      context.signal.throwIfAborted();
      return result;
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}
