import type { z } from 'zod';
import type { ModelProvider } from '../providers/types.js';

export interface PermissionRequest {
  title: string;
  detail: string;
}

export type Confirm = (request: PermissionRequest, signal: AbortSignal) => Promise<boolean>;

export interface ToolContext {
  workspace: string;
  signal: AbortSignal;
  confirm: Confirm;
  provider: ModelProvider;
}

export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodType;
  /** 执行已经通过注册表参数校验的工具请求。 */
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}
