import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { redactSecrets, type AgentConfig } from '../config/loadConfig.js';
import type { ChatReply, ImageInput, ModelProvider, ToolCall } from './types.js';

const maxImageBytes = 20 * 1024 * 1024;

/** 为请求 URL 注入密钥，保留路由等其他查询参数。 */
function authenticatedUrl(endpoint: string, apiKey: string): string {
  const url = new URL(endpoint);
  url.searchParams.set('ak', apiKey);
  return url.toString();
}

/** 限量读取响应流，避免图片或异常响应耗尽内存。 */
async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error('响应没有内容');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks);
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error(`响应超过 ${maxBytes} 字节限制`);
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 检查常见栅格图片签名，拒绝 HTML、SVG 和无效 Base64。 */
function validateImage(buffer: Buffer): Buffer {
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const isWebp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!buffer.length || buffer.length > maxImageBytes || !(isPng || isJpeg || isWebp)) {
    throw new Error('图片响应无效：仅支持 20 MiB 以内 PNG/JPEG/WebP');
  }
  return buffer;
}

export class AidpProvider implements ModelProvider {
  private readonly client: OpenAI;

  /** SDK 使用精确聊天端点，AIDP 密钥只注入该端点的查询参数。 */
  constructor(private readonly config: AgentConfig) {
    this.client = new OpenAI({
      apiKey: 'aidp-query-auth',
      baseURL: 'https://aidp.invalid',
      maxRetries: 2,
      timeout: 120_000,
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        headers.delete('authorization');
        return fetch(authenticatedUrl(config.chatUrl, config.apiKey), {
          ...init, headers, redirect: 'error',
        });
      },
    });
  }

  /** 拼接 OpenAI SSE 的文本和工具分片；不对已经开始的流进行重放。 */
  async chat(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    onText: (text: string) => void,
    signal: AbortSignal,
  ): Promise<ChatReply> {
    signal.throwIfAborted();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    try {
      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        messages,
        stream: true,
        ...(tools.length ? { tools, tool_choice: 'auto' as const } : {}),
      }, { signal: requestSignal });
      let content = '';
      let finishReason: string | null = null;
      let streamedBytes = 0;
      const calls = new Map<number, ToolCall>();
      for await (const chunk of stream) {
        requestSignal.throwIfAborted();
        const choice = chunk.choices[0];
        if (!choice) continue;
        streamedBytes += Buffer.byteLength(JSON.stringify(choice));
        if (streamedBytes > 2 * 1024 * 1024) {
          stream.controller.abort();
          throw new Error('模型输出超过 2 MiB，请缩小任务范围');
        }
        if (choice.delta.content) {
          content += choice.delta.content;
          onText(choice.delta.content);
        }
        for (const delta of choice.delta.tool_calls ?? []) {
          const call = calls.get(delta.index) ?? { id: '', name: '', arguments: '' };
          call.id += delta.id ?? '';
          call.name += delta.function?.name ?? '';
          call.arguments += delta.function?.arguments ?? '';
          calls.set(delta.index, call);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      requestSignal.throwIfAborted();
      if (!finishReason || finishReason === 'length') throw new Error('模型流响应不完整，请缩小任务后重试');
      if (finishReason === 'content_filter') throw new Error('模型拒绝了该请求');
      const toolCalls = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call);
      if (toolCalls.some((call) => !call.id || !call.name)) throw new Error('模型工具调用协议不完整');
      if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) throw new Error('模型返回重复工具调用 ID');
      if (!content && !toolCalls.length) throw new Error('模型返回空响应，请检查聊天端点和模型能力');
      return { content, toolCalls };
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(redactSecrets(`聊天请求失败：${error instanceof Error ? error.message : String(error)}`, [this.config.apiKey]));
    }
  }

  /** 生成图片并解析 URL/Base64；不自动重试计费请求。 */
  async generateImage(input: ImageInput, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    try {
      const response = await fetch(authenticatedUrl(this.config.imageUrl, this.config.apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model || this.config.imageModel,
          prompt: input.prompt,
          n: 1,
          ...(input.size ? { size: input.size } : {}),
        }),
        signal: requestSignal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`图片接口 HTTP ${response.status}，请检查模型、端点与权限`);
      }
      const body: unknown = JSON.parse((await readLimited(response, 28 * 1024 * 1024)).toString('utf8'));
      const data = body && typeof body === 'object' && 'data' in body ? body.data : undefined;
      const image = Array.isArray(data) ? data[0] : undefined;
      if (typeof image?.b64_json === 'string') {
        const encoded = image.b64_json;
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Error('图片 Base64 格式无效');
        return validateImage(Buffer.from(encoded, 'base64'));
      }
      if (typeof image?.url === 'string') {
        const imageUrl = new URL(image.url);
        if (!['http:', 'https:'].includes(imageUrl.protocol) || imageUrl.username || imageUrl.password) throw new Error('图片 URL 无效');
        // 下载不携带 AIDP 鉴权，也不跟随未经检查的重定向。
        const downloaded = await fetch(imageUrl, { signal: requestSignal, redirect: 'error' });
        if (!downloaded.ok) {
          await downloaded.body?.cancel();
          throw new Error(`图片下载 HTTP ${downloaded.status}`);
        }
        return validateImage(await readLimited(downloaded, maxImageBytes));
      }
      throw new Error('图片响应缺少 data[0].url 或 data[0].b64_json');
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(redactSecrets(`图片生成失败：${error instanceof Error ? error.message : String(error)}`, [this.config.apiKey]));
    }
  }
}
