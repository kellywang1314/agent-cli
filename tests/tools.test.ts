import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPatch } from 'diff';
import { resolveWorkspacePath } from '../src/security/workspacePath.js';
import { PermissionGate } from '../src/security/PermissionGate.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { runProcess } from '../src/tools/services/process.js';
import type { ToolContext } from '../src/tools/types.js';

let workspace: string;
let outside: string;
let context: ToolContext;
let registry: ToolRegistry;

/** 创建完全隔离的临时工作区及图片提供方。 */
async function setupWorkspace(): Promise<void> {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'agent-tools-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'agent-outside-')));
  context = {
    workspace,
    signal: new AbortController().signal,
    confirm: vi.fn(async () => true),
    provider: {
      chat: vi.fn(),
      generateImage: vi.fn(async () => Buffer.from('image-data')),
    },
  };
  registry = new ToolRegistry();
}

/** 删除测试创建的临时目录。 */
async function cleanupWorkspace(): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}

beforeEach(setupWorkspace);
afterEach(cleanupWorkspace);

describe('workspacePath', () => {
  it('允许缺失父路径且不创建目录', async () => {
    expect(await resolveWorkspacePath(workspace, 'new/deep/file', true)).toBe(join(workspace, 'new/deep/file'));
    await expect(access(join(workspace, 'new'))).rejects.toThrow();
    await expect(resolveWorkspacePath(workspace, 'absent')).rejects.toThrow();
  });
  it('拒绝越界、git、外部链接和悬空链接', async () => {
    await mkdir(join(workspace, '.git'));
    await symlink(outside, join(workspace, 'external'));
    await symlink(join(workspace, 'absent'), join(workspace, 'dangling'));
    await symlink(join(workspace, '.git'), join(workspace, 'gitAlias'));
    for (const path of ['../escape', outside, '.git/config', 'external/file', 'dangling/file', 'gitAlias/config', '.git/../escape']) {
      await expect(resolveWorkspacePath(workspace, path, true)).rejects.toThrow();
    }
  });
  it('解析工作区内合法符号链接', async () => {
    await mkdir(join(workspace, 'actual'));
    await symlink(join(workspace, 'actual'), join(workspace, 'alias'));
    expect(await resolveWorkspacePath(workspace, 'alias/new', true)).toBe(join(workspace, 'actual/new'));
  });
});

