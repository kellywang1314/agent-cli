import { z } from 'zod';
import type { AgentTool } from '../types.js';
import { isExcluded, maxTextBytes, readText } from '../services/files.js';

const schema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().min(1).max(maxTextBytes).default(maxTextBytes),
});

export const readFileTool: AgentTool = {
  name: 'readFile',
  description: '显式读取工作区文本文件，最大 64 KiB，不允许访问 .git 或工作区之外。',
  schema,
  /** 安全读取指定文本并报告截断状态。 */
  async execute(input, context) {
    const args = schema.parse(input);
    if (args.path.split(/[\\/]/).some(isExcluded)) throw new Error('禁止读取环境配置或依赖目录');
    return { path: args.path, ...await readText(context, args.path, args.maxBytes) };
  },
};
