#!/usr/bin/env node
import 'dotenv/config';
import { realpath, stat } from 'node:fs/promises';
import { render } from 'ink';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { createCacheService } from './cache/createCacheService.js';
import {
  loadConfig,
  redactSecrets,
  validateRedisCliUrl,
} from './config/loadConfig.js';
import { MemoryService } from './memory/MemoryService.js';
import { PersistenceStore } from './persistence/PersistenceStore.js';
import { AidpProvider } from './providers/AidpProvider.js';
import { SessionService } from './sessions/SessionService.js';
import { ToolRegistry } from './tools/ToolRegistry.js';
import { App } from './ui/App.js';

/** 解析 CLI 配置，创建共享持久服务并启动终端界面。 */
async function main(): Promise<void> {
  const args = await yargs(hideBin(process.argv))
    .scriptName('agent-cli')
    .usage('$0 [选项]')
    .option('workspace', { type: 'string', describe: '工作区目录，默认当前目录' })
    .option('api-key', { type: 'string', describe: 'AIDP 密钥（推荐使用 AIDP_API_KEY 环境变量）' })
    .option('model', { type: 'string', describe: '聊天模型，默认 gpt-5.5-2026-04-24' })
    .option('image-model', { type: 'string', describe: '图片模型，默认沿用聊天模型' })
    .option('chat-url', { type: 'string', describe: '完整 Chat Completions 地址，不包含 ak' })
    .option('image-url', { type: 'string', describe: '完整图片生成地址，不包含 ak' })
    .option('max-rounds', { type: 'number', describe: '每个任务的最大模型调用轮次', default: 20 })
    .option('database-path', { type: 'string', describe: '会话与长期记忆数据库路径' })
    .option('redis-url', {
      type: 'string',
      describe: '可选无认证 Redis 地址',
      coerce: validateRedisCliUrl,
    })
    .option('redis-cache-ttl', {
      type: 'number',
      describe: 'Redis 缓存 TTL 秒数',
    })
    .strict()
    .version('0.1.0')
    .help()
    .parse();
  const config = loadConfig({
    workspace: args.workspace, apiKey: args.apiKey, model: args.model, imageModel: args.imageModel,
    chatUrl: args.chatUrl, imageUrl: args.imageUrl, maxRounds: args.maxRounds,
    databasePath: args.databasePath,
    redisUrl: args.redisUrl, redisCacheTtlSeconds: args.redisCacheTtl,
  });
  config.workspace = await realpath(config.workspace);
  if (!(await stat(config.workspace)).isDirectory()) throw new Error('工作区必须是目录');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在交互式终端运行 agent-cli（需要 TTY）');
  const persistence = new PersistenceStore(config.databasePath);
  persistence.recoverInterruptedWork();
  const provider = new AidpProvider(config);
  const sanitize = (text: string): string => redactSecrets(text, [
    config.apiKey,
    config.redisUrl ?? '',
  ]);
  const cache = await createCacheService(
    config.redisUrl,
    (error) => console.error(`Redis 已降级：${sanitize(String(error))}`),
  );
  const memories = new MemoryService(
    persistence,
    provider,
    sanitize,
    cache,
    config.redisCacheTtlSeconds,
  );
  const sessions = new SessionService(
    config,
    provider,
    new ToolRegistry(),
    persistence,
    memories,
    sanitize,
  );
  try {
    const app = render(
      <App config={config} sessionService={sessions} memoryService={memories} />,
      { exitOnCtrlC: false },
    );
    await app.waitUntilExit();
  } finally {
    await sessions.close();
    await cache.close();
    persistence.close();
  }
}

/** 顶层错误仅显示脱敏信息，避免异常堆栈暴露请求凭据。 */
function handleFatalError(error: unknown): void {
  const args = process.argv;
  const keyIndex = args.indexOf('--api-key');
  const cliKey = keyIndex >= 0 ? args[keyIndex + 1] : args.find((value) => value.startsWith('--api-key='))?.slice(10);
  const redisIndex = args.indexOf('--redis-url');
  const cliRedisUrl = redisIndex >= 0
    ? args[redisIndex + 1]
    : args.find((value) => value.startsWith('--redis-url='))?.slice(12);
  console.error(redactSecrets(error instanceof Error ? error.message : String(error), [
    process.env.AIDP_API_KEY ?? '',
    cliKey ?? '',
    process.env.REDIS_URL ?? '',
    cliRedisUrl ?? '',
  ]));
  process.exitCode = 1;
}

main().catch(handleFatalError);
