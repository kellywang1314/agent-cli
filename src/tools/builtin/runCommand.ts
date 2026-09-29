import { z } from 'zod';
import { resolveWorkspacePath } from '../../security/workspacePath.js';
import { runProcess } from '../services/process.js';
import type { AgentTool } from '../types.js';

const schema = z.object({
  command: z.string().min(1).max(16_384).refine((value) => value.trim().length > 0, '命令不能为空白'),
  timeoutMs: z.number().int().min(1).max(60_000).default(30_000),
});

export const runCommandTool: AgentTool = {
  name: 'runCommand',
  description: '确认后在工作区根目录执行 shell 命令。具有系统用户权限，不是 OS 沙箱；超时最多 60 秒。',
  schema,
  /** 显示完整命令，确认后复检工作区并执行可取消的进程组。 */
  async execute(input, context) {
    const args = schema.parse(input);
    const root = await resolveWorkspacePath(context.workspace, '.');
    context.signal.throwIfAborted();
    const approved = await context.confirm({
      title: '执行 Shell 命令',
      detail: `具有系统用户权限，非 OS 沙箱，命令可以访问工作区外的资源。\n工作目录：${root}\n超时：${args.timeoutMs}ms\n\n${args.command}`,
    }, context.signal);
    context.signal.throwIfAborted();
    if (!approved) throw new Error('用户拒绝执行命令');
    if (await resolveWorkspacePath(context.workspace, '.') !== root) throw new Error('工作区路径已变化');
    return runProcess('/bin/sh', ['-c', args.command], root, context.signal, args.timeoutMs);
  },
};
