import { z } from 'zod';
import type { AgentTool } from '../types.js';
import { walkFiles } from '../services/files.js';

const schema = z.object({
  path: z.string().default('.'),
  maxEntries: z.number().int().min(1).max(2000).default(500),
});

export const listFilesTool: AgentTool = {
  name: 'listFiles',
  description: '递归列出工作区文件，跳过依赖、环境配置和符号链接，结果有数量和字节上限。',
  schema,
  /** 在受限工作区内列举文件路径。 */
  async execute(input, context) {
    const args = schema.parse(input);
    return walkFiles(context, args.path, args.maxEntries);
  },
};
