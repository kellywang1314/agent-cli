import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { AgentLoop, type ToolExecutor } from '../agent/AgentLoop.js';
import { redactSecrets, type AgentConfig } from '../config/loadConfig.js';
import { collectProjectContext } from '../context/projectContext.js';
import type { MemoryService } from '../memory/MemoryService.js';
import type { PersistenceStore } from '../persistence/PersistenceStore.js';
import type {
  DisplayMessageRole,
  NewDisplayMessage,
  SessionClientType,
  SessionPatch,
  SessionQuery,
  StoredDisplayMessage,
  StoredMemoryCandidate,
} from '../persistence/types.js';
import { createSystemPrompt } from '../prompts/systemPrompt.js';
import type { ModelProvider } from '../providers/types.js';
import type { ToolContext } from '../tools/types.js';
import type {
  SessionDetail,
  SessionRunHooks,
  SessionRunResult,
  SessionSummary,
} from './types.js';

/** 复制并脱敏会写入 SQLite 的模型消息。 */
function sanitizeAgentMessage(
  message: ChatCompletionMessageParam,
  sanitize: (text: string) => string,
): ChatCompletionMessageParam {
  const copy = structuredClone(message);
  if ('content' in copy && typeof copy.content === 'string') copy.content = sanitize(copy.content);
  if (copy.role === 'assistant' && copy.tool_calls) {
    for (const call of copy.tool_calls) {
      if (call.type === 'function') {
        call.function.arguments = sanitize(call.function.arguments);
      }
    }
  }
  return copy;
}

/** 从工具返回对象中读取现有工具约定的错误字段。 */
function getToolError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('error' in value)) return undefined;
  return typeof value.error === 'string' ? value.error : '工具执行失败';
}

export class SessionService {
  private readonly running = new Set<string>();
  private readonly extractionTasks = new Set<Promise<unknown>>();

  /** 创建共享会话服务，复用调用方持有的模型、工具、数据库和记忆服务。 */
  constructor(
    private readonly config: AgentConfig,
    private readonly provider: ModelProvider,
    private readonly tools: ToolExecutor,
    private readonly persistence: PersistenceStore,
    private readonly memories: MemoryService,
    private readonly sanitize: (text: string) => string,
  ) {}

