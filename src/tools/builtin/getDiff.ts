import { z } from 'zod';
import { resolveWorkspacePath } from '../../security/workspacePath.js';
import { createChildEnv, runProcess } from '../services/process.js';
import type { AgentTool } from '../types.js';

const safeGitArgs = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

/** 只读枚举全部配置来源的过滤器，以命令级环境配置禁用所有可执行转换。 */
async function createDiffEnv(root: string, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const config = await runProcess('git', [
    ...safeGitArgs, 'config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$',
  ], root, signal, 30_000, env);
  if (config.timedOut || config.truncated || (config.exitCode !== 0 && config.exitCode !== 1)) {
    throw new Error('无法完整读取 Git filter 配置，取消差异读取');
  }
  const diffEnv = { ...env };
  const drivers = new Set<string>();
  if (config.output) {
    if (config.exitCode !== 0 || !config.output.endsWith('\0') || config.output.includes('\uFFFD')) {
      throw new Error('Git filter 配置输出无效，取消差异读取');
    }
    for (const key of config.output.slice(0, -1).split('\0')) {
      const match = /^filter\.(.+)\.(clean|process|required)$/s.exec(key);
      if (!match) throw new Error('Git filter 配置键无效，取消差异读取');
      drivers.add(match[1]!);
    }
  }
  let configCount = 0;
  for (const driver of drivers) {
    for (const field of ['clean', 'process', 'required']) {
      // 独立的键值环境项支持名称中包含等号，避免 -c key=value 的歧义。
      diffEnv[`GIT_CONFIG_KEY_${configCount}`] = `filter.${driver}.${field}`;
      diffEnv[`GIT_CONFIG_VALUE_${configCount}`] = field === 'required' ? 'false' : '';
      configCount++;
    }
  }
  diffEnv.GIT_CONFIG_COUNT = String(configCount);
  return diffEnv;
}

export const getDiffTool: AgentTool = {
  name: 'getDiff',
  description: '只读获取工作区范围内未暂存的 Git 差异，禁用外部 diff、textconv 和 Git filter，无需确认。',
  schema: z.object({}),
  /** 使用固定 Git 参数读取受工作区作用域限制的差异。 */
  async execute(_input, context) {
    const root = await resolveWorkspacePath(context.workspace, '.');
    const env = createChildEnv();
    const check = await runProcess('git', [...safeGitArgs, 'rev-parse', '--is-inside-work-tree'], root, context.signal, 30_000, env);
    if (check.exitCode !== 0 || check.output.trim() !== 'true') throw new Error('当前工作区不是 Git 工作仓库');
    const diffEnv = await createDiffEnv(root, context.signal, env);
    const result = await runProcess('git', [
      ...safeGitArgs, 'diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--', '.',
    ], root, context.signal, 30_000, diffEnv);
    if (result.exitCode !== 0) throw new Error(`Git diff 失败：${result.output}`);
    return { ...result, diff: result.output };
  },
};
