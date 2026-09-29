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

export interface WebSession {
  id: string;
  title: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  busy: boolean;
  status: string;
  startedAt: number | null;
  messages: WebMessage[];
  response: string;
  tools: WebTool[];
  permission: WebPermission | null;
}

export interface WebState {
  model: string;
  imageModel: string;
  workspace: string;
  sessions: WebSession[];
}

export type WebEvent =
  | { type: 'state'; state: WebState }
  | { type: 'session'; session: WebSession };

export interface InspectInput {
  kind: 'files' | 'file' | 'diff';
  path?: string;
}
