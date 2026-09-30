import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../agent/AgentLoop.js';
import { redactSecrets, redactStream, type AgentConfig } from '../config/loadConfig.js';
import type { MemoryService } from '../memory/MemoryService.js';
import type { StoredDisplayMessage, StoredSession } from '../persistence/types.js';
import type { ModelProvider } from '../providers/types.js';
import { PermissionGate } from '../security/PermissionGate.js';
import type { SessionService } from '../sessions/SessionService.js';
import type { SessionRunHooks } from '../sessions/types.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import type { ToolContext } from '../tools/types.js';
import type {
  InspectInput,
  WebMessage,
  WebSession,
  WebSessionSummary,
  WebState,
} from './types.js';

const maxViewMessages = 40;
const maxViewMessageBytes = 512 * 1024;
const maxToolResultBytes = 16 * 1024;

interface SessionRecord {
  view: WebSession;
  gate: PermissionGate;
  controller?: AbortController;
  task?: Promise<void>;
}

const inspectProvider: ModelProvider = {
  /** 只读检查工具不得发起聊天模型请求。 */
  async chat() {
    throw new Error('只读面板不支持模型请求');
  },
  /** 只读检查工具不得发起图片模型请求。 */
  async generateImage() {
    throw new Error('只读面板不支持图片请求');
  },
};

/** 保留 UTF-8 文本末尾且不从多字节字符中间截断。 */
function truncateText(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return `…较早内容已截断…\n${buffer.subarray(start).toString('utf8')}`;
}

/** 将持久化显示消息转换为浏览器消息。 */
function toWebMessage(message: StoredDisplayMessage): WebMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  };
}

