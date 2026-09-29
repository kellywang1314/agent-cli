import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

/** 判断路径是否处于工作区内部并排除 Git 元数据。 */
function assertContained(workspace: string, candidate: string): void {
  const relativePath = path.relative(workspace, candidate);
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error('路径超出工作区');
  }
  if (relativePath.split(path.sep).some((part) => part.toLowerCase() === '.git')) {
    throw new Error('禁止访问 .git');
  }
}

/** 逐级解析现有父路径，拒绝越界、Git 路径和悬空链接且不产生副作用。 */
export async function resolveWorkspacePath(workspace: string, inputPath: string, allowMissing = false): Promise<string> {
  if (inputPath.includes('\0') || inputPath.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')) {
    throw new Error('非法路径或禁止访问 .git');
  }
  const root = await realpath(workspace);
  const requestedRoot = path.resolve(workspace);
  let candidate = path.resolve(requestedRoot, inputPath);
  if (candidate === requestedRoot || candidate.startsWith(`${requestedRoot}${path.sep}`)) {
    candidate = path.resolve(root, path.relative(requestedRoot, candidate));
  }
  assertContained(root, candidate);
  let current = root;
  const parts = path.relative(root, candidate).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const next = path.join(current, parts[index]!);
    let exists = true;
    try {
      await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) throw error;
      exists = false;
    }
    if (!exists) {
      current = path.join(next, ...parts.slice(index + 1));
      assertContained(root, current);
      return current;
    }
    // lstat 成功而 realpath 失败表示悬空链接，不能当作待新增文件。
    current = await realpath(next);
    assertContained(root, current);
  }
  return current;
}
