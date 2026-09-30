import type { StoredMemory, StoredMemoryCandidate } from '../persistence/types.js';

export interface MemoryExtractionInput {
  workspace: string;
  sessionId: string;
  sourceTurn: number;
  userPrompt: string;
  assistantResponse: string;
  toolResults: string[];
  signal: AbortSignal;
}

export type CandidateDecision =
  | { action: 'accept'; content?: string }
  | { action: 'ignore' };

export interface MemoryState {
  extractionStatus: 'idle' | 'running' | 'failed' | 'complete';
  extractionError: string | null;
  candidates: StoredMemoryCandidate[];
  memories: StoredMemory[];
}
