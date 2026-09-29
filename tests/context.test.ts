import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { collectProjectContext } from '../src/context/projectContext.js';

it('收集根目录说明，越界链接不读入上下文', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-context-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-context-outside-'));
  try {
    await writeFile(path.join(workspace, 'README.md'), '本项目说明');
    await writeFile(path.join(outside, 'secret'), '外部数据');
    await symlink(path.join(outside, 'secret'), path.join(workspace, 'AGENTS.md'));
    const context = await collectProjectContext(workspace);
    expect(context).toContain('本项目说明');
    expect(context).not.toContain('外部数据');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
