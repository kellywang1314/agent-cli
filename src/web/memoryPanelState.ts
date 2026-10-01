import type { WebMemory } from './types.js';

const categoryOrder = ['rule', 'decision', 'fact', 'preference'] as const;

/** 按固定类别顺序返回非空的正式记忆分组。 */
export function groupMemoriesByCategory(memories: WebMemory[]) {
  return categoryOrder
    .map((category) => ({
      category,
      memories: memories.filter((memory) => memory.category === category),
    }))
    .filter(({ memories: items }) => items.length > 0);
}

/** 判断外部状态变化是否需要刷新面板，同时避免写操作期间并发读取。 */
export function shouldRefreshMemoryState(
  previousToken: string | undefined,
  refreshToken: string | undefined,
  pending: boolean,
): boolean {
  return !pending && refreshToken !== undefined && refreshToken !== previousToken;
}
