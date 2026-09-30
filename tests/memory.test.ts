import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  containsPotentialSecret,
  MemoryService,
  normalizeMemoryContent,
} from '../src/memory/MemoryService.js';
import {
  createMemoryExtractionPrompt,
  createMemorySystemPrompt,
} from '../src/memory/memoryPrompt.js';
import type { MemoryExtractionInput } from '../src/memory/types.js';
import { PersistenceStore } from '../src/persistence/PersistenceStore.js';
import type {
  MemoryCategory,
  StoredMemoryCandidate,
  StoredSession,
} from '../src/persistence/types.js';
import type { ChatReply, ModelProvider } from '../src/providers/types.js';

const cleanups: Array<() => Promise<void>> = [];
const stores: PersistenceStore[] = [];

/** 关闭测试数据库并清理临时目录。 */
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0).reverse()) store.close();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 创建具有稳定默认值的会话。 */
function buildSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'session-1',
    clientType: 'web',
    workspace: '/workspace/one',
    title: '记忆测试',
    status: 'idle',
    turns: 0,
    memoryExtractionStatus: 'idle',
    memoryExtractionError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** 创建独立的真实 SQLite 存储。 */
async function createStore(): Promise<PersistenceStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new PersistenceStore(path.join(directory, 'agent.db'));
  stores.push(store);
  return store;
}

/** 创建只返回指定提取文本的模型 Provider。 */
function createProvider(
  reply: string | ((signal: AbortSignal) => Promise<ChatReply>),
): ModelProvider {
  return {
    chat: vi.fn(async (_messages, _tools, _onText, signal) => (
      typeof reply === 'string'
        ? { content: reply, toolCalls: [] }
        : reply(signal)
    )),
    generateImage: vi.fn(async () => Buffer.alloc(0)),
  };
}

