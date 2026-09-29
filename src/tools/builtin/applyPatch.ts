import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { applyPatch, parsePatch } from 'diff';
import { z } from 'zod';
import { resolveWorkspacePath } from '../../security/workspacePath.js';
import { ensureParent, readText } from '../services/files.js';
import type { AgentTool, ToolContext } from '../types.js';

const maxPatchBytes = 256 * 1024;
const schema = z.object({ patch: z.string().min(1).max(maxPatchBytes) });

/** 去除标准 unified diff 前缀并拒绝含糊或特殊文件名。 */
function parseFilename(filename: string | undefined): string {
  if (!filename || filename.startsWith('"') || filename.includes('\0')) throw new Error('补丁文件名无效');
  return filename.replace(/^[ab]\//, '');
}

/** 获取用于检测确认期间文件替换和编辑的稳定属性。 */
async function fingerprint(target: string): Promise<string | null> {
  try {
    const info = await lstat(target, { bigint: true });
    if (!info.isFile() || info.nlink > 1n) throw new Error('只允许修改无硬链接的普通文件');
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** 复检目标的解析路径、文件标识及完整原文，拒绝过期授权。 */
async function assertUnchanged(context: ToolContext, filename: string, target: string, original: string, stamp: string | null): Promise<void> {
  context.signal.throwIfAborted();
  if (await resolveWorkspacePath(context.workspace, filename, true) !== target) throw new Error('补丁路径已变化');
  if (await fingerprint(target) !== stamp) throw new Error('文件已变化，补丁确认已过期');
  if (stamp !== null) {
    const current = await readText(context, filename, 1024 * 1024);
    if (current.truncated || current.content !== original) throw new Error('文件内容已变化');
  }
}

export const applyPatchTool: AgentTool = {
  name: 'applyPatch',
  description: '确认原始单文件 unified diff 后精确增删改文本。不支持重命名、二进制、多文件或 Git 元数据。',
  schema,
  /** 验证和预览补丁，确认后再次核对文件并执行增删改。 */
  async execute(input, context) {
    const { patch } = schema.parse(input);
    if (Buffer.byteLength(patch) > maxPatchBytes) throw new Error('补丁超过 256 KiB');
    if (/^(rename (from|to)|copy (from|to)|GIT binary patch|Binary files|old mode|new mode|new file mode 120000)/m.test(patch)) {
      throw new Error('不支持重命名、复制、模式变更或二进制补丁');
    }
    const patches = parsePatch(patch);
    if (patches.length !== 1 || patches[0]!.hunks.length === 0) throw new Error('只支持非空单文件 unified diff');
    const parsed = patches[0]!;
    const oldPath = parseFilename(parsed.oldFileName);
    const newPath = parseFilename(parsed.newFileName);
    const creating = oldPath === '/dev/null';
    const deleting = newPath === '/dev/null';
    if ((creating && deleting) || (!creating && !deleting && oldPath !== newPath)) throw new Error('禁止重命名或无效补丁路径');
    const filename = creating ? newPath : oldPath;
    const target = await resolveWorkspacePath(context.workspace, filename, creating);
    const stamp = await fingerprint(target);
    if (creating ? stamp !== null : stamp === null) throw new Error('新增目标已存在或修改目标不存在');
    const source = creating ? { content: '', truncated: false } : await readText(context, filename, 1024 * 1024);
    if (source.truncated) throw new Error('补丁目标超过 1 MiB');
    const updated = applyPatch(source.content, parsed, { fuzzFactor: 0, autoConvertLineEndings: false });
    if (updated === false || (deleting && updated !== '')) throw new Error('补丁无法精确匹配原文件');
    const approved = await context.confirm({ title: `应用补丁：${filename}`, detail: patch }, context.signal);
    context.signal.throwIfAborted();
    if (!approved) throw new Error('用户拒绝应用补丁');
    await assertUnchanged(context, filename, target, source.content, stamp);
    if (deleting) {
      await unlink(target);
    } else {
      if (creating) await ensureParent(context, target);
      await assertUnchanged(context, filename, target, source.content, stamp);
      const flags = creating
        ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
        : constants.O_RDWR | constants.O_NOFOLLOW;
      const handle = await open(target, flags, 0o600);
      try {
        if (!creating) {
          const info = await handle.stat({ bigint: true });
          const currentStamp = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
          if (currentStamp !== stamp) throw new Error('文件已被替换，取消写入');
        }
        context.signal.throwIfAborted();
        await handle.writeFile(updated, 'utf8');
        await handle.truncate(Buffer.byteLength(updated));
      } finally {
        await handle.close();
      }
    }
    return { path: path.relative(await resolveWorkspacePath(context.workspace, '.'), target), action: creating ? 'created' : deleting ? 'deleted' : 'updated' };
  },
};