  /** 校验真实工作区目录并创建可持久恢复的空会话。 */
  async create(clientType: SessionClientType, workspace: string): Promise<string> {
    const root = await realpath(workspace);
    if (!(await stat(root)).isDirectory()) throw new Error('工作区必须是目录');
    const id = randomUUID();
    const now = Date.now();
    this.persistence.createSession({
      id,
      clientType,
      workspace: root,
      title: '新任务',
      status: 'idle',
      turns: 0,
      memoryExtractionStatus: 'idle',
      memoryExtractionError: null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  /** 按持久化层支持的条件列出会话摘要。 */
  list(query?: SessionQuery): SessionSummary[] {
    return this.persistence.listSessions(query);
  }

  /** 读取会话元数据及完整显示消息。 */
  load(id: string): SessionDetail {
    return {
      ...this.persistence.getSession(id),
      messages: this.persistence.loadDisplayMessages(id),
    };
  }

  /** 创建已脱敏的待持久化显示消息。 */
  private createDisplayMessage(
    role: DisplayMessageRole,
    content: string,
  ): NewDisplayMessage {
    return {
      id: randomUUID(),
      role,
      content: this.sanitize(content),
      createdAt: Date.now(),
    };
  }

  /** 返回刚写入的显示消息，供调用方在持久化后更新界面。 */
  private loadLatestDisplayMessage(id: string): StoredDisplayMessage {
    const message = this.persistence.loadDisplayMessages(id).at(-1);
    if (!message) throw new Error('显示消息写入失败');
    return message;
  }

  /** 追加显示消息和状态，并在持久化成功后依次通知调用方。 */
  private appendDisplayMessage(
    id: string,
    role: DisplayMessageRole,
    content: string,
    patch: SessionPatch,
    hooks: SessionRunHooks,
  ): StoredDisplayMessage {
    const message = this.createDisplayMessage(role, content);
    this.persistence.appendDisplayMessage(id, message, patch);
    const stored = this.loadLatestDisplayMessage(id);
    hooks.onDisplayMessage(stored);
    if (patch.status !== undefined) hooks.onStatus(patch.status);
    return stored;
  }

  /** 跟踪后台记忆提取，并在成功或失败后释放关闭等待集合。 */
  private trackExtraction(
    task: Promise<StoredMemoryCandidate[]>,
  ): Promise<StoredMemoryCandidate[]> {
    this.extractionTasks.add(task);
    void task.then(
      () => this.extractionTasks.delete(task),
      () => this.extractionTasks.delete(task),
    );
    return task;
  }

  /** 构造包含调用会话工作区、取消信号和确认回调的工具上下文。 */
  private createToolContext(
    workspace: string,
    hooks: SessionRunHooks,
    signal: AbortSignal,
  ): ToolContext {
    return {
      workspace,
      provider: this.provider,
      signal,
      confirm: hooks.confirm,
    };
  }

  /** 尽力记录失败或取消状态，同时始终保留并继续抛出原始错误。 */
  private recordRunFailure(
    id: string,
    error: unknown,
    hooks: SessionRunHooks,
    signal: AbortSignal,
  ): void {
    const status = signal.aborted ? 'interrupted' : 'failed';
    const reason = signal.aborted
      ? '任务已中断，可继续输入新任务。'
      : `错误：${error instanceof Error ? error.message : String(error)}`;
    try {
      this.appendDisplayMessage(id, 'notice', reason, {
        status,
        updatedAt: Date.now(),
      }, hooks);
    } catch {
      try {
        this.persistence.updateSession(id, { status, updatedAt: Date.now() });
        hooks.onStatus(status);
      } catch {
        // 失败报告不得覆盖触发任务失败的原始错误。
      }
    }
  }

  /** 执行图片快捷命令，只持久化显示消息并复用 generateImage 工具。 */
  private async runImage(
    sessionId: string,
    prompt: string,
    hooks: SessionRunHooks,
    signal: AbortSignal,
  ): Promise<SessionRunResult> {
    const session = this.persistence.getSession(sessionId);
    const displayUserMessage = this.createDisplayMessage('user', prompt);
    this.persistence.beginDisplayOnlyTurn(sessionId, displayUserMessage);
    hooks.onDisplayMessage(this.loadLatestDisplayMessage(sessionId));
    hooks.onStatus('running');

    const startedAt = Date.now();
    hooks.onAgentEvent({ type: 'toolStart', name: 'generateImage' });
    const imageResult = await this.tools.execute('generateImage', {
      prompt: prompt.slice(7).trim(),
    }, this.createToolContext(session.workspace, hooks, signal));
    signal.throwIfAborted();
    const content = JSON.stringify(imageResult, null, 2) ?? 'null';
    const eventResult = this.sanitize(JSON.stringify(imageResult) ?? 'null');
    hooks.onAgentEvent({
      type: 'toolEnd',
      name: 'generateImage',
      result: eventResult,
      elapsedMs: Date.now() - startedAt,
    });
    const imageError = getToolError(imageResult);
    if (imageError) throw new Error(imageError);
    const stored = this.appendDisplayMessage(sessionId, 'assistant', content, {
      status: 'idle',
      updatedAt: Date.now(),
    }, hooks);
    return { content: stored.content, memoryExtraction: null };
  }

  /** 执行普通 Agent 任务，可靠持久化消息并异步启动本轮记忆提取。 */
  private async runAgent(
    sessionId: string,
    prompt: string,
    hooks: SessionRunHooks,
    signal: AbortSignal,
  ): Promise<SessionRunResult> {
    const session = this.persistence.getSession(sessionId);
    const initialMessages = this.persistence.loadAgentMessages(sessionId);
    const projectContext = await collectProjectContext(session.workspace);
    const displayUserMessage = this.createDisplayMessage('user', prompt);
    const currentTurnMessages: ChatCompletionMessageParam[] = [];
    let waitingForUserMessage = true;
    const agent = new AgentLoop(this.provider, this.tools, {
      systemPrompt: redactSecrets(
        createSystemPrompt(session.workspace, projectContext),
        [this.config.apiKey],
      ),
      maxRounds: this.config.maxRounds,
      initialMessages,
      sanitize: this.sanitize,
      getRuntimeInstructions: () => this.memories.buildRuntimeInstructions(session.workspace),
      onEvent: hooks.onAgentEvent,
      onMessagesAppended: async (messages) => {
        if (waitingForUserMessage) {
          if (
            messages.length !== 1 ||
            messages[0]?.role !== 'user' ||
            typeof messages[0].content !== 'string'
          ) {
            throw new Error('首批模型消息必须是一条用户文本');
          }
          const userMessage = sanitizeAgentMessage(messages[0], this.sanitize);
          this.persistence.beginTurn(sessionId, displayUserMessage, userMessage);
          waitingForUserMessage = false;
          currentTurnMessages.push(userMessage);
          hooks.onDisplayMessage(this.loadLatestDisplayMessage(sessionId));
          hooks.onStatus('running');
          return;
        }
        const sanitized = messages.map((message) => (
          sanitizeAgentMessage(message, this.sanitize)
        ));
        this.persistence.appendAgentMessages(sessionId, sanitized);
        currentTurnMessages.push(...sanitized);
      },
    });

    const content = await agent.run(
      prompt,
      this.createToolContext(session.workspace, hooks, signal),
    );
    const assistantMessage = this.appendDisplayMessage(sessionId, 'assistant', content, {
      status: 'idle',
      updatedAt: Date.now(),
    }, hooks);
    const sourceTurn = this.persistence.getSession(sessionId).turns;
    const toolResults = currentTurnMessages
      .filter((message) => message.role === 'tool' && typeof message.content === 'string')
      .map((message) => message.content as string);
    const extractionController = new AbortController();
    const memoryExtraction = this.trackExtraction(this.memories.extractTurn({
      workspace: session.workspace,
      sessionId,
      sourceTurn,
      userPrompt: displayUserMessage.content,
      assistantResponse: assistantMessage.content,
      toolResults,
      signal: extractionController.signal,
    }));
    return { content: assistantMessage.content, memoryExtraction };
  }

  /** 运行一次普通或图片任务，并防止同一会话并发修改历史。 */
  async run(
    id: string,
    prompt: string,
    hooks: SessionRunHooks,
    signal: AbortSignal,
  ): Promise<SessionRunResult> {
    this.persistence.getSession(id);
    if (this.running.has(id)) throw new Error('已有任务正在执行');
    this.running.add(id);
    try {
      return prompt.startsWith('/image ')
        ? await this.runImage(id, prompt, hooks, signal)
        : await this.runAgent(id, prompt, hooks, signal);
    } catch (error) {
      this.recordRunFailure(id, error, hooks, signal);
      throw error;
    } finally {
      this.running.delete(id);
    }
  }

  /** 删除空闲会话，运行中的会话必须先由调用方中断并等待退出。 */
  remove(id: string): void {
    if (this.running.has(id)) throw new Error('请先停止正在执行的任务');
    this.persistence.deleteSession(id);
  }

  /** 使用最后一轮完整普通任务的持久化内容重新执行记忆提取。 */
  retryMemoryExtraction(
    id: string,
    signal: AbortSignal,
  ): Promise<StoredMemoryCandidate[]> {
    if (this.running.has(id)) throw new Error('已有任务正在执行');
    const session = this.persistence.getSession(id);
    const messages = this.persistence.loadAgentMessages(id);
    const userIndexes = messages.flatMap((message, index) => (
      message.role === 'user' && typeof message.content === 'string' ? [index] : []
    ));
    let selectedTurn: {
      agentTurn: number;
      userPrompt: string;
      assistantResponse: string;
      toolResults: string[];
    } | undefined;
    for (let turnIndex = userIndexes.length - 1; turnIndex >= 0; turnIndex--) {
      const userIndex = userIndexes[turnIndex]!;
      const nextUserIndex = userIndexes[turnIndex + 1] ?? messages.length;
      const turnMessages = messages.slice(userIndex, nextUserIndex);
      const userMessage = turnMessages[0];
      const assistantMessage = turnMessages.at(-1);
      if (
        userMessage?.role !== 'user' ||
        typeof userMessage.content !== 'string' ||
        assistantMessage?.role !== 'assistant' ||
        typeof assistantMessage.content !== 'string' ||
        assistantMessage.tool_calls?.length
      ) {
        continue;
      }
      selectedTurn = {
        agentTurn: turnIndex + 1,
        userPrompt: userMessage.content,
        assistantResponse: assistantMessage.content,
        toolResults: turnMessages
          .filter((message) => message.role === 'tool' && typeof message.content === 'string')
          .map((message) => message.content as string),
      };
      break;
    }
    if (!selectedTurn) throw new Error('会话没有可重试的完整普通任务');

    const displayTurns = this.persistence.loadDisplayMessages(id)
      .filter((message) => message.role === 'user');
    let ordinaryTurn = 0;
    let sourceTurn: number | undefined;
    for (const [turnIndex, message] of displayTurns.entries()) {
      if (!message.content.startsWith('/image ')) {
        ordinaryTurn++;
      }
      if (ordinaryTurn === selectedTurn.agentTurn) {
        sourceTurn = turnIndex + 1;
        break;
      }
    }
    if (sourceTurn === undefined) throw new Error('会话普通任务与显示历史不一致');

    return this.trackExtraction(this.memories.extractTurn({
      workspace: session.workspace,
      sessionId: id,
      sourceTurn,
      userPrompt: selectedTurn.userPrompt,
      assistantResponse: selectedTurn.assistantResponse,
      toolResults: selectedTurn.toolResults,
      signal,
    }));
  }

  /** 等待当前已经启动的全部后台记忆提取完成。 */
  async close(): Promise<void> {
    await Promise.allSettled([...this.extractionTasks]);
  }
}