/** 构造一次完整的记忆提取输入。 */
function buildExtractionInput(
  overrides: Partial<MemoryExtractionInput> = {},
): MemoryExtractionInput {
  return {
    workspace: '/workspace/one',
    sessionId: 'session-1',
    sourceTurn: 1,
    userPrompt: '请使用 React 19',
    assistantResponse: '已完成',
    toolResults: ['测试通过'],
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** 构造待确认候选，供持久化边界测试复用。 */
function buildCandidate(
  overrides: Partial<StoredMemoryCandidate> = {},
): StoredMemoryCandidate {
  return {
    id: 'candidate-1',
    workspace: '/workspace/one',
    sourceSessionId: 'session-1',
    sourceTurn: 1,
    category: 'rule',
    content: '使用 React 19',
    normalizedContent: '使用 react 19',
    status: 'pending',
    acceptedMemoryId: null,
    createdAt: 10,
    resolvedAt: null,
    ...overrides,
  };
}

/** 将候选直接接受为正式记忆。 */
function acceptCandidate(
  store: PersistenceStore,
  candidate: StoredMemoryCandidate,
  resolvedAt = candidate.createdAt + 1,
) {
  store.insertMemoryCandidates([candidate]);
  return store.resolveMemoryCandidate(candidate.sourceSessionId, candidate.id, {
    action: 'accept',
    content: candidate.content,
    normalizedContent: candidate.normalizedContent,
  }, resolvedAt);
}

describe('记忆提取与提示词', () => {
  it('规范化 NFKC、首尾和连续空白，并仅折叠 ASCII 大写', () => {
    expect(normalizeMemoryContent('  使用 React 19   和原生 CSS。 ')).toBe(
      '使用 react 19 和原生 css。',
    );
    expect(normalizeMemoryContent('ＡＢＣ  É中')).toBe('abc É中');
  });

  it('提取并清洗最多五条合法候选，提示词限制结构和安全边界', async () => {
    const store = await createStore();
    store.createSession(buildSession());
    const provider = createProvider(JSON.stringify({
      candidates: [
        { category: 'rule', content: '  使用 React 19   和原生 CSS。 ' },
        { category: 'decision', content: '使用 SQLite。' },
        { category: 'fact', content: '项目运行在 Node.js 22。' },
        { category: 'preference', content: '偏好最小 diff。' },
        { category: 'rule', content: 'visible 内容' },
      ],
    }));
    const service = new MemoryService(
      store,
      provider,
      (text) => text.replace('visible', 'sanitized'),
    );

    const candidates = await service.extractTurn(buildExtractionInput());

    expect(candidates).toHaveLength(5);
    expect(candidates.map(({ category }) => category)).toEqual([
      'rule', 'decision', 'fact', 'preference', 'rule',
    ]);
    expect(candidates[0]).toMatchObject({
      content: '使用 React 19   和原生 CSS。',
      normalizedContent: '使用 react 19 和原生 css。',
      status: 'pending',
    });
    expect(candidates[4]?.content).toBe('sanitized 内容');
    expect(store.getSession('session-1')).toMatchObject({
      memoryExtractionStatus: 'complete',
      memoryExtractionError: null,
    });
    expect(provider.chat).toHaveBeenCalledOnce();
    const messages = vi.mocked(provider.chat).mock.calls[0]?.[0] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(String(messages[0]?.content)).toContain('只返回 JSON');
    expect(String(messages[0]?.content)).toContain('最多 5 条');
    expect(String(messages[0]?.content)).toContain('每条不超过 1000');
    expect(String(messages[0]?.content)).toContain('跳过');
  });

  it.each([
    ['非法 JSON', 'not-json'],
    ['schema 类别错误', JSON.stringify({
      candidates: [
        { category: 'rule', content: '合法但不得部分写入' },
        { category: 'progress', content: '非法类别' },
      ],
    })],
    ['schema 数量错误', JSON.stringify({
      candidates: Array.from({ length: 6 }, (_, index) => ({
        category: 'fact',
        content: `候选 ${index}`,
      })),
    })],
    ['schema 内容错误', JSON.stringify({
      candidates: [{ category: 'fact', content: 'x'.repeat(1001) }],
    })],
  ])('%s 不产生部分候选并记录脱敏单行短错误', async (_name, reply) => {
    const store = await createStore();
    store.createSession(buildSession());
    const service = new MemoryService(
      store,
      createProvider(reply),
      (text) => text.replaceAll('not-json', '[REDACTED]'),
    );

    await expect(service.extractTurn(buildExtractionInput()))
      .rejects.toThrow('记忆提取结果格式无效');

    const state = service.getState('session-1');
    expect(state.candidates).toEqual([]);
    expect(state.extractionStatus).toBe('failed');
    expect(state.extractionError).not.toContain('not-json');
    expect(state.extractionError).not.toContain('\n');
    expect(Buffer.byteLength(state.extractionError ?? '', 'utf8')).toBeLessThanOrEqual(512);
  });

  it('AbortError 保持原错误类型，同时正确记录失败状态', async () => {
    const store = await createStore();
    store.createSession(buildSession());
    const abortError = new DOMException('secret\n已取消', 'AbortError');
    const service = new MemoryService(
      store,
      createProvider(async () => { throw abortError; }),
      (text) => text.replaceAll('secret', '[REDACTED]'),
    );

    await expect(service.extractTurn(buildExtractionInput()))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(service.getState('session-1')).toMatchObject({
      extractionStatus: 'failed',
      extractionError: '[REDACTED] 已取消',
    });
  });

  it('跳过常见凭据和同工作区重复内容，但不跨工作区去重', async () => {
    const store = await createStore();
    store.createSession(buildSession());
    store.createSession(buildSession({
      id: 'session-2',
      workspace: '/workspace/two',
    }));
    acceptCandidate(store, buildCandidate({
      id: 'existing-memory',
      sourceSessionId: 'session-2',
      workspace: '/workspace/two',
      content: '跨工作区内容',
      normalizedContent: '跨工作区内容',
    }));
    store.insertMemoryCandidates([buildCandidate({
      id: 'existing-candidate',
      content: '已有候选',
      normalizedContent: '已有候选',
    })]);
    const provider = createProvider(JSON.stringify({
      candidates: [
        { category: 'fact', content: 'Bearer abcdefghijklmnop' },
        { category: 'fact', content: '已有候选' },
        { category: 'fact', content: '批内重复' },
        { category: 'decision', content: '  批内重复  ' },
        { category: 'fact', content: '跨工作区内容' },
      ],
    }));
    const service = new MemoryService(store, provider, (text) => text);

    const candidates = await service.extractTurn(buildExtractionInput());

    expect(candidates.map(({ content }) => content)).toEqual([
      '批内重复',
      '跨工作区内容',
    ]);
    expect(store.listMemoryCandidates('session-1').map(({ id }) => id))
      .toContain('existing-candidate');
  });

  it('停用的正式记忆不注入提示，但仍参与同工作区去重', async () => {
    const store = await createStore();
    store.createSession(buildSession());
    const existing = acceptCandidate(store, buildCandidate());
    store.updateMemory('session-1', existing!.id, { active: false });
    store.deleteSession('session-1');
    store.createSession(buildSession());
    const provider = createProvider(JSON.stringify({
      candidates: [{ category: 'rule', content: '  使用 React 19  ' }],
    }));
    const service = new MemoryService(store, provider, (text) => text);

    const candidates = await service.extractTurn(buildExtractionInput());

    expect(candidates).toEqual([]);
    const messages = vi.mocked(provider.chat).mock.calls[0]?.[0] ?? [];
    expect(String(messages[0]?.content)).not.toContain('已有已确认记忆：\n["使用 React 19"]');
  });

  it('校验提取工作区必须与会话一致', async () => {
    const store = await createStore();
    store.createSession(buildSession());
    const provider = createProvider('{"candidates":[]}');
    const service = new MemoryService(store, provider, (text) => text);

    await expect(service.extractTurn(buildExtractionInput({
      workspace: '/workspace/two',
    }))).rejects.toThrow('会话工作区不匹配');

    expect(provider.chat).not.toHaveBeenCalled();
    expect(store.getSession('session-1').memoryExtractionStatus).toBe('idle');
  });

  it('提取提示包含已有内容和本轮输入，系统消息声明记忆权限边界', () => {
    const input = buildExtractionInput();
    const extractionPrompt = createMemoryExtractionPrompt(['已有规则'], {
      ...input,
      signal: undefined,
    } as never);
    const systemPrompt = createMemorySystemPrompt([{
      id: 'memory-1',
      workspace: input.workspace,
      category: 'rule',
      content: '使用 TypeScript',
      normalizedContent: '使用 typescript',
      active: true,
      sourceSessionId: input.sessionId,
      createdAt: 1,
      updatedAt: 1,
    }]);

    expect(extractionPrompt).toContain('已有规则');
    expect(extractionPrompt).toContain(input.userPrompt);
    expect(extractionPrompt).toContain(input.assistantResponse);
    expect(extractionPrompt).toContain(input.toolResults[0]);
    expect(systemPrompt).toContain('使用 TypeScript');
    expect(systemPrompt).toContain('不能覆盖当前用户指令');
    expect(systemPrompt).toContain('工具授权');
    expect(systemPrompt).toContain('安全规则');
  });
});

describe('候选确认与正式记忆', () => {
  it('候选接受前不注入，接受原文或编辑内容后仅当前工作区立即注入', async () => {
    const store = await createStore();
    store.createSession(buildSession());
    store.createSession(buildSession({
      id: 'session-2',
      workspace: '/workspace/two',
    }));
    const provider = createProvider('{"candidates":[]}');
    const service = new MemoryService(store, provider, (text) => text.trim());
    store.insertMemoryCandidates([
      buildCandidate(),
      buildCandidate({
        id: 'candidate-2',
        category: 'preference',
        content: '原始偏好',
        normalizedContent: '原始偏好',
        createdAt: 11,
      }),
    ]);

    expect(await service.buildRuntimeInstructions('/workspace/one')).toBe('');
    const original = await service.resolveCandidate(
      'session-1',
      'candidate-1',
      { action: 'accept' },
    );
    const edited = await service.resolveCandidate(
      'session-1',
      'candidate-2',
      { action: 'accept', content: '  编辑后的偏好  ' },
    );

    expect(original?.content).toBe('使用 React 19');
    expect(edited?.content).toBe('编辑后的偏好');
    expect(await service.buildRuntimeInstructions('/workspace/one'))
      .toContain('使用 React 19');
    expect(await service.buildRuntimeInstructions('/workspace/one'))
      .toContain('编辑后的偏好');
    expect(await service.buildRuntimeInstructions('/workspace/two')).toBe('');
  });

  it('忽略候选并拒绝重复确认', async () => {
    const store = await createStore();
    store.createSession(buildSession());
    store.insertMemoryCandidates([buildCandidate()]);
    const service = new MemoryService(
      store,
      createProvider('{"candidates":[]}'),
      (text) => text,
    );

    await expect(service.resolveCandidate(
      'session-1',
      'candidate-1',
      { action: 'ignore' },
    )).resolves.toBeNull();
    expect(service.getState('session-1').candidates[0]).toMatchObject({
      status: 'ignored',
      acceptedMemoryId: null,
    });
    await expect(service.resolveCandidate(
      'session-1',
      'candidate-1',
      { action: 'accept' },
    )).rejects.toThrow('记忆候选已处理');
  });

  it('同工作区重复接受复用正式记忆，不跨工作区复用', async () => {
    const store = await createStore();
    store.createSession(buildSession());
    store.createSession(buildSession({
      id: 'session-2',
      workspace: '/workspace/two',
    }));
    store.insertMemoryCandidates([
      buildCandidate({ id: 'one-a' }),
      buildCandidate({ id: 'one-b', content: ' 使用 React 19 ', createdAt: 11 }),
      buildCandidate({
        id: 'two-a',
        sourceSessionId: 'session-2',
        workspace: '/workspace/two',
        createdAt: 12,
      }),
    ]);
    const service = new MemoryService(
      store,
      createProvider('{"candidates":[]}'),
      (text) => text,
    );

    const first = await service.resolveCandidate('session-1', 'one-a', { action: 'accept' });
    const duplicate = await service.resolveCandidate('session-1', 'one-b', { action: 'accept' });
    const otherWorkspace = await service.resolveCandidate('session-2', 'two-a', {
      action: 'accept',
    });

    expect(duplicate?.id).toBe(first?.id);
    expect(store.listMemories('/workspace/one')).toHaveLength(1);
    expect(otherWorkspace?.id).not.toBe(first?.id);
    expect(store.listMemories('/workspace/two')).toHaveLength(1);
  });

  it.each([
    '-----BEGIN PRIVATE KEY-----',
    'Bearer abcdefghijklmnop',
    'sk-12345678901234567890',
    'AK-12345678901234567890',
  ])('拒绝候选接受和正式编辑中的潜在凭据：%s', async (secret) => {
    const store = await createStore();
    store.createSession(buildSession());
    store.insertMemoryCandidates([buildCandidate()]);
    const service = new MemoryService(
      store,
      createProvider('{"candidates":[]}'),
      (text) => text,
    );

    expect(containsPotentialSecret(secret)).toBe(true);
    await expect(service.resolveCandidate('session-1', 'candidate-1', {
      action: 'accept',
      content: secret,
    })).rejects.toThrow('记忆内容包含潜在凭据');

    const memory = await service.resolveCandidate(
      'session-1',
      'candidate-1',
      { action: 'accept' },
    );
    expect(() => service.updateMemory('session-1', memory!.id, { content: secret }))
      .toThrow('记忆内容包含潜在凭据');
  });

  it('编辑、停用、恢复和删除正式记忆，并锁定空 patch 为拒绝', async () => {
    const store = await createStore();
    store.createSession(buildSession());
    store.insertMemoryCandidates([buildCandidate()]);
    const service = new MemoryService(
      store,
      createProvider('{"candidates":[]}'),
      (text) => text.trim(),
    );
    const memory = await service.resolveCandidate(
      'session-1',
      'candidate-1',
      { action: 'accept' },
    );

    expect(() => service.updateMemory('session-1', memory!.id, {}))
      .toThrow('记忆更新不能为空');
    expect(service.updateMemory('session-1', memory!.id, {
      content: '  使用 Vue 3  ',
      active: false,
    })).toMatchObject({
      content: '使用 Vue 3',
      normalizedContent: '使用 vue 3',
      active: false,
    });
    expect(await service.buildRuntimeInstructions('/workspace/one')).toBe('');
    expect(service.updateMemory('session-1', memory!.id, { active: true }).active).toBe(true);
    expect(await service.buildRuntimeInstructions('/workspace/one')).toContain('使用 Vue 3');

    service.deleteMemory('session-1', memory!.id);

    expect(store.listMemories('/workspace/one')).toEqual([]);
    expect(service.getState('session-1').candidates[0]).toMatchObject({
      status: 'accepted',
      acceptedMemoryId: null,
    });
  });

  it('删除源会话后正式记忆保留并清空 sourceSessionId', async () => {
    const store = await createStore();
    store.createSession(buildSession());
    store.insertMemoryCandidates([buildCandidate()]);
    const service = new MemoryService(
      store,
      createProvider('{"candidates":[]}'),
      (text) => text,
    );
    await service.resolveCandidate('session-1', 'candidate-1', { action: 'accept' });

    store.deleteSession('session-1');

    expect(store.listMemories('/workspace/one')).toMatchObject([{
      content: '使用 React 19',
      sourceSessionId: null,
    }]);
  });

  it('所有候选和正式记忆操作按调用会话工作区隔离', async () => {
    const store = await createStore();
    store.createSession(buildSession());
    store.createSession(buildSession({
      id: 'session-2',
      workspace: '/workspace/two',
    }));
    store.insertMemoryCandidates([buildCandidate()]);
    const service = new MemoryService(
      store,
      createProvider('{"candidates":[]}'),
      (text) => text,
    );

    await expect(service.resolveCandidate(
      'session-2',
      'candidate-1',
      { action: 'accept' },
    )).rejects.toThrow('记忆候选不存在');
    const memory = await service.resolveCandidate(
      'session-1',
      'candidate-1',
      { action: 'accept' },
    );
    expect(() => service.updateMemory('session-2', memory!.id, { active: false }))
      .toThrow('记忆不存在');
    expect(() => service.deleteMemory('session-2', memory!.id))
      .toThrow('记忆不存在');
    expect(store.listMemories('/workspace/one')[0]?.active).toBe(true);
  });
});

describe('运行时记忆注入', () => {
  it('仅按更新时间倒序注入 active 记忆且最多五十条', async () => {
    const store = await createStore();
    store.createSession(buildSession());
    const service = new MemoryService(
      store,
      createProvider('{"candidates":[]}'),
      (text) => text,
    );
    const candidates = Array.from({ length: 55 }, (_, index) => {
      const content = `记忆-${index.toString().padStart(2, '0')}`;
      return buildCandidate({
        id: `candidate-${index}`,
        category: ['rule', 'decision', 'fact', 'preference'][index % 4] as MemoryCategory,
        content,
        normalizedContent: normalizeMemoryContent(content),
        createdAt: index + 10,
      });
    });
    store.insertMemoryCandidates(candidates);
    const memories = candidates.map((candidate, index) => (
      store.resolveMemoryCandidate('session-1', candidate.id, {
        action: 'accept',
        content: candidate.content,
        normalizedContent: candidate.normalizedContent,
      }, index + 100)!
    ));
    service.updateMemory('session-1', memories[54]!.id, { active: false });

    const instructions = await service.buildRuntimeInstructions('/workspace/one');
    const included = candidates.filter(({ content }) => instructions.includes(content));

    expect(Buffer.byteLength(instructions, 'utf8')).toBeLessThanOrEqual(12 * 1024);
    expect(included).toHaveLength(50);
    expect(instructions).not.toContain(candidates[54]!.content);
    expect(instructions.indexOf(candidates[53]!.content))
      .toBeLessThan(instructions.indexOf(candidates[52]!.content));
  });

  it('按最终消息的 UTF-8 字节限制停止且不截断多字节内容', async () => {
    const store = await createStore();
    store.createSession(buildSession());
    const service = new MemoryService(
      store,
      createProvider('{"candidates":[]}'),
      (text) => text,
    );
    const candidates = Array.from({ length: 20 }, (_, index) => {
      const content = `长记忆-${index.toString().padStart(2, '0')}-${'界'.repeat(500)}`;
      return buildCandidate({
        id: `long-candidate-${index}`,
        content,
        normalizedContent: normalizeMemoryContent(content),
        createdAt: index + 10,
      });
    });
    store.insertMemoryCandidates(candidates);
    candidates.forEach((candidate, index) => {
      store.resolveMemoryCandidate('session-1', candidate.id, {
        action: 'accept',
        content: candidate.content,
        normalizedContent: candidate.normalizedContent,
      }, index + 100);
    });

    const instructions = await service.buildRuntimeInstructions('/workspace/one');
    const included = candidates.filter(({ content }) => instructions.includes(content));

    expect(Buffer.byteLength(instructions, 'utf8')).toBeLessThanOrEqual(12 * 1024);
    expect(instructions).not.toContain('\uFFFD');
    expect(included.length).toBeGreaterThan(0);
    expect(included.length).toBeLessThan(candidates.length);
    for (const candidate of included) expect(instructions).toContain(candidate.content);
  });
});