/** 将持久会话适配为浏览器摘要，并保留当前进程瞬态运行字段。 */
export class SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly registry = new ToolRegistry();
  private closePromise: Promise<void> | undefined;

  /** 接收共享会话、记忆服务与状态变更通知。 */
  constructor(
    private readonly config: AgentConfig,
    private readonly sessions: SessionService,
    private readonly memories: MemoryService,
    private readonly onChange: (sessionId?: string) => void,
  ) {}

  /** 清除完整文本中的密钥和控制字符。 */
  private sanitizeComplete(value: string): string {
    return redactSecrets(value, [this.config.apiKey]);
  }

  /** 清除流式文本，并暂存末尾可能尚未完整到达的密钥前缀。 */
  private sanitizeStream(value: string): string {
    return redactStream(value, [this.config.apiKey]);
  }

  /** 限制浏览器历史和工具详情体积，不影响持久化消息历史。 */
  private trimView(view: WebSession): void {
    view.tools = view.tools.slice(-40);
    for (const tool of view.tools) tool.result = truncateText(tool.result, maxToolResultBytes);
    view.messages = view.messages.slice(-maxViewMessages);
    while (view.messages.length > 2 &&
      view.messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.content), 0) > maxViewMessageBytes) {
      view.messages.shift();
    }
  }

  /** 检查会话属于 Web 客户端，避免跨客户端访问。 */
  private assertAccessible(session: StoredSession): void {
    if (session.clientType !== 'web') throw new Error('会话不存在');
  }

  /** 从数据库状态和当前进程记录生成无消息摘要。 */
  private createSummary(session: StoredSession): WebSessionSummary {
    this.assertAccessible(session);
    const view = this.records.get(session.id)?.view;
    const pendingMemoryCount = this.memories.getState(session.id).candidates
      .filter(({ status }) => status === 'pending').length;
    return {
      id: session.id,
      title: this.sanitizeComplete(session.title),
      workspace: this.sanitizeComplete(session.workspace),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      busy: view?.busy ?? false,
      status: this.sanitizeComplete(view?.busy && session.status === 'idle' ? 'running' : session.status),
      startedAt: view?.startedAt ?? null,
      pendingMemoryCount,
      memoryExtractionStatus: session.memoryExtractionStatus,
    };
  }

  /** 从持久化详情创建一个新的进程内 UI 记录。 */
  private createRecord(session: ReturnType<SessionService['load']>): SessionRecord {
    this.assertAccessible(session);
    const view: WebSession = {
      ...this.createSummary(session),
      messages: session.messages.map(toWebMessage),
      response: '',
      tools: [],
      permission: null,
    };
    let record!: SessionRecord;
    const gate = new PermissionGate((request) => {
      view.permission = request ? { ...request, id: randomUUID() } : null;
      if (request) view.status = '等待你的确认';
      this.onChange(view.id);
    });
    record = { view, gate };
    this.trimView(view);
    this.records.set(view.id, record);
    return record;
  }

  /** 加载或返回进程内已打开会话。 */
  private get(id: string): SessionRecord {
    const existing = this.records.get(id);
    if (existing) return existing;
    return this.createRecord(this.sessions.load(id));
  }

  /** 使用数据库最新元数据和消息刷新详情，同时保留瞬态 UI 字段。 */
  private refreshRecord(record: SessionRecord): void {
    const detail = this.sessions.load(record.view.id);
    this.assertAccessible(detail);
    const summary = this.createSummary(detail);
    Object.assign(record.view, summary, {
      messages: detail.messages.map(toWebMessage),
    });
    this.trimView(record.view);
  }

  /** 序列化单个浏览器会话，不暴露服务、控制器或访问凭据。 */
  private sessionSnapshot(view: WebSession): WebSession {
    return {
      ...view,
      title: this.sanitizeComplete(view.title),
      workspace: this.sanitizeComplete(view.workspace),
      status: this.sanitizeComplete(view.status),
      response: this.sanitizeStream(view.response),
      messages: view.messages.map((message) => ({
        ...message,
        content: this.sanitizeComplete(message.content),
      })),
      tools: view.tools.map((tool) => ({
        ...tool,
        name: this.sanitizeComplete(tool.name),
        result: this.sanitizeComplete(tool.result),
      })),
      permission: view.permission ? {
        ...view.permission,
        title: this.sanitizeComplete(view.permission.title),
        detail: this.sanitizeComplete(view.permission.detail),
      } : null,
    };
  }

  /** 返回指定会话的浏览器详情，首次访问时从数据库恢复消息。 */
  getSessionSnapshot(id: string): WebSession {
    const record = this.get(id);
    if (!record.view.busy) this.refreshRecord(record);
    return this.sessionSnapshot(record.view);
  }

  /** 返回单个会话的最新持久化摘要。 */
  getSessionSummary(id: string): WebSessionSummary {
    return this.createSummary(this.sessions.load(id));
  }

  /** 返回浏览器可见摘要，列表绝不包含消息或瞬态详情。 */
  snapshot(): WebState {
    const summaries = this.sessions.list({ clientType: 'web' })
      .map((session) => this.createSummary(session));
    return {
      model: this.sanitizeComplete(this.config.model),
      imageModel: this.sanitizeComplete(this.config.imageModel),
      workspace: this.sanitizeComplete(this.config.workspace),
      sessions: summaries,
    };
  }

  /** 校验工作区并通过共享会话服务创建持久会话。 */
  async create(workspace = this.config.workspace): Promise<string> {
    const id = await this.sessions.create('web', workspace);
    const detail = this.sessions.load(id);
    this.createRecord(detail);
    this.onChange();
    return id;
  }

  /** 将逐片文本与工具事件映射为有界的 UI 状态。 */
  private handleEvent(view: WebSession, event: AgentEvent): void {
    if (event.type === 'text') {
      view.response = truncateText(view.response + event.text, 256 * 1024);
    } else if (event.type === 'thinking') {
      if (view.response) view.response = `${this.sanitizeComplete(view.response)}\n\n`;
      view.status = `思考中 · 第 ${event.round} 轮`;
    } else if (event.type === 'toolStart') {
      view.status = `正在执行 ${event.name}`;
      view.tools.push({ id: randomUUID(), name: event.name, status: 'running', result: '' });
      view.tools = view.tools.slice(-80);
    } else {
      const tool = [...view.tools].reverse().find((item) =>
        item.name === event.name && item.status === 'running');
      if (tool) {
        tool.status = event.result.startsWith('{"error":') ? 'error' : 'done';
        tool.result = truncateText(event.result, maxToolResultBytes);
        tool.elapsedMs = event.elapsedMs;
      }
    }
    this.trimView(view);
    this.onChange(view.id);
  }

  /** 创建只读检查工具所需的最小执行上下文。 */
  private context(record: SessionRecord, signal: AbortSignal): ToolContext {
    return {
      workspace: record.view.workspace,
      provider: inspectProvider,
      signal,
      confirm: (request, requestSignal) => record.gate.request(request, requestSignal),
    };
  }

  /** 提交一个异步持久任务，同步设置 busy 防止重复提交。 */
  submit(id: string, prompt: string): void {
    const record = this.get(id);
    const { view } = record;
    if (view.busy) throw new Error('已有任务正在执行');
    if (this.sessions.load(id).turns >= 50) throw new Error('当前会话已达到长度上限，请新建会话');
    const controller = new AbortController();
    record.controller = controller;
    view.busy = true;
    view.startedAt = Date.now();
    view.updatedAt = Date.now();
    view.status = '正在连接模型';
    view.response = '';
    view.tools = [];
    if (!view.messages.length) view.title = this.sanitizeComplete(prompt).slice(0, 36);
    this.onChange(view.id);
    record.task = this.run(record, prompt, controller);
  }

  /** 委托共享会话服务执行任务，并在结束后清理瞬态 UI 状态。 */
  private async run(
    record: SessionRecord,
    prompt: string,
    controller: AbortController,
  ): Promise<void> {
    const { view } = record;
    const hooks: SessionRunHooks = {
      onAgentEvent: (event) => this.handleEvent(view, event),
      onDisplayMessage: (message) => {
        view.messages.push(toWebMessage(message));
        this.trimView(view);
        this.onChange(view.id);
      },
      onStatus: () => this.onChange(view.id),
      confirm: (request, signal) => record.gate.request(request, signal),
    };
    try {
      const result = await this.sessions.run(view.id, prompt, hooks, controller.signal);
      if (result.memoryExtraction) {
        void result.memoryExtraction.then(
          () => this.onChange(view.id),
          () => this.onChange(view.id),
        );
      }
    } catch {
      // SessionService 已持久化失败或取消提示。
    } finally {
      for (const tool of view.tools) {
        if (tool.status === 'running') {
          tool.status = 'error';
          tool.result = '任务已停止或未完成';
        }
      }
      view.response = '';
      view.busy = false;
      view.permission = null;
      record.controller = undefined;
      this.refreshRecord(record);
      this.onChange(view.id);
    }
  }

  /** 使用审批 ID 防止旧页面误批准后续操作。 */
  respond(id: string, permissionId: string, approved: boolean): void {
    const record = this.get(id);
    if (!record.view.permission || record.view.permission.id !== permissionId) {
      throw new Error('审批已过期');
    }
    record.gate.respond(approved);
  }

  /** 取消正在运行或等待授权的任务。 */
  cancel(id: string): void {
    this.get(id).controller?.abort();
  }

  /** 删除空闲持久会话，忙碌会话需先中断。 */
  remove(id: string): void {
    const record = this.get(id);
    if (record.view.busy) throw new Error('请先停止正在执行的任务');
    this.sessions.remove(id);
    this.records.delete(id);
    this.onChange();
  }

  /** 只读面板仅开放文件枚举、文本读取及固定 Git diff 工具。 */
  async inspect(id: string, input: InspectInput): Promise<unknown> {
    const record = this.get(id);
    const target = input.path ?? '.';
    if (target.split(/[\\/]/).some((part) => part.startsWith('.env'))) {
      throw new Error('面板不展示环境密钥文件');
    }
    const name = input.kind === 'files' ? 'listFiles'
      : input.kind === 'file' ? 'readFile'
        : 'getDiff';
    const args = input.kind === 'files' ? { path: '.', maxEntries: 500 }
      : input.kind === 'file' ? { path: target, maxBytes: 65536 }
        : {};
    const context = this.context(record, AbortSignal.timeout(35_000));
    const result = await this.registry.execute(name, args, context);
    return JSON.parse(this.sanitizeComplete(JSON.stringify(result)));
  }

  /** 浏览器断开或服务退出时取消全部任务。 */
  cancelAll(): void {
    for (const record of this.records.values()) record.controller?.abort();
  }

  /** 退出前等待 Web 运行任务和共享服务派生任务全部完成。 */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.cancelAll();
    this.closePromise = (async () => {
      await Promise.allSettled([...this.records.values()].map((record) => record.task));
      await this.sessions.close();
    })();
    return this.closePromise;
  }
}
