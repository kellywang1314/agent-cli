import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { AgentLoop, type AgentEvent } from '../agent/AgentLoop.js';
import { redactSecrets, redactStream, type AgentConfig } from '../config/loadConfig.js';
import { collectProjectContext } from '../context/projectContext.js';
import { createSystemPrompt } from '../prompts/systemPrompt.js';
import type { ModelProvider } from '../providers/types.js';
import { PermissionGate } from '../security/PermissionGate.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import type { ToolContext } from '../tools/types.js';
import type { InspectInput, WebSession, WebState } from './types.js';

const maxViewMessages = 40;
const maxViewMessageBytes = 512 * 1024;
const maxStableMessageBytes = 64 * 1024;
const maxToolResultBytes = 16 * 1024;

interface SessionRecord {
  view: WebSession;
  agent: AgentLoop;
  gate: PermissionGate;
  turns: number;
  controller?: AbortController;
  task?: Promise<void>;
}

/** 保留 UTF-8 文本末尾且不从多字节字符中间截断。 */
function truncateText(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return `…较早内容已截断…\n${buffer.subarray(start).toString('utf8')}`;
}

/** 从工具返回值提取结构化错误。 */
function toolError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('error' in value)) return undefined;
  return typeof value.error === 'string' ? value.error : '工具执行失败';
}

