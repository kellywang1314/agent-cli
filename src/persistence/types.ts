import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export type SessionClientType = 'web' | 'cli';
export type SessionStatus = 'idle' | 'running' | 'interrupted' | 'failed';
export type MemoryExtractionStatus = 'idle' | 'running' | 'failed' | 'complete';
export type DisplayMessageRole = 'user' | 'assistant' | 'notice';
export type MemoryCategory = 'rule' | 'decision' | 'fact' | 'preference';
export type MemoryCandidateStatus = 'pending' | 'accepted' | 'ignored';
export type StoredCandidateResolution =
  | { action: 'accept'; content: string; normalizedContent: string }
  | { action: 'ignore' };

export interface StoredSession {
  id: string;
  clientType: SessionClientType;
  workspace: string;
  title: string;
  status: SessionStatus;
  turns: number;
  memoryExtractionStatus: MemoryExtractionStatus;
  memoryExtractionError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type SessionQuery = Partial<Pick<StoredSession, 'workspace' | 'clientType'>>;
export type SessionPatch = Partial<Pick<StoredSession,
  'title' | 'status' | 'memoryExtractionStatus' | 'memoryExtractionError' | 'updatedAt'
>>;

export interface StoredDisplayMessage {
  id: string;
  sessionId: string;
  sequence: number;
  role: DisplayMessageRole;
  content: string;
  createdAt: number;
}

export type NewDisplayMessage = Omit<StoredDisplayMessage, 'sessionId' | 'sequence'>;

export interface StoredAgentMessage {
  id: string;
  sessionId: string;
  sequence: number;
  message: ChatCompletionMessageParam;
  createdAt: number;
}

export interface StoredMemoryCandidate {
  id: string;
  workspace: string;
  sourceSessionId: string;
  sourceTurn: number;
  category: MemoryCategory;
  content: string;
  normalizedContent: string;
  status: MemoryCandidateStatus;
  acceptedMemoryId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface StoredMemory {
  id: string;
  workspace: string;
  category: MemoryCategory;
  content: string;
  normalizedContent: string;
  active: boolean;
  sourceSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}
