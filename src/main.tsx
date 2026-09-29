#!/usr/bin/env node
import 'dotenv/config';
import { realpath, stat } from 'node:fs/promises';
import { render } from 'ink';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadConfig, redactSecrets } from './config/loadConfig.js';
import { collectProjectContext } from './context/projectContext.js';
import { AidpProvider } from './providers/AidpProvider.js';
import { createSystemPrompt } from './prompts/systemPrompt.js';
import { App } from './ui/App.js';

/** 解析 CLI 配置，加载项目说明并启动终端界面。 */
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
    .strict()
    .version('0.1.0')
    .help()
    .parse();
  const config = loadConfig({
    workspace: args.workspace, apiKey: args.apiKey, model: args.model, imageModel: args.imageModel,
    chatUrl: args.chatUrl, imageUrl: args.imageUrl, maxRounds: args.maxRounds,
  });
  config.workspace = await realpath(config.workspace);
  if (!(await stat(config.workspace)).isDirectory()) throw new Error('工作区必须是目录');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在交互式终端运行 agent-cli（需要 TTY）');
  const context = await collectProjectContext(config.workspace);
  const app = render(
    <App config={config} provider={new AidpProvider(config)}
      systemPrompt={redactSecrets(createSystemPrompt(config.workspace, context), [config.apiKey])} />,
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
}

/** 顶层错误仅显示脱敏信息，避免异常堆栈暴露请求凭据。 */
function handleFatalError(error: unknown): void {
  const args = process.argv;
  const keyIndex = args.indexOf('--api-key');
  const cliKey = keyIndex >= 0 ? args[keyIndex + 1] : args.find((value) => value.startsWith('--api-key='))?.slice(10);
  console.error(redactSecrets(error instanceof Error ? error.message : String(error), [process.env.AIDP_API_KEY ?? '', cliKey ?? '']));
  process.exitCode = 1;
}

main().catch(handleFatalError);