describe('PermissionGate', () => {
  it('已中断信号返回被拒绝的 Promise 而不弹出确认', async () => {
    const controller = new AbortController();
    controller.abort();
    const onRequest = vi.fn();
    const gate = new PermissionGate(onRequest);
    await expect(gate.request({ title: 'title', detail: '' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(onRequest).not.toHaveBeenCalled();
  });
  it('响应后清除界面并拒绝并发确认', async () => {
    const onRequest = vi.fn();
    const gate = new PermissionGate(onRequest);
    const pending = gate.request({ title: 'title', detail: 'detail' }, context.signal);
    await expect(gate.request({ title: 'second', detail: '' }, context.signal)).rejects.toThrow();
    gate.respond(true);
    expect(await pending).toBe(true);
    expect(onRequest).toHaveBeenLastCalledWith(null);
    gate.respond(false);
  });
  it('中断拒绝并清理待确认状态', async () => {
    const controller = new AbortController();
    const onRequest = vi.fn();
    const gate = new PermissionGate(onRequest);
    const pending = gate.request({ title: 'title', detail: '' }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(onRequest).toHaveBeenLastCalledWith(null);
    const next = gate.request({ title: 'next', detail: '' }, context.signal);
    gate.respond(false);
    expect(await next).toBe(false);
  });
});

describe('工具注册和读取', () => {
  it('暴露七种 schema，参数异常返回错误，中断向外抛出', async () => {
    expect(registry.getDefinitions()).toHaveLength(7);
    expect(await registry.execute('unknown', {}, context)).toHaveProperty('error');
    expect(await registry.execute('readFile', { path: 1 }, context)).toHaveProperty('error');
    const controller = new AbortController();
    controller.abort();
    await expect(registry.execute('listFiles', {}, { ...context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('读取、遍历与文字搜索拒绝隐私文件和目录链接', async () => {
    await writeFile(join(workspace, 'hello.txt'), 'hello world\nsecond hello\n');
    await writeFile(join(workspace, '.env'), 'hello SECRET');
    await mkdir(join(workspace, 'node_modules'));
    await writeFile(join(workspace, 'node_modules', 'secret'), 'hello');
    await symlink(outside, join(workspace, 'external'));
    expect(await registry.execute('readFile', { path: 'hello.txt' }, context)).toMatchObject({ content: 'hello world\nsecond hello\n', truncated: false });
    const listed = await registry.execute('listFiles', {}, context);
    expect(JSON.stringify(listed)).toContain('hello.txt');
    expect(JSON.stringify(listed)).not.toContain('.env');
    expect(JSON.stringify(listed)).not.toContain('node_modules');
    const result = await registry.execute('search', { query: 'hello' }, context);
    expect(result).toMatchObject({ matches: [{ path: 'hello.txt', line: 1, text: 'hello world' }, { path: 'hello.txt', line: 2, text: 'second hello' }] });
    expect(await registry.execute('readFile', { path: '.env' }, context)).toHaveProperty('error');
  });
  it('读取有字节上限并拒绝二进制', async () => {
    await writeFile(join(workspace, 'large'), 'x'.repeat(100_000));
    expect(await registry.execute('readFile', { path: 'large', maxBytes: 32 }, context)).toMatchObject({ content: 'x'.repeat(32), truncated: true });
    await writeFile(join(workspace, 'binary'), Buffer.from([0, 1, 2]));
    expect(await registry.execute('readFile', { path: 'binary' }, context)).toHaveProperty('error');
  });
  it('列表和搜索遵守数量限制，UTF8 截断不破坏字符', async () => {
    await writeFile(join(workspace, 'one'), 'match\nmatch\n');
    await writeFile(join(workspace, 'two'), 'match\n');
    expect(await registry.execute('listFiles', { maxEntries: 1 }, context)).toMatchObject({ files: expect.any(Array), truncated: true });
    const result = await registry.execute('search', { query: 'match', maxResults: 1 }, context) as { matches: unknown[]; truncated: boolean };
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
    await writeFile(join(workspace, 'unicode'), '你好');
    expect(await registry.execute('readFile', { path: 'unicode', maxBytes: 4 }, context)).toMatchObject({ content: '你', truncated: true });
    await symlink(join(workspace, 'one'), join(workspace, 'fileAlias'));
    expect(await registry.execute('readFile', { path: 'fileAlias' }, context)).toMatchObject({ content: 'match\nmatch\n' });
  });
});

describe('补丁', () => {
  it('只修改第二行的补丁保留文件开头的 UTF-8 BOM', async () => {
    const original = '\uFEFFfirst\nold\n';
    const updated = '\uFEFFfirst\nnew\n';
    const patch = '--- a/bom.txt\n+++ b/bom.txt\n@@ -2 +2 @@\n-old\n+new\n';
    await writeFile(join(workspace, 'bom.txt'), original);
    context.confirm = vi.fn(async () => {
      expect(await readFile(join(workspace, 'bom.txt'))).toEqual(Buffer.from(original));
      return true;
    });
    expect(await registry.execute('applyPatch', { patch }, context)).not.toHaveProperty('error');
    expect(context.confirm).toHaveBeenCalledWith(expect.objectContaining({ detail: patch }), context.signal);
    expect(await readFile(join(workspace, 'bom.txt'))).toEqual(Buffer.from(updated));
  });
  it('确认后增改删单文件并展示原始补丁', async () => {
    const addPatch = '--- /dev/null\n+++ b/new/file.txt\n@@ -0,0 +1 @@\n+hello\n';
    expect(await registry.execute('applyPatch', { patch: addPatch }, context)).not.toHaveProperty('error');
    expect(await readFile(join(workspace, 'new/file.txt'), 'utf8')).toBe('hello\n');
    expect(context.confirm).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining(addPatch) }), context.signal);
    expect(await registry.execute('applyPatch', { patch: createPatch('new/file.txt', 'hello\n', 'updated\n') }, context)).not.toHaveProperty('error');
    expect(await readFile(join(workspace, 'new/file.txt'), 'utf8')).toBe('updated\n');
    expect(await registry.execute('applyPatch', { patch: '--- a/new/file.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-updated\n' }, context)).not.toHaveProperty('error');
    await expect(access(join(workspace, 'new/file.txt'))).rejects.toThrow();
  });
  it('拒绝确认无副作用且过期补丁不得覆盖新内容', async () => {
    context.confirm = vi.fn(async () => false);
    expect(await registry.execute('applyPatch', { patch: '--- /dev/null\n+++ b/new/deep/file\n@@ -0,0 +1 @@\n+hello\n' }, context)).toHaveProperty('error');
    await expect(access(join(workspace, 'new'))).rejects.toThrow();
    await writeFile(join(workspace, 'file'), 'old\n');
    context.confirm = vi.fn(async () => {
      await writeFile(join(workspace, 'file'), 'changed\n');
      return true;
    });
    expect(await registry.execute('applyPatch', { patch: createPatch('file', 'old\n', 'new\n') }, context)).toHaveProperty('error');
    expect(await readFile(join(workspace, 'file'), 'utf8')).toBe('changed\n');
  });
  it('拒绝重命名、多文件、不匹配内容和越界路径', async () => {
    await writeFile(join(workspace, 'file'), 'real\n');
    for (const patch of [
      '--- a/file\n+++ b/renamed\n@@ -1 +1 @@\n-real\n+new\n',
      createPatch('file', 'wrong\n', 'new\n'),
      createPatch('../outside', '', 'new\n'),
      createPatch('file', 'real\n', 'new\n') + createPatch('second', '', 'new\n'),
    ]) {
      expect(await registry.execute('applyPatch', { patch }, context)).toHaveProperty('error');
    }
    expect(context.confirm).not.toHaveBeenCalled();
  });
  it('确认期间父目录替换为外链后拒绝写入', async () => {
    await mkdir(join(workspace, 'sub'));
    await writeFile(join(workspace, 'sub/file'), 'old\n');
    context.confirm = vi.fn(async () => {
      await rm(join(workspace, 'sub'), { recursive: true });
      await symlink(outside, join(workspace, 'sub'));
      return true;
    });
    expect(await registry.execute('applyPatch', { patch: createPatch('sub/file', 'old\n', 'new\n') }, context)).toHaveProperty('error');
    await expect(access(join(outside, 'file'))).rejects.toThrow();
  });
});

describe('命令与差异', () => {
  it('非 UTF-8 输出膨胀后按完整码点裁剪到字节上限', async () => {
    const result = await runProcess(process.execPath, ['-e',
      "process.stdout.write(Buffer.concat([Buffer.alloc(21844, 0xff), Buffer.from('x\\u{1f600}')]));",
    ], workspace, context.signal);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, truncated: true });
    expect(result.output.endsWith('x')).toBe(true);
    expect(result.output).toBe('\uFFFD'.repeat(21844) + 'x');
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(65536);
  });
  it.each(['clean', 'process'])('Git 不执行本地 %s filter 且保留真实未暂存差异', async (filterKind) => {
    execFileSync('git', ['init', '-q', workspace]);
    await writeFile(join(workspace, 'tracked'), 'before\n');
    execFileSync('git', ['-C', workspace, 'add', 'tracked']);
    await writeFile(join(workspace, 'tracked'), 'after\n');
    await writeFile(join(workspace, '.gitattributes'), 'tracked filter=unsafe\n');
    execFileSync('git', ['-C', workspace, 'config', `filter.unsafe.${filterKind}`, 'touch filter-marker; cat']);
    execFileSync('git', ['-C', workspace, 'config', 'filter.unsafe.required', 'true']);
    const result = await registry.execute('getDiff', {}, context);
    expect(context.confirm).not.toHaveBeenCalled();
    await expect(access(join(workspace, 'filter-marker'))).rejects.toThrow();
    expect(result).not.toHaveProperty('error');
    expect(result).toMatchObject({ diff: expect.stringContaining('-before\n+after') });
  });
  it.each(['include', 'global', 'xdg', 'system', 'worktree'])('Git 禁用 %s 配置中的 filter', async (configSource) => {
    execFileSync('git', ['init', '-q', workspace]);
    await writeFile(join(workspace, 'tracked'), 'before\n');
    execFileSync('git', ['-C', workspace, 'add', 'tracked']);
    await writeFile(join(workspace, 'tracked'), 'after\n');
    await writeFile(join(workspace, '.gitattributes'), 'tracked filter=Mixed.Case=driver\n');
    const configPath = join(outside, 'filters.config');
    execFileSync('git', ['config', '--file', configPath, 'filter.Mixed.Case=driver.clean', 'touch filter-marker; cat']);
    execFileSync('git', ['config', '--file', configPath, 'filter.Mixed.Case=driver.required', 'true']);
    if (configSource === 'include') {
      execFileSync('git', ['-C', workspace, 'config', `includeIf.gitdir:${workspace}/.git.path`, configPath]);
    } else if (configSource === 'worktree') {
      execFileSync('git', ['-C', workspace, 'config', 'extensions.worktreeConfig', 'true']);
      execFileSync('git', ['-C', workspace, 'config', '--worktree', 'include.path', configPath]);
    } else if (configSource === 'global') {
      await writeFile(join(outside, '.gitconfig'), `[include]\npath = ${configPath}\n`);
    } else if (configSource === 'system') {
      const gitBinary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const binPath = join(outside, 'bin');
      const systemPath = join(outside, 'system.config');
      await mkdir(binPath);
      await writeFile(systemPath, `[include]\npath = ${configPath}\n`);
      // 用启动包装指定测试专属系统配置，不修改宿主机 /etc/gitconfig。
      await writeFile(join(binPath, 'git'), `#!/bin/sh\nGIT_CONFIG_SYSTEM='${systemPath}' exec '${gitBinary}' "$@"\n`, { mode: 0o755 });
      vi.stubEnv('PATH', `${binPath}:${process.env.PATH}`);
    } else {
      await mkdir(join(outside, 'git'));
      await writeFile(join(outside, 'git/config'), `[include]\npath = ${configPath}\n`);
    }
    vi.stubEnv('HOME', outside);
    vi.stubEnv('XDG_CONFIG_HOME', outside);
    try {
      const result = await registry.execute('getDiff', {}, context);
      expect(context.confirm).not.toHaveBeenCalled();
      await expect(access(join(workspace, 'filter-marker'))).rejects.toThrow();
      expect(result).not.toHaveProperty('error');
      expect(result).toMatchObject({ diff: expect.stringContaining('-before\n+after') });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('Git filter 配置枚举被截断时拒绝运行差异命令', async () => {
    execFileSync('git', ['init', '-q', workspace]);
    await writeFile(join(workspace, 'tracked'), 'before\n');
    execFileSync('git', ['-C', workspace, 'add', 'tracked']);
    await writeFile(join(workspace, 'tracked'), 'after\n');
    await writeFile(join(workspace, '.gitattributes'), 'tracked filter=unsafe\n');
    const configPath = join(outside, 'large.config');
    await writeFile(configPath, `[filter "${'a'.repeat(128)}"]\nclean =\n`.repeat(600)
      + '[filter "unsafe"]\nclean = "touch filter-marker; cat"\nrequired = true\n');
    execFileSync('git', ['-C', workspace, 'config', 'include.path', configPath]);
    expect(await registry.execute('getDiff', {}, context)).toMatchObject({
      error: '无法完整读取 Git filter 配置，取消差异读取',
    });
    expect(context.confirm).not.toHaveBeenCalled();
    await expect(access(join(workspace, 'filter-marker'))).rejects.toThrow();
  });
  it('Git 忽略已有配置注入和仓库重定向环境变量', async () => {
    execFileSync('git', ['init', '-q', workspace]);
    await writeFile(join(workspace, 'tracked'), 'before\n');
    execFileSync('git', ['-C', workspace, 'add', 'tracked']);
    await writeFile(join(workspace, 'tracked'), 'after\n');
    await writeFile(join(workspace, '.gitattributes'), 'tracked filter=unsafe\n');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'filter.unsafe.clean');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'touch filter-marker; cat');
    vi.stubEnv('GIT_CONFIG_PARAMETERS', "'filter.unsafe.process=touch filter-marker; cat'");
    vi.stubEnv('GIT_DIR', join(outside, 'not-a-repository'));
    vi.stubEnv('GIT_WORK_TREE', outside);
    vi.stubEnv('GIT_CONFIG', join(outside, 'missing.config'));
    vi.stubEnv('GIT_EXTERNAL_DIFF', 'touch filter-marker');
    try {
      const result = await registry.execute('getDiff', {}, context);
      expect(result).toMatchObject({ diff: expect.stringContaining('-before\n+after') });
      expect(context.confirm).not.toHaveBeenCalled();
      await expect(access(join(workspace, 'filter-marker'))).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('拒绝空白命令且不显示确认', async () => {
    expect(await registry.execute('runCommand', { command: ' \n\t ' }, context)).toHaveProperty('error');
    expect(context.confirm).not.toHaveBeenCalled();
  });
  it('命令过滤模拟密钥并保留非零退出码和标准错误', async () => {
    vi.stubEnv('AIDP_TOOL_TEST_SECRET', 'fake-test-value');
    vi.stubEnv('OPENAI_TOOL_TEST_SECRET', 'fake-test-value');
    try {
      expect(await registry.execute('runCommand', { command: 'printf "%s/%s" "${AIDP_TOOL_TEST_SECRET-unset}" "${OPENAI_TOOL_TEST_SECRET-unset}"; printf error >&2; exit 7' }, context)).toMatchObject({
        output: 'unset/unseterror', exitCode: 7, timedOut: false,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('命令需要确认且返回执行结果和字节截断', async () => {
    expect(await registry.execute('runCommand', { command: 'printf hello' }, context)).toMatchObject({ exitCode: 0, output: 'hello', timedOut: false, truncated: false });
    expect(context.confirm).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('系统用户权限') }), context.signal);
    const result = await registry.execute('runCommand', { command: "yes x | head -c 100000" }, context) as { output: string; truncated: boolean };
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(65536);
    context.confirm = vi.fn(async () => false);
    expect(await registry.execute('runCommand', { command: 'touch forbidden' }, context)).toHaveProperty('error');
    await expect(access(join(workspace, 'forbidden'))).rejects.toThrow();
  });
  it('超时杀死子进程组且中断向调用者抛出', async () => {
    expect(await registry.execute('runCommand', { command: '(sleep 1; touch escaped) & wait', timeoutMs: 50 }, context)).toMatchObject({ timedOut: true });
    const controller = new AbortController();
    const pending = registry.execute('runCommand', { command: 'sleep 10' }, { ...context, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    setTimeout(() => controller.abort(), 50);
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(access(join(workspace, 'escaped'))).rejects.toThrow();
  });
  it('git差异限制在工作区并明确返回非仓库错误', async () => {
    expect(await registry.execute('getDiff', {}, context)).toHaveProperty('error');
    execFileSync('git', ['init', '-q', workspace]);
    await writeFile(join(workspace, 'tracked'), 'before\n');
    execFileSync('git', ['-C', workspace, 'add', 'tracked']);
    await writeFile(join(workspace, 'tracked'), 'after\n');
    const diff = await registry.execute('getDiff', {}, context);
    expect(JSON.stringify(diff)).toContain('+after');
    expect(context.confirm).not.toHaveBeenCalled();
  });
  it('Git 子目录范围排除兄弟文件且不执行外部 diff', async () => {
    execFileSync('git', ['init', '-q', workspace]);
    await mkdir(join(workspace, 'sub'));
    await writeFile(join(workspace, 'sibling'), 'before\n');
    await writeFile(join(workspace, 'sub/file'), 'before\n');
    execFileSync('git', ['-C', workspace, 'add', '.']);
    execFileSync('git', ['-C', workspace, 'config', 'diff.external', 'touch forbidden']);
    await writeFile(join(workspace, 'sibling'), 'sibling-after\n');
    await writeFile(join(workspace, 'sub/file'), 'sub-after\n');
    const result = await registry.execute('getDiff', {}, { ...context, workspace: join(workspace, 'sub') });
    expect(JSON.stringify(result)).toContain('+sub-after');
    expect(JSON.stringify(result)).not.toContain('sibling-after');
    await expect(access(join(workspace, 'sub/forbidden'))).rejects.toThrow();
  });
});

describe('图片', () => {
  it('拒绝时不调用提供方和创建目录', async () => {
    context.confirm = vi.fn(async () => false);
    expect(await registry.execute('generateImage', { prompt: 'A landscape' }, context)).toHaveProperty('error');
    expect(context.provider.generateImage).not.toHaveBeenCalled();
    await expect(access(join(workspace, 'generated'))).rejects.toThrow();
  });
  it('确认后独占保存，已存在文件不得覆盖', async () => {
    const result = await registry.execute('generateImage', { prompt: 'A landscape', outputPath: 'images/test.png', size: '1024x1024' }, context);
    expect(result).toMatchObject({ path: 'images/test.png' });
    expect(await readFile(join(workspace, 'images/test.png'), 'utf8')).toBe('image-data');
    expect(await registry.execute('generateImage', { prompt: 'different', outputPath: 'images/test.png' }, context)).toHaveProperty('error');
    expect(context.provider.generateImage).toHaveBeenCalledTimes(1);
  });
  it('提供方调用前及生成后均检查目标路径', async () => {
    await mkdir(join(workspace, 'images'));
    context.confirm = vi.fn(async () => {
      await rm(join(workspace, 'images'), { recursive: true });
      await symlink(outside, join(workspace, 'images'));
      return true;
    });
    expect(await registry.execute('generateImage', { prompt: 'test', outputPath: 'images/test.png' }, context)).toHaveProperty('error');
    expect(context.provider.generateImage).not.toHaveBeenCalled();
    await rm(join(workspace, 'images'));
    await mkdir(join(workspace, 'images'));
    context.confirm = vi.fn(async () => true);
    context.provider.generateImage = vi.fn(async () => {
      await rm(join(workspace, 'images'), { recursive: true });
      await symlink(outside, join(workspace, 'images'));
      return Buffer.from('fake image');
    });
    expect(await registry.execute('generateImage', { prompt: 'test', outputPath: 'images/test.png' }, context)).toHaveProperty('error');
    await expect(access(join(outside, 'test.png'))).rejects.toThrow();
  });
  it('默认图片文件名唯一，生成异常不创建输出目录', async () => {
    context.provider.generateImage = vi.fn(async () => { throw new Error('fake provider failure'); });
    expect(await registry.execute('generateImage', { prompt: 'test' }, context)).toMatchObject({ error: 'fake provider failure' });
    await expect(access(join(workspace, 'generated'))).rejects.toThrow();
    context.provider.generateImage = vi.fn(async () => Buffer.from('fake image'));
    const first = await registry.execute('generateImage', { prompt: 'test' }, context) as { path: string };
    const second = await registry.execute('generateImage', { prompt: 'test' }, context) as { path: string };
    expect(first.path).toMatch(/^generated\/.+\.png$/);
    expect(first.path).not.toBe(second.path);
  });
});
