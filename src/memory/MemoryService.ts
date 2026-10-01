import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  NullCacheService,
  type CacheService,
} from '../cache/CacheService.js';
import {
  activeMemoriesCacheKey,
  hashWorkspace,
  memoryInvalidationChannel,
  storedMemoriesCacheSchema,
} from '../cache/cacheKeys.js';
import type { PersistenceStore } from '../persistence/PersistenceStore.js';
import type {
  StoredMemory,
  StoredMemoryCandidate,
} from '../persistence/types.js';
import type { ModelProvider } from '../providers/types.js';
import { createMemoryExtractionPrompt, createMemorySystemPrompt } from './memoryPrompt.js';
import type {
  CandidateDecision,
  MemoryExtractionInput,
  MemoryState,
} from './types.js';

const maxRuntimeMemoryCount = 50;
const maxRuntimeInstructionBytes = 12 * 1024;
const maxExtractionMemoryBytes = 12 * 1024;
const maxExtractionErrorBytes = 512;
const extractionSchema = z.object({
  candidates: z.array(z.object({
    category: z.enum(['rule', 'decision', 'fact', 'preference']),
    content: z.string().trim().min(1).max(1000),
  })).max(5),
});
const memoryContentSchema = z.string().trim().min(1).max(1000);

class MemoryExtractionFormatError extends Error {
  /** 创建统一的模型提取格式错误。 */
  constructor() {
    super('记忆提取结果格式无效');
  }
}

/** 忽略模型提取过程中的流式文本。 */
function noop(): void {}

/** 在 UTF-8 字节边界内截取文本，避免破坏多字节字符。 */
function truncateUtf8(text: string, maxBytes: number): string {
  let result = '';
  let byteLength = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (byteLength + characterBytes > maxBytes) break;
    result += character;
    byteLength += characterBytes;
  }
  return result;
}

/** 生成稳定的精确去重键。 */
export function normalizeMemoryContent(content: string): string {
  return content.normalize('NFKC').trim().replace(/\s+/gu, ' ').replace(
    /[A-Z]/g,
    (character) => character.toLowerCase(),
  );
}

/** 拒绝不应进入长期存储的常见凭据。 */
export function containsPotentialSecret(content: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+\S{16,}|(?:sk|ak)-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:xox[a-z]|xapp|xwfp)-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i
    .test(content);
}

/** 在 JSON UTF-8 上限内选择完整记忆，不截断任何单条内容。 */
function selectExtractionMemories(contents: string[]): string[] {
  const selected: string[] = [];
  for (const content of contents) {
    const next = [...selected, content];
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > maxExtractionMemoryBytes) break;
    selected.push(content);
  }
  return selected;
}

export class MemoryService {
  private readonly extractionQueues = new Map<string, Promise<void>>();

  /** 创建使用共享数据库和模型 Provider 的记忆服务。 */
  constructor(
    private readonly store: PersistenceStore,
    private readonly provider: ModelProvider,
    private readonly sanitize: (text: string) => string,
    private readonly cache: CacheService = new NullCacheService(),
    private readonly cacheTtlSeconds = 300,
  ) {}

  /** 从 Redis 读取启用记忆，未命中或数据无效时回源 SQLite。 */
  private async listActiveMemories(workspace: string): Promise<StoredMemory[]> {
    const key = activeMemoriesCacheKey(workspace);
    const cached = await this.cache.getJson(key);
    if (cached !== null) {
      const parsed = storedMemoriesCacheSchema.safeParse(cached);
      if (parsed.success) return parsed.data;
      await this.cache.delete(key);
    }
    const memories = this.store.listMemories(workspace, true, maxRuntimeMemoryCount);
    await this.cache.setJson(key, memories, this.cacheTtlSeconds);
    return memories;
  }

  /** 在 SQLite 成功写入后依次失效共享缓存并发布无正文事件。 */
  private async invalidateMemoryCache(workspace: string): Promise<void> {
    await this.cache.delete(activeMemoriesCacheKey(workspace));
    await this.cache.publish(memoryInvalidationChannel, {
      version: 1,
      resource: 'memory',
      workspaceHash: hashWorkspace(workspace),
      action: 'invalidate',
    });
  }

