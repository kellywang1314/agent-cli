import { realpath } from 'node:fs/promises';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { AgentEvent } from '../agent/AgentLoop.js';
import { redactSecrets, redactStream, type AgentConfig } from '../config/loadConfig.js';
import type { MemoryService } from '../memory/MemoryService.js';
import type {
  StoredDisplayMessage,
  StoredSession,
} from '../persistence/types.js';
import { PermissionGate } from '../security/PermissionGate.js';
import type { SessionService } from '../sessions/SessionService.js';
import type { SessionSummary } from '../sessions/types.js';
import type { PermissionRequest } from '../tools/types.js';
import { PermissionPrompt } from './PermissionPrompt.js';

interface AppProps {
  config: AgentConfig;
  sessionService: SessionService;
  memoryService: MemoryService;
}

interface Message {
  role: '你' | 'Agent' | '提示';
  content: string;
}

const helpText = [
  '/help 帮助 · /new 新会话 · /clear 新会话 · /exit 退出',
  '/sessions 列出会话 · /resume <id> 恢复 · /delete-session <id> 删除',
  '/memory 管理项目记忆 · /image <提示词> 生成图片',
  '写文件、执行命令和图片生成均需确认；Ctrl+C 中断，再按退出。',
].join('\n');

/** 将持久化显示角色映射为终端标签。 */
function toMessage(message: StoredDisplayMessage): Message {
  return {
    role: message.role === 'user' ? '你'
      : message.role === 'assistant' ? 'Agent'
        : '提示',
    content: message.content,
  };
}

/** 将持久会话状态转换为面向用户的短状态。 */
function statusLabel(status: StoredSession['status']): string {
  if (status === 'running') return '运行中';
  if (status === 'interrupted') return '已中断';
  if (status === 'failed') return '失败';
  return '就绪';
}

/** 解析完整 UUID 或当前工作区内唯一的八位会话前缀。 */
function resolveSession(
  sessions: SessionSummary[],
  input: string,
): SessionSummary {
  const exact = sessions.find(({ id }) => id === input);
  if (exact) return exact;
  if (input.length !== 8) throw new Error('请输入完整会话 ID 或八位前缀');
  const matches = sessions.filter(({ id }) => id.startsWith(input));
  if (matches.length === 0) throw new Error('会话不存在');
  if (matches.length > 1) throw new Error('会话前缀不唯一，请输入完整 ID');
  return matches[0]!;
}

