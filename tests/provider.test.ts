import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadConfig,
  redactSecrets,
  redactStream,
  validateRedisCliUrl,
} from '../src/config/loadConfig.js';
import { AidpProvider } from '../src/providers/AidpProvider.js';

const servers: Server[] = [];
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64');

/** 创建本地网关，真实验证 SDK HTTP 协议，不消耗线上模型。 */
async function startGateway(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无端口');
  return `http://127.0.0.1:${address.port}`;
}

/** 收集服务端收到的 JSON 请求。 */
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe('配置', () => {
  it('参数覆盖环境变量，图片模型独立设置', () => {
    const config = loadConfig({ apiKey: 'cli-key', model: 'chat-model', maxRounds: 3 },
      { AIDP_API_KEY: 'env-key', AIDP_MODEL: 'env-model', AIDP_IMAGE_MODEL: 'image-model' });
    expect(config.apiKey).toBe('cli-key');
    expect(config.model).toBe('chat-model');
    expect(config.imageModel).toBe('image-model');
    expect(config.maxRounds).toBe(3);
    expect(config.chatUrl).toBe('https://aidp.bytedance.net/api/modelhub/online/v2/crawl');
  });

  it('读取可选 Redis 地址和有界 TTL，参数覆盖环境变量', () => {
    const config = loadConfig({
      apiKey: 'key',
      redisUrl: 'redis://127.0.0.1:6380',
      redisCacheTtlSeconds: 60,
    }, {
      REDIS_URL: 'redis://127.0.0.1:6379',
      REDIS_CACHE_TTL_SECONDS: '300',
    });
    expect(config.redisUrl).toBe('redis://127.0.0.1:6380');
    expect(config.redisCacheTtlSeconds).toBe(60);

    const disabled = loadConfig({ apiKey: 'key' }, {});
    expect(disabled.redisUrl).toBeNull();
    expect(disabled.redisCacheTtlSeconds).toBe(300);
  });

  it('拒绝非 Redis 协议和超出范围的缓存 TTL', () => {
    expect(() => loadConfig({ apiKey: 'key', redisUrl: 'https://localhost' }, {}))
      .toThrow('redisUrl');
    expect(() => loadConfig({ apiKey: 'key', redisCacheTtlSeconds: 0 }, {}))
      .toThrow('redisCacheTtlSeconds');
    expect(() => loadConfig({ apiKey: 'key' }, {
      REDIS_CACHE_TTL_SECONDS: 'not-a-number',
    })).toThrow('redisCacheTtlSeconds');
  });

  it('Redis CLI 参数拒绝凭据并允许无认证本地地址', () => {
    expect(validateRedisCliUrl('redis://127.0.0.1:6379'))
      .toBe('redis://127.0.0.1:6379');
    expect(() => validateRedisCliUrl(
      'rediss://student:private-password@redis.example.com:6380',
    )).toThrow('REDIS_URL');
  });

  it('缺少密钥、错误 URL、非法轮次均给出脱敏错误', () => {
    expect(() => loadConfig({}, {})).toThrow('AIDP_API_KEY');
    expect(() => loadConfig({ apiKey: 'key', maxRounds: 0 }, {})).toThrow();
    expect(() => loadConfig({ apiKey: 'key', chatUrl: 'file:///tmp/a' }, {})).toThrow();
    expect(() => loadConfig({ apiKey: 'key', chatUrl: 'https://name:pass@example.com' }, {})).toThrow();
    expect(() => loadConfig({ apiKey: 'key', chatUrl: 'https://example.com?ak=embedded' }, {})).toThrow();
  });

  it('错误消息中的原始密钥、查询参数和 Bearer 均脱敏', () => {
    const text = redactSecrets('secret-value https://host?a=1&ak=other-key Bearer token-value', ['secret-value']);
    expect(text).not.toContain('secret-value');
    expect(text).not.toContain('other-key');
    expect(text).not.toContain('token-value');
  });

  it('Redis URL 用户信息会被脱敏', () => {
    const text = redactSecrets(
      'connect redis://student:private-password@127.0.0.1:6379 failed',
    );
    expect(text).toBe('connect redis://[REDACTED]@127.0.0.1:6379 failed');
  });

  it('流式输出暂存可能属于密钥的尾部，并在完整后替换', () => {
    const secret = 'synthetic-private-key';
    for (let end = 1; end <= secret.length; end++) {
      const text = redactStream(`回答：${secret.slice(0, end)}`, [secret]);
      expect(text).toBe(end < secret.length ? '回答：' : '回答：[REDACTED]');
    }
    expect(redactStream('回答：something else', [secret])).toBe('回答：something else');
    expect(redactSecrets('synthetic-\u001bprivate-key', [secret])).toBe('[REDACTED]');
  });
});

