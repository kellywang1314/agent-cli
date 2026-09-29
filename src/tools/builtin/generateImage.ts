import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveWorkspacePath } from '../../security/workspacePath.js';
import { ensureParent } from '../services/files.js';
import type { AgentTool } from '../types.js';

const schema = z.object({
  prompt: z.string().min(1).max(16_384),
  outputPath: z.string().min(1).optional(),
  size: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
});

/** 确认目标尚不存在，包含拒绝悬空符号链接。 */
async function assertMissing(target: string): Promise<void> {
  try { await lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('图片目标已存在，禁止覆盖');
}

export const generateImageTool: AgentTool = {
  name: 'generateImage',
  description: '确认提示词及保存路径后调用图片模型，默认保存到 generated/ 唯一 PNG 文件，禁止覆盖。',
  schema,
  /** 请求授权后生成图片，并在保存前复检路径、独占创建文件。 */
  async execute(input, context) {
    const args = schema.parse(input);
    const outputPath = args.outputPath ?? `generated/${randomUUID()}.png`;
    const target = await resolveWorkspacePath(context.workspace, outputPath, true);
    await assertMissing(target);
    context.signal.throwIfAborted();
    const approved = await context.confirm({
      title: '生成图片',
      detail: `提示词：${args.prompt}\n目标：${target}\n模型：${args.model ?? '默认'}\n尺寸：${args.size ?? '默认'}`,
    }, context.signal);
    context.signal.throwIfAborted();
    if (!approved) throw new Error('用户拒绝生成图片');
    if (await resolveWorkspacePath(context.workspace, outputPath, true) !== target) throw new Error('图片路径已变化');
    await assertMissing(target);
    const image = await context.provider.generateImage({
      prompt: args.prompt,
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args.size === undefined ? {} : { size: args.size }),
    }, context.signal);
    context.signal.throwIfAborted();
    if (await resolveWorkspacePath(context.workspace, outputPath, true) !== target) throw new Error('图片路径已变化');
    await assertMissing(target);
    await ensureParent(context, target);
    if (await resolveWorkspacePath(context.workspace, outputPath, true) !== target) throw new Error('图片路径已变化');
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(image);
    } finally {
      await handle.close();
    }
    return { path: path.relative(await resolveWorkspacePath(context.workspace, '.'), target), bytes: image.length };
  },
};
