import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { AgentLoop, type AgentEvent } from '../agent/AgentLoop.js';
import { redactSecrets, redactStream, type AgentConfig } from '../config/loadConfig.js';
import type { ModelProvider } from '../providers/types.js';
import { PermissionGate } from '../security/PermissionGate.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import type { PermissionRequest, ToolContext } from '../tools/types.js';
import { PermissionPrompt } from './PermissionPrompt.js';

interface AppProps {
  config: AgentConfig;
  provider: ModelProvider;
  systemPrompt: string;
}

interface Message {
  role: '你' | 'Agent' | '提示';
  content: string;
}

const helpText = '/help 帮助 · /clear 清空会话 · /exit 退出\n/image <提示词> 生成图片\n写文件、执行命令和图片生成均需确认；Ctrl+C 中断，再按退出。';

/** 交互式终端，集中处理任务、中断和逐次权限确认。 */
export function App({ config, provider, systemPrompt }: AppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [response, setResponse] = useState('');
  const [status, setStatus] = useState('就绪');
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [toolLog, setToolLog] = useState<string[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const textRef = useRef('');
  const startedAtRef = useRef(0);
  const interruptedRef = useRef(false);
  const registry = useMemo(() => new ToolRegistry(), []);
  const gate = useMemo(() => new PermissionGate(setPermission), []);

  /** 所有终端输出均在完整文本上脱敏，阻止终端控制字符。 */
  function sanitize(text: string): string {
    return redactSecrets(text, [config.apiKey]);
  }

  /** 将核心事件转换为当前回答和有限数量的工具状态。 */
  function onAgentEvent(event: AgentEvent): void {
    if (event.type === 'text') {
      textRef.current += event.text;
      setResponse(textRef.current);
    } else if (event.type === 'thinking') {
      if (textRef.current) textRef.current = `${redactStream(textRef.current, [config.apiKey])}\n`;
      setStatus(`思考中 · 第 ${event.round} 轮`);
    } else if (event.type === 'toolStart') {
      setStatus(`执行 ${event.name}`);
    } else {
      setToolLog((items) => [...items.slice(-7), `${event.name} · ${event.elapsedMs}ms · ${event.result.slice(0, 500)}`]);
    }
  }

  const agent = useMemo(() => new AgentLoop(provider, registry, {
    systemPrompt, maxRounds: config.maxRounds, sanitize, onEvent: onAgentEvent,
  }), [provider, registry, systemPrompt, config.maxRounds, config.apiKey]);

  useEffect(() => {
    if (!busy || permission) return;
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 100);
    return () => clearInterval(timer);
  }, [busy, permission]);

  useEffect(() => () => controllerRef.current?.abort(), []);

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

  /** 执行普通会话或图片快捷命令，确保取消和异常后恢复输入。 */
  async function handleSubmit(value: string): Promise<void> {
    const prompt = value.trim();
    if (!prompt || controllerRef.current) return;
    setInput('');
    if (prompt === '/exit') { exit(); return; }
    if (prompt === '/help') {
      setMessages((items) => [...items, { role: '提示', content: helpText }]);
      return;
    }
    if (prompt === '/clear') {
      agent.clear();
      setMessages([]);
      setToolLog([]);
      setResponse('');
      setStatus('就绪');
      return;
    }
    if (prompt.startsWith('/') && !prompt.startsWith('/image ')) {
      setMessages((items) => [...items, { role: '提示', content: '未知命令或缺少参数，请输入 /help。' }]);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    interruptedRef.current = false;
    textRef.current = '';
    startedAtRef.current = Date.now();
    setBusy(true);
    setResponse('');
    setToolLog([]);
    setElapsedMs(0);
    setMessages((items) => [...items, { role: '你', content: prompt }]);
    const context: ToolContext = {
      workspace: config.workspace,
      provider,
      signal: controller.signal,
      confirm: (request, signal) => gate.request(request, signal),
    };
    try {
      let result: string;
      if (prompt.startsWith('/image ')) {
        setStatus('生成图片');
        result = JSON.stringify(await registry.execute('generateImage', { prompt: prompt.slice(7).trim() }, context), null, 2);
      } else {
        result = await agent.run(prompt, context);
      }
      setMessages((items) => [...items, { role: 'Agent', content: redactStream(textRef.current || result, [config.apiKey]) }]);
    } catch (error) {
      const content = controller.signal.aborted ? '任务已中断，可继续输入新任务。' :
        `错误：${error instanceof Error ? error.message : String(error)}`;
      setMessages((items) => [...items, { role: '提示', content }]);
    } finally {
      controllerRef.current = null;
      setResponse('');
      setBusy(false);
      setStatus('就绪');
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
      {!busy && (
        <Box><Text color="green">❯ </Text><TextInput value={input} onChange={setInput} onSubmit={handleSubmit} placeholder="输入任务或 /help" /></Box>
      )}
    </Box>
  );
}