describe('AIDP Provider', () => {
  it('使用精确端点及 ak，并拼接 SSE 文本与工具参数分片', async () => {
    let requestedPath = '';
    let body: Record<string, unknown> = {};
    const endpoint = await startGateway(async (request, response) => {
      requestedPath = request.url ?? '';
      body = await readBody(request);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = [
        { content: '正在' },
        { content: '读取', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'readFile', arguments: '{"pa' } }] },
        { tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] },
      ];
      for (const delta of chunks) {
        response.write(`data: ${JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      }
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    const provider = new AidpProvider(loadConfig({ apiKey: 'test-key', chatUrl: `${endpoint}/custom/chat?route=a` }, {}));
    const text: string[] = [];
    const result = await provider.chat([{ role: 'user', content: '读取' }], [], (chunk) => text.push(chunk), new AbortController().signal);
    expect(requestedPath).toBe('/custom/chat?route=a&ak=test-key');
    expect(body.model).toBe('gpt-5.5-2026-04-24');
    expect(body.stream).toBe(true);
    expect(text.join('')).toBe('正在读取');
    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'readFile', arguments: '{"path":"README.md"}' }]);
  });

  it('支持 Base64 图片和独立图片模型', async () => {
    let body: Record<string, unknown> = {};
    const endpoint = await startGateway(async (request, response) => {
      body = await readBody(request);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ b64_json: imageBytes.toString('base64') }] }));
    });
    const provider = new AidpProvider(loadConfig({ apiKey: 'test-key', imageUrl: `${endpoint}/images`, imageModel: 'image-model' }, {}));
    expect(await provider.generateImage({ prompt: '小猫', size: '1024x1024' }, new AbortController().signal)).toEqual(imageBytes);
    expect(body).toMatchObject({ model: 'image-model', prompt: '小猫', size: '1024x1024' });
  });

  it('支持 URL 下载且不会向图片服务发送 API Key', async () => {
    let downloadUrl = '';
    let downloadAuth: unknown;
    const endpoint = await startGateway((request, response) => {
      if (request.url === '/result.png') {
        downloadUrl = request.url;
        downloadAuth = request.headers.authorization;
        response.setHeader('Content-Type', 'image/png');
        response.end(imageBytes);
      } else {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data: [{ url: `${endpoint}/result.png` }] }));
      }
    });
    const provider = new AidpProvider(loadConfig({ apiKey: 'test-key', imageUrl: `${endpoint}/images` }, {}));
    expect(await provider.generateImage({ prompt: '小猫' }, new AbortController().signal)).toEqual(imageBytes);
    expect(downloadUrl).toBe('/result.png');
    expect(downloadAuth).toBeUndefined();
  });

  it('无效图片格式失败，错误不暴露网关密钥', async () => {
    const endpoint = await startGateway((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: 'test-key', data: [] }));
    });
    const provider = new AidpProvider(loadConfig({ apiKey: 'test-key', imageUrl: `${endpoint}/images` }, {}));
    await expect(provider.generateImage({ prompt: '小猫' }, new AbortController().signal)).rejects.toThrow('图片');
  });

  it('中断流不会被当作成功回答', async () => {
    const endpoint = await startGateway((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] })}\n\n`);
    });
    const provider = new AidpProvider(loadConfig({ apiKey: 'test-key', chatUrl: `${endpoint}/chat` }, {}));
    await expect(provider.chat([], [], () => {}, new AbortController().signal)).rejects.toThrow('不完整');
  });

  it('已取消请求不会访问网关', async () => {
    let requests = 0;
    const endpoint = await startGateway((_request, response) => { requests++; response.end('{}'); });
    const provider = new AidpProvider(loadConfig({ apiKey: 'test-key', chatUrl: `${endpoint}/chat` }, {}));
    const controller = new AbortController();
    controller.abort();
    await expect(provider.chat([], [], () => {}, controller.signal)).rejects.toThrow();
    expect(requests).toBe(0);
  });
});
