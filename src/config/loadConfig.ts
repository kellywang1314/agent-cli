import path from 'node:path';
import { z } from 'zod';
import { resolveDatabasePath } from '../persistence/databasePath.js';

export interface ConfigInput {
  apiKey?: string;
  chatUrl?: string;
  imageUrl?: string;
  model?: string;
  imageModel?: string;
  workspace?: string;
  maxRounds?: number;
  databasePath?: string;
  redisUrl?: string;
  redisCacheTtlSeconds?: number;
}

const endpointSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    !url.searchParams.has('ak') && !url.hash;
}, '接口必须为 HTTP(S) 地址，不包含凭据、ak 或 fragment');
const redisUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return ['redis:', 'rediss:'].includes(url.protocol);
}, 'Redis 地址必须使用 redis:// 或 rediss://');

const configSchema = z.object({
  apiKey: z.string().trim().min(1, '请通过 AIDP_API_KEY 配置密钥'),
  chatUrl: endpointSchema,
  imageUrl: endpointSchema,
  model: z.string().trim().min(1),
  imageModel: z.string().trim().min(1),
  workspace: z.string().min(1),
  maxRounds: z.number().int().min(1).max(100),
  databasePath: z.string().min(1),
  redisUrl: redisUrlSchema.nullable(),
  redisCacheTtlSeconds: z.number().int().min(1).max(86_400),
});

export type AgentConfig = z.infer<typeof configSchema>;

/** 合并参数和环境变量，校验配置且不在错误中泄漏输入值。 */
export function loadConfig(input: ConfigInput = {}, env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const model = input.model ?? env.AIDP_MODEL ?? 'gpt-5.5-2026-04-24';
  const parsed = configSchema.safeParse({
    apiKey: input.apiKey ?? env.AIDP_API_KEY ?? '',
    chatUrl: input.chatUrl ?? env.AIDP_CHAT_URL ?? 'https://aidp.bytedance.net/api/modelhub/online/v2/crawl',
    imageUrl: input.imageUrl ?? env.AIDP_IMAGE_URL ?? 'https://aidp.bytedance.net/api/modelhub/online/v2/crawl/openai/images/generations',
    model,
    imageModel: input.imageModel || env.AIDP_IMAGE_MODEL || model,
    workspace: path.resolve(input.workspace ?? process.cwd()),
    maxRounds: input.maxRounds ?? 20,
    databasePath: path.resolve(input.databasePath ?? resolveDatabasePath(env)),
    redisUrl: input.redisUrl ?? (env.REDIS_URL?.trim() || null),
    redisCacheTtlSeconds: input.redisCacheTtlSeconds ??
      Number(env.REDIS_CACHE_TTL_SECONDS ?? 300),
  });
  if (!parsed.success) {
    throw new Error(`配置错误：${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')}`);
  }
  return parsed.data;
}

/** 屏蔽已知密钥、URL 鉴权参数和 Bearer token，移除终端控制字符。 */
export function redactSecrets(value: string, secrets: string[] = []): string {
  let result = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  for (const secret of secrets.filter(Boolean)) {
    result = result.split(secret).join('[REDACTED]');
    result = result.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return result
    .replace(/\b(rediss?:\/\/)([^@\s/]+)@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:ak|api_key|apiKey|token)=)[^&\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]');
}

/** 暂存流末尾可能属于密钥的片段，避免完整密钥到达前泄漏前缀。 */
export function redactStream(value: string, secrets: string[]): string {
  const redacted = redactSecrets(value, secrets);
  let pendingLength = 0;
  for (const secret of secrets.filter(Boolean).flatMap((item) => [item, encodeURIComponent(item)])) {
    for (let length = 1; length < secret.length && length <= redacted.length; length++) {
      if (redacted.endsWith(secret.slice(0, length))) pendingLength = Math.max(pendingLength, length);
    }
  }
  return pendingLength ? redacted.slice(0, -pendingLength) : redacted;
}
