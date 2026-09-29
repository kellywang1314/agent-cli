import { z } from 'zod';

const toolCallSchema = z.strictObject({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.strictObject({
    name: z.string().min(1),
    arguments: z.string(),
  }),
});

export const persistedAgentMessageSchema = z.discriminatedUnion('role', [
  z.strictObject({
    role: z.literal('user'),
    content: z.string(),
  }),
  z.strictObject({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    tool_calls: z.array(toolCallSchema).optional(),
  }).refine(
    (message) => Boolean(message.content?.trim()) || Boolean(message.tool_calls?.length),
    'assistant 消息必须包含有效文本或工具调用',
  ),
  z.strictObject({
    role: z.literal('tool'),
    tool_call_id: z.string().min(1),
    content: z.string(),
  }),
]);
