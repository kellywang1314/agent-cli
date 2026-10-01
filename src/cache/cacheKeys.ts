import { createHash } from 'node:crypto';
import { z } from 'zod';

const storedMemorySchema = z.object({
  id: z.string(),
  workspace: z.string(),
  category: z.enum(['rule', 'decision', 'fact', 'preference']),
  content: z.string(),
  normalizedContent: z.string(),
  active: z.boolean(),
  sourceSessionId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();

export const storedMemoriesCacheSchema = z.array(storedMemorySchema).max(50);
export const memoryInvalidationEventSchema = z.object({
  version: z.literal(1),
  resource: z.literal('memory'),
  workspaceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  action: z.literal('invalidate'),
}).strict();
export const memoryInvalidationChannel = 'agent-cli:v1:events:invalidate';

/** 将规范化工作区路径转换为不泄露原文的稳定摘要。 */
export function hashWorkspace(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex');
}

/** 生成启用记忆缓存 Key。 */
export function activeMemoriesCacheKey(workspace: string): string {
  return `agent-cli:v1:memory:${hashWorkspace(workspace)}:active`;
}
