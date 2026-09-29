#!/usr/bin/env node
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadConfig, redactSecrets } from '../config/loadConfig.js';
import { startWebServer } from './server.js';

/** 加载本地模型配置并启动图形工作台。 */
async function main(): Promise<void> {
  const args = await yargs(hideBin(process.argv))
    .scriptName('agent-workbench')
    .option('workspace', { type: 'string', describe: '默认工作区路径' })
    .option('port', { type: 'number', default: 4317, describe: '本地服务端口' })
    .option('open', { type: 'boolean', default: true, describe: '启动后打开浏览器（--no-open 禁用）' })
    .option('model', { type: 'string', describe: '聊天模型' })
    .option('image-model', { type: 'string', describe: '图片模型' })
    .option('chat-url', { type: 'string', describe: '完整聊天端点' })
    .option('image-url', { type: 'string', describe: '完整图片端点' })
    .option('max-rounds', { type: 'number', default: 20 })
    .strict().help().parse();
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error('端口必须是 0–65535 的整数');
  const config = loadConfig({
    workspace: args.workspace, model: args.model, imageModel: args.imageModel,
    chatUrl: args.chatUrl, imageUrl: args.imageUrl, maxRounds: args.maxRounds,
  });
  config.workspace = await realpath(config.workspace);
  if (!(await stat(config.workspace)).isDirectory()) throw new Error('工作区必须是目录');
  const server = await startWebServer({ config, port: args.port });
  console.log(`\n  Agent · 本地工作台\n  ${server.url}\n  工作区：${redactSecrets(config.workspace, [config.apiKey])}\n\n  Ctrl+C 关闭服务。会话仅保存在本次服务内存中。\n`);
  if (args.open && process.platform === 'darwin') {
    const browser = spawn('open', [server.url], { stdio: 'ignore' });
    browser.on('error', () => console.log('  请在浏览器中打开上方完整链接。'));
  }
  let stopping = false;
  /** 退出时中断任务，等待命令进程与网络连接清理。 */
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    await server.close();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error), [process.env.AIDP_API_KEY ?? '']));
  process.exitCode = 1;
});
