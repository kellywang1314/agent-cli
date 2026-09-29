import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspacePath } from '../../security/workspacePath.js';
import type { ToolContext } from '../types.js';

export const maxTextBytes = 64 * 1024;

/** 判定自动遍历时需要排除的依赖及隐私路径。 */
export function isExcluded(name: string): boolean {
  return name === 'node_modules' || name.toLowerCase() === '.git' || name === '.env' || name.startsWith('.env.');
}

/** 通过不跟随最终链接的句柄读取有限文本并拒绝二进制。 */
export async function readText(context: ToolContext, inputPath: string, maxBytes = maxTextBytes): Promise<{ content: string; truncated: boolean }> {
  context.signal.throwIfAborted();
  const target = await resolveWorkspacePath(context.workspace, inputPath);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('只能读取普通文本文件');
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    context.signal.throwIfAborted();
    const data = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    if (data.includes(0)) throw new Error('不支持二进制文件');
    const truncated = bytesRead > maxBytes || info.size > maxBytes;
    return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data, { stream: truncated }), truncated };
  } finally {
    await handle.close();
  }
}

/** 有界遍历普通文件和目录，不跟随符号链接。 */
export async function walkFiles(context: ToolContext, inputPath: string, limit: number): Promise<{ files: string[]; truncated: boolean }> {
  const root = await resolveWorkspacePath(context.workspace, '.');
  const start = await resolveWorkspacePath(root, inputPath);
  const files: string[] = [];
  let visited = 0;
  let byteCount = 0;
  let truncated = false;
  /** 深度优先读取目录并限制访问数量及输出字节。 */
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 32) { truncated = true; return; }
    context.signal.throwIfAborted();
    if ((await lstat(directory)).isSymbolicLink()) return;
    const checked = await resolveWorkspacePath(root, directory);
    if (checked !== directory) throw new Error('目录路径已变化');
    const entries = await opendir(checked);
    for await (const entry of entries) {
      context.signal.throwIfAborted();
      if (++visited > 10_000) { truncated = true; break; }
      if (isExcluded(entry.name) || entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      const relativePath = path.relative(root, child);
      if (files.length >= limit || byteCount + Buffer.byteLength(relativePath) > maxTextBytes) {
        truncated = true;
        break;
      }
      files.push(relativePath);
      byteCount += Buffer.byteLength(relativePath);
      if (entry.isDirectory()) await visit(child, depth + 1);
      if (truncated && (visited > 10_000 || files.length >= limit)) break;
    }
  }
  if (path.relative(root, start).split(path.sep).some(isExcluded)) return { files, truncated };
  if ((await lstat(path.resolve(root, inputPath))).isSymbolicLink()) return { files, truncated };
  await visit(start, 0);
  return { files, truncated };
}

/** 确认后逐级创建目录，并对每一级路径进行复检。 */
export async function ensureParent(context: ToolContext, target: string): Promise<void> {
  const root = await resolveWorkspacePath(context.workspace, '.');
  const parts = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    context.signal.throwIfAborted();
    current = path.join(current, part);
    if (await resolveWorkspacePath(root, current, true) !== current) throw new Error('父目录路径已变化');
    try { await mkdir(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!(await lstat(current)).isDirectory()) throw new Error('父路径不是普通目录');
  }
}
