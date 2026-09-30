export interface WebMessage {
  id: string;
  role: 'user' | 'assistant' | 'notice';
  content: string;
  createdAt: number;
}

export interface WebTool {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  result: string;
  elapsedMs?: number;
}

export interface WebPermission {
  id: string;
  title: string;
  detail: string;
}

export interface WebSessionSummary {
  id: string;
  title: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  busy: boolean;
  status: string;
  startedAt: number | null;
  pendingMemoryCount: number;
  memoryExtractionStatus: 'idle' | 'running' | 'failed' | 'complete';
}

export interface WebSession extends WebSessionSummary {
  messages: WebMessage[];
  response: string;
  tools: WebTool[];
  permission: WebPermission | null;
}

export interface WebState {
  model: string;
  imageModel: string;
  workspace: string;
  sessions: WebSessionSummary[];
}

export type WebEvent =
  | { type: 'state'; state: WebState }
  | { type: 'sessionSummary'; session: WebSessionSummary }
  | { type: 'sessionDetail'; session: WebSession };

export interface InspectInput {
  kind: 'files' | 'file' | 'diff';
  path?: string;
}