/** 将会话状态与 Agent 核心桥接，凭据始终保留在服务端。 */
export class SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly registry = new ToolRegistry();
  private pendingCreates = 0;

  /** 接收共享模型客户端与状态变更通知。 */
  constructor(
    private readonly config: AgentConfig,
    private readonly provider: ModelProvider,
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

  /** 限制浏览器历史和工具详情体积，不影响 Agent 自身消息历史。 */
  private trimView(view: WebSession): void {
    view.tools = view.tools.slice(-40);
    for (const tool of view.tools) tool.result = truncateText(tool.result, maxToolResultBytes);
    view.messages = view.messages.slice(-maxViewMessages);
    while (view.messages.length > 2 &&
      view.messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.content), 0) > maxViewMessageBytes) {
      view.messages.shift();
    }
  }

  /** 序列化单个浏览器会话，不暴露 Provider、控制器或访问凭据。 */
  sessionSnapshot(view: WebSession): WebSession {
    return {
      ...view, title: this.sanitizeComplete(view.title), workspace: this.sanitizeComplete(view.workspace),
      response: this.sanitizeStream(view.response),
      messages: view.messages.map((message) => ({ ...message, content: this.sanitizeComplete(message.content) })),
      tools: view.tools.map((tool) => ({
        ...tool, name: this.sanitizeComplete(tool.name), result: this.sanitizeComplete(tool.result),
      })),
      permission: view.permission ? {
        ...view.permission, title: this.sanitizeComplete(view.permission.title),
        detail: this.sanitizeComplete(view.permission.detail),
      } : null,
    };
  }

  /** 返回指定会话的浏览器快照。 */
  getSessionSnapshot(id: string): WebSession {
    return this.sessionSnapshot(this.get(id).view);
  }

  /** 返回浏览器可见快照，显式选取字段避免透出内部配置。 */
  snapshot(): WebState {
    return {
      model: this.sanitizeComplete(this.config.model),
      imageModel: this.sanitizeComplete(this.config.imageModel),
      workspace: this.sanitizeComplete(this.config.workspace),
      sessions: [...this.records.values()].map(({ view }) => this.sessionSnapshot(view)),
    };
  }

  /** 验证工作区并建立独立模型历史，限制并发创建的总数量。 */
  async create(workspace = this.config.workspace): Promise<string> {
    if (this.records.size + this.pendingCreates >= 20) throw new Error('最多保留 20 个会话，请先删除空闲会话');
    this.pendingCreates++;
    try {
      const root = await realpath(workspace);
      if (!(await stat(root)).isDirectory()) throw new Error('工作区必须是目录');
      const context = await collectProjectContext(root);
      const view: WebSession = {
        id: randomUUID(), title: '新任务', workspace: root,
        createdAt: Date.now(), updatedAt: Date.now(), busy: false, status: '就绪',
        startedAt: null, messages: [], response: '', tools: [], permission: null,
      };
      const gate = new PermissionGate((request) => {
        view.permission = request ? { ...request, id: randomUUID() } : null;
        if (request) view.status = '等待你的确认';
        this.onChange(view.id);
      });
      const agent = new AgentLoop(this.provider, this.registry, {
        systemPrompt: redactSecrets(createSystemPrompt(root, context), [this.config.apiKey]),
        maxRounds: this.config.maxRounds, sanitize: (text) => this.sanitizeComplete(text),
        onEvent: (event) => this.handleEvent(view, event),
      });
      this.records.set(view.id, { view, agent, gate, turns: 0 });
      this.onChange();
      return view.id;
    } finally { this.pendingCreates--; }
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
      const tool = [...view.tools].reverse().find((item) => item.name === event.name && item.status === 'running');
      if (tool) {
        tool.status = event.result.startsWith('{"error":') ? 'error' : 'done';
        tool.result = truncateText(event.result, maxToolResultBytes);
        tool.elapsedMs = event.elapsedMs;
      }
    }
    this.trimView(view);
    this.onChange(view.id);
  }

  /** 查找会话并拒绝未知标识。 */
  private get(id: string): SessionRecord {
    const record = this.records.get(id);
    if (!record) throw new Error('会话不存在');
    return record;
  }

  /** 创建使用该会话工作区和逐次确认的执行上下文。 */
  private context(record: SessionRecord, signal: AbortSignal): ToolContext {
    return {
      workspace: record.view.workspace, provider: this.provider, signal,
      confirm: (request, requestSignal) => record.gate.request(request, requestSignal),
    };
  }

  /** 提交一个异步任务，同步设置 busy 防止重复提交。 */
  submit(id: string, prompt: string): void {
    const record = this.get(id);
    const { view } = record;
    if (view.busy) throw new Error('已有任务正在执行');
    if (record.turns >= 50) throw new Error('当前会话已达到长度上限，请新建会话');
    record.turns++;
    const controller = new AbortController();
    record.controller = controller;
    view.busy = true;
    view.startedAt = Date.now();
    view.updatedAt = Date.now();
    view.status = '正在连接模型';
    view.response = '';
    view.tools = [];
    if (!view.messages.length) view.title = this.sanitizeComplete(prompt).slice(0, 36);
    view.messages.push({ id: randomUUID(), role: 'user', content: prompt, createdAt: Date.now() });
    this.trimView(view);
    this.onChange(view.id);
    record.task = this.run(record, prompt, controller);
  }

  /** 执行聊天或图片快捷命令，并在异常和取消时恢复会话。 */
  private async run(record: SessionRecord, prompt: string, controller: AbortController): Promise<void> {
    const { view } = record;
    try {
      let result: string;
      if (prompt.startsWith('/image ')) {
        this.handleEvent(view, { type: 'toolStart', name: 'generateImage' });
        const startedAt = Date.now();
        const imageResult = await this.registry.execute('generateImage', {
          prompt: prompt.slice(7).trim(),
        }, this.context(record, controller.signal));
        result = JSON.stringify(imageResult);
        this.handleEvent(view, { type: 'toolEnd', name: 'generateImage', result, elapsedMs: Date.now() - startedAt });
        const imageError = toolError(imageResult);
        if (imageError) throw new Error(imageError);
      } else {
        result = await record.agent.run(prompt, this.context(record, controller.signal));
      }
      view.messages.push({
        id: randomUUID(), role: 'assistant',
        content: truncateText(this.sanitizeComplete(view.response || result), maxStableMessageBytes),
        createdAt: Date.now(),
      });
      view.status = '已完成';
    } catch (error) {
      const reason = controller.signal.aborted ? '任务已停止。你可以继续发送指令。' :
        this.sanitizeComplete(error instanceof Error ? error.message : String(error));
      const partial = view.response ?
        `未完成的模型输出（未加入后续模型历史）：\n\n${this.sanitizeComplete(view.response)}\n\n` : '';
      view.messages.push({
        id: randomUUID(), role: 'notice', createdAt: Date.now(),
        content: truncateText(`${partial}${reason}`, maxStableMessageBytes),
      });
      view.status = controller.signal.aborted ? '已停止' : '请求失败';
    } finally {
      for (const tool of view.tools) if (tool.status === 'running') {
        tool.status = 'error';
        tool.result = '任务已停止或未完成';
      }
      view.response = '';
      view.busy = false;
      view.permission = null;
      view.updatedAt = Date.now();
      record.controller = undefined;
      this.trimView(view);
      this.onChange(view.id);
    }
  }

  /** 使用审批 ID 防止旧页面误批准后续操作。 */
  respond(id: string, permissionId: string, approved: boolean): void {
    const record = this.get(id);
    if (!record.view.permission || record.view.permission.id !== permissionId) throw new Error('审批已过期');
    record.gate.respond(approved);
  }

  /** 取消正在运行或等待授权的任务。 */
  cancel(id: string): void {
    this.get(id).controller?.abort();
  }

  /** 删除空闲会话，忙碌会话需先中断。 */
  remove(id: string): void {
    if (this.get(id).view.busy) throw new Error('请先停止正在执行的任务');
    this.records.delete(id);
    this.onChange();
  }

  /** 只读面板仅开放文件枚举、文本读取及固定 Git diff 工具。 */
  async inspect(id: string, input: InspectInput): Promise<unknown> {
    const record = this.get(id);
    const target = input.path ?? '.';
    if (target.split(/[\\/]/).some((part) => part.startsWith('.env'))) throw new Error('面板不展示环境密钥文件');
    const name = input.kind === 'files' ? 'listFiles' : input.kind === 'file' ? 'readFile' : 'getDiff';
    const args = input.kind === 'files' ? { path: '.', maxEntries: 500 } :
      input.kind === 'file' ? { path: target, maxBytes: 65536 } : {};
    const context = this.context(record, AbortSignal.timeout(35_000));
    const result = await this.registry.execute(name, args, context);
    return JSON.parse(this.sanitizeComplete(JSON.stringify(result)));
  }

  /** 浏览器断开或服务退出时取消全部任务。 */
  cancelAll(): void {
    for (const record of this.records.values()) record.controller?.abort();
  }

  /** 退出前等待工具清理，避免留下 Shell 子进程。 */
  async close(): Promise<void> {
    this.cancelAll();
    await Promise.allSettled([...this.records.values()].map((record) => record.task));
  }
}
