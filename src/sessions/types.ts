import type { AgentEvent } from '../agent/AgentLoop.js';
import type {
  StoredDisplayMessage,
  StoredMemoryCandidate,
  StoredSession,
} from '../persistence/types.js';
import type { PermissionRequest } from '../tools/types.js';

export type SessionSummary = StoredSession;

export interface SessionDetail extends StoredSession {
  messages: StoredDisplayMessage[];
}

export interface SessionRunHooks {
  onAgentEvent: (event: AgentEvent) => void;
  onDisplayMessage: (message: StoredDisplayMessage) => void;
  onStatus: (status: StoredSession['status']) => void;
  confirm: (request: PermissionRequest, signal: AbortSignal) => Promise<boolean>;
}

export interface SessionRunResult {
  content: string;
  memoryExtraction: Promise<StoredMemoryCandidate[]> | null;
}
