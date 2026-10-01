import { expect, it } from 'vitest';
import {
  groupMemoriesByCategory,
  shouldRefreshMemoryState,
} from '../src/web/memoryPanelState.js';
import type { WebMemory } from '../src/web/types.js';

/** 创建仅覆盖面板分组所需字段的正式记忆。 */
function createMemory(
  id: string,
  category: WebMemory['category'],
): WebMemory {
  return {
    id,
    category,
    content: id,
    active: true,
    updatedAt: 1,
  };
}

it('按固定类别顺序分组并省略空分组', () => {
  const groups = groupMemoriesByCategory([
    createMemory('preference', 'preference'),
    createMemory('fact', 'fact'),
    createMemory('rule', 'rule'),
  ]);

  expect(groups.map(({ category }) => category)).toEqual([
    'rule',
    'fact',
    'preference',
  ]);
  expect(groups.map(({ memories }) => memories[0]?.id)).toEqual([
    'rule',
    'fact',
    'preference',
  ]);
});

it('仅在外部刷新信号变化且没有写操作时刷新', () => {
  expect(shouldRefreshMemoryState('idle:0', 'complete:2', false)).toBe(true);
  expect(shouldRefreshMemoryState('complete:2', 'complete:2', false)).toBe(false);
  expect(shouldRefreshMemoryState('idle:0', 'complete:2', true)).toBe(false);
  expect(shouldRefreshMemoryState(undefined, undefined, false)).toBe(false);
});
