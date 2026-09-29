import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { resolveWorkspacePath } from '../../security/workspacePath.js';
import { maxTextBytes, readText, walkFiles } from '../services/files.js';
import type { AgentTool } from '../types.js';

const schema = z.object({
  query: z.string().min(1).max(1000),
  path: z.string().default('.'),
  maxResults: z.number().int().min(1).max(500).default(100),
});

export const searchTool: AgentTool = {
  name: 'search',
  description: '在工作区文本中逐行搜索字面量，跳过依赖、环境配置、二进制和符号链接。',
  schema,
  /** 执行有文件数、读取字节和结果字节限制的文本搜索。 */
  async execute(input, context) {
    const args = schema.parse(input);
    const listing = await walkFiles(context, args.path, 2000);
    const matches: { path: string; line: number; text: string }[] = [];
    let scannedBytes = 0;
    let resultBytes = 0;
    let truncated = listing.truncated;
    for (const file of listing.files) {
      context.signal.throwIfAborted();
      if (scannedBytes >= 4 * 1024 * 1024) { truncated = true; break; }
      let text: { content: string; truncated: boolean };
      try {
        const target = await resolveWorkspacePath(context.workspace, file);
        if (!(await lstat(target)).isFile()) continue;
        text = await readText(context, file);
      } catch {
        context.signal.throwIfAborted();
        continue;
      }
      scannedBytes += Buffer.byteLength(text.content);
      truncated ||= text.truncated;
      const lines = text.content.split('\n');
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        if (!line.includes(args.query)) continue;
        const match = { path: file, line: index + 1, text: line };
        const bytes = Buffer.byteLength(JSON.stringify(match));
        if (matches.length >= args.maxResults || resultBytes + bytes > maxTextBytes) {
          return { matches, truncated: true };
        }
        matches.push(match);
        resultBytes += bytes;
      }
    }
    return { matches, truncated };
  },
};