/** 交互式终端，集中处理持久会话、任务中断和逐次权限确认。 */
export function App({ config, sessionService, memoryService }: AppProps) {
  const { exit } = useApp();
  const [initialized, setInitialized] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [response, setResponse] = useState('');
  const [status, setStatus] = useState('正在恢复会话');
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [toolLog, setToolLog] = useState<string[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const textRef = useRef('');
  const startedAtRef = useRef(0);
  const interruptedRef = useRef(false);
  const workspaceRef = useRef(config.workspace);
  const gate = useMemo(() => new PermissionGate(setPermission), []);

  /** 所有终端输出均在完整文本上脱敏，阻止终端控制字符。 */
  function sanitize(text: string): string {
    return redactSecrets(text, [config.apiKey]);
  }

  /** 读取会话详情并替换当前终端历史。 */
  function loadSession(id: string, notice?: string): void {
    const detail = sessionService.load(id);
    setSessionId(id);
    setMessages([
      ...detail.messages.map(toMessage),
      ...(notice ? [{ role: '提示' as const, content: notice }] : []),
    ]);
    setResponse('');
    setToolLog([]);
    setStatus(statusLabel(detail.status));
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      workspaceRef.current = await realpath(config.workspace);
      const sessions = sessionService.list({
        workspace: workspaceRef.current,
        clientType: 'cli',
      });
      const recent = sessions[0];
      const id = recent?.id ?? await sessionService.create('cli', workspaceRef.current);
      if (!active) return;
      loadSession(id, recent ? `已恢复会话 ${id.slice(0, 8)}` : undefined);
      setInitialized(true);
    })().catch((error) => {
      if (!active) return;
      setMessages([{ role: '提示', content: `初始化失败：${sanitize(String(error))}` }]);
      setStatus('初始化失败');
    });
    return () => {
      active = false;
      controllerRef.current?.abort();
    };
  }, [config.workspace, sessionService]);

  useEffect(() => {
    if (!busy || permission) return;
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 100);
    return () => clearInterval(timer);
  }, [busy, permission]);

  /** 将核心事件转换为当前回答和有限数量的工具状态。 */
  function onAgentEvent(event: AgentEvent): void {
    if (event.type === 'text') {
      textRef.current += event.text;
      setResponse(textRef.current);
    } else if (event.type === 'thinking') {
      if (textRef.current) {
        textRef.current = `${redactStream(textRef.current, [config.apiKey])}\n`;
      }
      setStatus(`思考中 · 第 ${event.round} 轮`);
    } else if (event.type === 'toolStart') {
      setStatus(`执行 ${event.name}`);
    } else {
      setToolLog((items) => [
        ...items.slice(-7),
        `${event.name} · ${event.elapsedMs}ms · ${event.result.slice(0, 500)}`,
      ]);
    }
  }

  /** 首次 Ctrl+C 中断任务，再次退出；权限默认拒绝。 */
  useInput((value, key) => {
    if (key.ctrl && value === 'c') {
      if (controllerRef.current && !interruptedRef.current) {
        interruptedRef.current = true;
        controllerRef.current.abort();
        setStatus('正在中断');
      } else {
        controllerRef.current?.abort();
        exit();
      }
      return;
    }
    if (permission) {
      if (value.toLowerCase() === 'y') gate.respond(true);
      else if (value.toLowerCase() === 'n' || key.return || key.escape) gate.respond(false);
    }
  });

  /** 创建并切换到当前工作区的新 CLI 会话。 */
  async function createNewSession(): Promise<void> {
    const id = await sessionService.create('cli', workspaceRef.current);
    loadSession(id);
  }

  /** 返回当前工作区全部 CLI 会话。 */
  function listSessions(): SessionSummary[] {
    return sessionService.list({
      workspace: workspaceRef.current,
      clientType: 'cli',
    });
  }

  /** 向终端追加一条不会写入会话历史的本地提示。 */
  function appendNotice(content: string): void {
    setMessages((items) => [...items, { role: '提示', content }]);
  }

  /** 展示当前工作区会话摘要。 */
  function showSessions(): void {
    const sessions = listSessions();
    appendNotice(sessions.length
      ? sessions.map((session) =>
        `${session.id.slice(0, 8)} · ${session.title} · ${statusLabel(session.status)}`,
      ).join('\n')
      : '当前工作区没有 CLI 会话');
  }

  /** 恢复完整 ID 或唯一八位前缀指定的 CLI 会话。 */
  function resumeSession(inputId: string): void {
    const session = resolveSession(listSessions(), inputId);
    loadSession(session.id, `已恢复会话 ${session.id.slice(0, 8)}`);
  }

  /** 删除空闲 CLI 会话；删除当前会话后立即创建替代会话。 */
  async function deleteSession(inputId: string): Promise<void> {
    const session = resolveSession(listSessions(), inputId);
    sessionService.remove(session.id);
    if (session.id === sessionId) {
      await createNewSession();
    }
    appendNotice(`已删除会话 ${session.id.slice(0, 8)}`);
  }

  /** 展示项目记忆摘要，完整交互由记忆管理界面接管。 */
  function openMemoryManager(): void {
    const state = memoryService.getState(sessionId);
    appendNotice(state.memories.length
      ? `项目记忆\n${state.memories.map((memory, index) =>
        `${index + 1}. ${memory.active ? '[启用]' : '[停用]'} ${memory.content}`,
      ).join('\n')}`
      : '项目记忆\n当前没有已确认记忆');
  }

  /** 通过共享会话服务执行普通任务或图片命令。 */
  async function runTask(prompt: string): Promise<void> {
    const controller = new AbortController();
    controllerRef.current = controller;
    interruptedRef.current = false;
    textRef.current = '';
    startedAtRef.current = Date.now();
    setBusy(true);
    setResponse('');
    setToolLog([]);
    setElapsedMs(0);
    setStatus('正在连接模型');
    try {
      const result = await sessionService.run(sessionId, prompt, {
        onAgentEvent,
        onDisplayMessage: (message) => {
          setMessages((items) => [...items, toMessage(message)]);
        },
        onStatus: (nextStatus) => setStatus(statusLabel(nextStatus)),
        confirm: (request, signal) => gate.request(request, signal),
      }, controller.signal);
      void result.memoryExtraction?.catch(() => {});
    } catch {
      // SessionService 已持久化并通知失败或取消提示。
    } finally {
      controllerRef.current = null;
      setResponse('');
      setBusy(false);
      setStatus('就绪');
    }
  }

  /** 先解析本地命令，再将普通输入交给共享会话服务。 */
  async function handleSubmit(value: string): Promise<void> {
    const prompt = value.trim();
    if (!prompt || controllerRef.current || !initialized) return;
    setInput('');
    if (prompt === '/exit') {
      exit();
      return;
    }
    if (prompt === '/help') {
      appendNotice(helpText);
      return;
    }
    try {
      if (prompt === '/new' || prompt === '/clear') {
        await createNewSession();
      } else if (prompt === '/sessions') {
        showSessions();
      } else if (prompt.startsWith('/resume ')) {
        resumeSession(prompt.slice(8).trim());
      } else if (prompt.startsWith('/delete-session ')) {
        await deleteSession(prompt.slice(16).trim());
      } else if (prompt === '/memory') {
        openMemoryManager();
      } else if (prompt.startsWith('/') && !prompt.startsWith('/image ')) {
        appendNotice('未知命令或缺少参数，请输入 /help。');
      } else {
        await runTask(prompt);
      }
    } catch (error) {
      appendNotice(error instanceof Error ? error.message : String(error));
    }
  }

  if (permission) {
    return <PermissionPrompt key={`${permission.title}:${permission.detail}`}
      request={{ title: sanitize(permission.title), detail: sanitize(permission.detail) }} />;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
        <Text bold color="cyan">Agent CLI</Text>
        <Text>{sanitize(config.model)} · {sanitize(config.workspace)}</Text>
        <Text dimColor>代码协作 / 图片生成 · 输入 /help 查看帮助</Text>
      </Box>
      {messages.map((message, index) => (
        <Box key={index} flexDirection="column" marginTop={1}>
          <Text bold color={message.role === '你' ? 'green' : message.role === '提示' ? 'yellow' : 'cyan'}>{message.role}</Text>
          <Text>{sanitize(message.content)}</Text>
        </Box>
      ))}
      {toolLog.map((item, index) => <Text key={index} dimColor>{sanitize(item)}</Text>)}
      {response && <Box marginTop={1}><Text>{redactStream(response, [config.apiKey])}</Text></Box>}
      <Box marginTop={1}><Text dimColor>{status}{busy ? ` · ${(elapsedMs / 1000).toFixed(1)}s` : ''}</Text></Box>
      {initialized && !busy && (
        <Box><Text color="green">❯ </Text><TextInput value={input} onChange={setInput}
          onSubmit={handleSubmit} placeholder="输入任务或 /help" /></Box>
      )}
    </Box>
  );
}