  /** 将任意错误转换为脱敏、单行且有字节上限的持久化错误。 */
  private createExtractionError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const sanitized = this.sanitize(message).replace(/\s+/gu, ' ').trim()
      || '记忆提取失败';
    return truncateUtf8(sanitized, maxExtractionErrorBytes);
  }

  /** 清洗并严格校验人工确认或编辑的记忆内容。 */
  private validateMemoryContent(content: string): string {
    const parsed = memoryContentSchema.safeParse(this.sanitize(content));
    if (!parsed.success) throw new Error('记忆内容无效');
    if (containsPotentialSecret(parsed.data)) throw new Error('记忆内容包含潜在敏感信息');
    return parsed.data;
  }

  /** 在调用会话的工作区内查找候选，避免跨工作区读取其原文。 */
  private findWorkspaceCandidate(
    sessionId: string,
    candidateId: string,
  ): StoredMemoryCandidate {
    const workspace = this.store.getSession(sessionId).workspace;
    for (const session of this.store.listSessions({ workspace })) {
      const candidate = this.store.listMemoryCandidates(session.id)
        .find(({ id }) => id === candidateId);
      if (candidate) {
        if (candidate.status !== 'pending') throw new Error('记忆候选已处理');
        return candidate;
      }
    }
    throw new Error(`记忆候选不存在：${candidateId}`);
  }

  /** 实际提取、严格校验并持久化本轮候选。 */
  private async extractTurnNow(input: MemoryExtractionInput): Promise<StoredMemoryCandidate[]> {
    const session = this.store.getSession(input.sessionId);
    if (session.workspace !== input.workspace) throw new Error('会话工作区不匹配');
    this.store.updateSession(input.sessionId, {
      memoryExtractionStatus: 'running',
      memoryExtractionError: null,
    });

    try {
      const activeMemories = await this.listActiveMemories(input.workspace);
      const prompt = createMemoryExtractionPrompt(
        selectExtractionMemories(activeMemories.map(({ content }) => content)),
        {
          workspace: input.workspace,
          sessionId: input.sessionId,
          sourceTurn: input.sourceTurn,
          userPrompt: input.userPrompt,
          assistantResponse: input.assistantResponse,
          toolResults: input.toolResults,
        },
      );
      const reply = await this.provider.chat(
        [{ role: 'system', content: prompt }],
        [],
        noop,
        input.signal,
      );
      input.signal.throwIfAborted();

      let extraction: z.infer<typeof extractionSchema>;
      try {
        extraction = extractionSchema.parse(JSON.parse(reply.content));
      } catch {
        throw new MemoryExtractionFormatError();
      }

      const knownContent = new Set(
        this.store.listMemoryNormalizedContents(input.workspace),
      );
      for (const normalizedContent of (
        this.store.listNonIgnoredMemoryCandidateNormalizedContents(input.workspace)
      )) {
        knownContent.add(normalizedContent);
      }

      const createdAt = Date.now();
      const candidates: StoredMemoryCandidate[] = [];
      for (const candidate of extraction.candidates) {
        const sanitized = memoryContentSchema.safeParse(this.sanitize(candidate.content));
        if (!sanitized.success || containsPotentialSecret(sanitized.data)) continue;
        const normalizedContent = normalizeMemoryContent(sanitized.data);
        if (!normalizedContent || knownContent.has(normalizedContent)) continue;
        knownContent.add(normalizedContent);
        candidates.push({
          id: randomUUID(),
          workspace: input.workspace,
          sourceSessionId: input.sessionId,
          sourceTurn: input.sourceTurn,
          category: candidate.category,
          content: sanitized.data,
          normalizedContent,
          status: 'pending',
          acceptedMemoryId: null,
          createdAt,
          resolvedAt: null,
        });
      }

      this.store.completeMemoryExtraction(input.sessionId, candidates);
      return candidates;
    } catch (error) {
      this.store.updateSession(input.sessionId, {
        memoryExtractionStatus: 'failed',
        memoryExtractionError: this.createExtractionError(error),
      });
      if (error instanceof MemoryExtractionFormatError) {
        throw new Error('记忆提取结果格式无效');
      }
      throw error;
    }
  }

  /** 按会话串行执行提取，并在队列完成后释放会话槽位。 */
  async extractTurn(input: MemoryExtractionInput): Promise<StoredMemoryCandidate[]> {
    const previous = this.extractionQueues.get(input.sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.extractionQueues.set(input.sessionId, current);

    try {
      await previous;
      input.signal.throwIfAborted();
      return await this.extractTurnNow(input);
    } finally {
      release();
      if (this.extractionQueues.get(input.sessionId) === current) {
        this.extractionQueues.delete(input.sessionId);
      }
    }
  }

  /** 返回当前工作区不超过 50 条和 12 KiB 的动态系统上下文。 */
  async buildRuntimeInstructions(workspace: string): Promise<string> {
    const selected: StoredMemory[] = [];
    for (const memory of await this.listActiveMemories(workspace)) {
      const nextPrompt = createMemorySystemPrompt([...selected, memory]);
      if (Buffer.byteLength(nextPrompt, 'utf8') > maxRuntimeInstructionBytes) break;
      selected.push(memory);
    }
    return selected.length > 0 ? createMemorySystemPrompt(selected) : '';
  }

  /** 接受、编辑后接受或忽略候选。 */
  async resolveCandidate(
    sessionId: string,
    candidateId: string,
    decision: CandidateDecision,
  ): Promise<StoredMemory | null> {
    if (decision.action === 'ignore') {
      return this.store.resolveMemoryCandidate(
        sessionId,
        candidateId,
        decision,
        Date.now(),
      );
    }
    const candidate = this.findWorkspaceCandidate(sessionId, candidateId);
    const content = this.validateMemoryContent(decision.content ?? candidate.content);
    const memory = this.store.resolveMemoryCandidate(sessionId, candidateId, {
      action: 'accept',
      content,
      normalizedContent: normalizeMemoryContent(content),
    }, Date.now());
    await this.invalidateMemoryCache(candidate.workspace);
    return memory;
  }

  /** 返回会话工作区的候选、正式记忆和提取状态。 */
  getState(sessionId: string): MemoryState {
    const session = this.store.getSession(sessionId);
    return {
      extractionStatus: session.memoryExtractionStatus,
      extractionError: session.memoryExtractionError,
      candidates: this.store.listMemoryCandidates(sessionId),
      memories: this.store.listMemories(session.workspace),
    };
  }

  /** 编辑、停用或恢复正式记忆。 */
  updateMemory(
    sessionId: string,
    memoryId: string,
    patch: { content?: string; active?: boolean },
  ): StoredMemory {
    const validatedPatch = patch.content === undefined
      ? patch
      : { ...patch, content: this.validateMemoryContent(patch.content) };
    const memory = this.store.updateMemory(sessionId, memoryId, validatedPatch);
    void this.invalidateMemoryCache(memory.workspace);
    return memory;
  }

  /** 删除正式记忆。 */
  deleteMemory(sessionId: string, memoryId: string): void {
    const workspace = this.store.getSession(sessionId).workspace;
    this.store.deleteMemory(sessionId, memoryId);
    void this.invalidateMemoryCache(workspace);
  }
}
