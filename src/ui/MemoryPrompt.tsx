import { useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import wrapAnsi from 'wrap-ansi';
import type { StoredMemoryCandidate } from '../persistence/types.js';

interface MemoryPromptProps {
  candidates: StoredMemoryCandidate[];
  onAccept: (candidateId: string, content?: string) => Promise<void>;
  onIgnore: (candidateId: string) => Promise<void>;
  onDone: () => void;
}

/** 将操作错误压缩为不包含终端控制符的单行文本。 */
function formatError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim() || '操作失败';
}

/** 在固定行数内逐条确认、编辑或忽略候选记忆。 */
export function MemoryPrompt({
  candidates,
  onAccept,
  onIgnore,
  onDone,
}: MemoryPromptProps) {
  const { stdout } = useStdout();
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<'choose' | 'edit'>('choose');
  const [draft, setDraft] = useState(candidates[0]?.content ?? '');
  const draftRef = useRef(candidates[0]?.content ?? '');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const candidate = candidates[index];

  /** 完成当前操作后推进到下一条，处理完全部候选时退出。 */
  async function advance(action: () => Promise<void>): Promise<void> {
    if (pending || !candidate) return;
    setPending(true);
    setError('');
    try {
      await action();
      const nextIndex = index + 1;
      if (nextIndex >= candidates.length) {
        onDone();
        return;
      }
      setIndex(nextIndex);
      draftRef.current = candidates[nextIndex]!.content;
      setDraft(candidates[nextIndex]!.content);
      setMode('choose');
    } catch (failure) {
      setError(formatError(failure));
    } finally {
      setPending(false);
    }
  }

  /** 提交编辑后的非空候选内容。 */
  function submitEdit(value: string): void {
    if (!value.trim()) {
      setError('记忆内容不能为空');
      return;
    }
    void advance(() => onAccept(candidate!.id, value));
  }

  useInput((value, key) => {
    if (pending || !candidate) return;
    if (mode === 'edit') {
      if (key.escape) {
        draftRef.current = candidate.content;
        setDraft(candidate.content);
        setError('');
        setMode('choose');
      }
      return;
    }
    if (value.toLowerCase() === 'a') {
      void advance(() => onAccept(candidate.id));
    } else if (value.toLowerCase() === 'e') {
      draftRef.current = candidate.content;
      setDraft(candidate.content);
      setError('');
      setMode('edit');
    } else if (value.toLowerCase() === 'i') {
      void advance(() => onIgnore(candidate.id));
    }
  });

  if (!candidate) return null;
  const width = Math.max(20, (stdout.columns || 80) - 4);
  const preview = wrapAnsi(candidate.content, width, {
    hard: true,
    trim: false,
    wordWrap: false,
  }).split('\n').slice(0, 8).join('\n');

  return <Box flexDirection="column" paddingX={1}>
    <Text bold color="cyan">候选记忆 {index + 1}/{candidates.length}</Text>
    <Text dimColor>{candidate.category}</Text>
    {mode === 'edit' ? <>
      <Text color="yellow">编辑记忆</Text>
      <Box><Text color="green">❯ </Text><TextInput value={draft}
        onChange={(value) => {
          draftRef.current = value;
          setDraft(value);
        }}
        onSubmit={() => submitEdit(draftRef.current)} /></Box>
      <Text dimColor>Enter 保存 · Esc 返回</Text>
    </> : <>
      <Text>{preview}</Text>
      <Text dimColor>[a] 接受 · [e] 编辑 · [i] 忽略</Text>
    </>}
    {pending && <Text dimColor>正在保存…</Text>}
    {error && <Text color="red">{error}</Text>}
  </Box>;
}
