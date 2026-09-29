import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { PermissionPrompt } from '../src/ui/PermissionPrompt.js';

afterEach(cleanup);

it('长补丁在固定高度内分页，能够前后查阅全部内容', async () => {
  const detail = Array.from({ length: 60 }, (_, index) => `补丁第${index + 1}行`).join('\n');
  const view = render(<PermissionPrompt request={{ title: '应用补丁', detail }} />);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('第 1/4 页'));
  expect(view.lastFrame()).toContain('补丁第1行');
  expect(view.lastFrame()).not.toContain('补丁第60行');
  expect(view.lastFrame()?.split('\n').length).toBeLessThanOrEqual(24);
  for (let page = 2; page <= 4; page++) {
    view.stdin.write('\u001b[C');
    await vi.waitFor(() => expect(view.lastFrame()).toContain(`第 ${page}/4 页`));
  }
  expect(view.lastFrame()).toContain('补丁第60行');
  view.stdin.write('\u001b[D');
  await vi.waitFor(() => expect(view.lastFrame()).toContain('第 3/4 页'));
});

it('Tab 缩进先展开再分页，终端收到的行不会超出宽度', async () => {
  const detail = Array.from({ length: 60 }, () => `+\t\t${'x'.repeat(90)}`).join('\n');
  const view = render(<PermissionPrompt request={{ title: '带 Tab 的补丁', detail }} />);
  await vi.waitFor(() => expect(view.lastFrame()).toContain('y/N'));
  expect(view.lastFrame()).not.toContain('\t');
  expect(view.lastFrame()?.split('\n').length).toBeLessThanOrEqual(24);
  expect(view.lastFrame()?.split('\n').every((line) => line.length <= 100)).toBe(true);
});
