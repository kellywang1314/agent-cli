import { open } from 'node:fs/promises';
import { resolveWorkspacePath } from '../security/workspacePath.js';

/** 有限读取项目根目录说明；缺失或越界的文件不进入模型上下文。 */
export async function collectProjectContext(workspace: string): Promise<string> {
  const sections: string[] = [];
  for (const name of ['README.md', 'AGENTS.md']) {
    try {
      const filePath = await resolveWorkspacePath(workspace, name);
      const handle = await open(filePath, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile()) continue;
        const buffer = Buffer.alloc(16 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        sections.push(`--- ${name}（项目资料） ---\n${buffer.subarray(0, bytesRead).toString('utf8')}${info.size > bytesRead ? '\n[已截断]' : ''}`);
      } finally {
        await handle.close();
      }
    } catch {
      // 项目说明可选，缺失或不允许读取不影响启动。
    }
  }
  return sections.join('\n\n');
}
