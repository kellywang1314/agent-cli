import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatReply {
  content: string;
  toolCalls: ToolCall[];
}

export interface ImageInput {
  prompt: string;
  model?: string;
  size?: string;
}

export interface ModelProvider {
  /** 请求模型并通过回调传递文本增量。 */
  chat(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    onText: (text: string) => void,
    signal: AbortSignal,
  ): Promise<ChatReply>;
  /** 生成并返回已下载的图片数据。 */
  generateImage(input: ImageInput, signal: AbortSignal): Promise<Buffer>;
}
