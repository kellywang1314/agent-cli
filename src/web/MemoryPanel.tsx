import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon } from './components.js';
import type {
  WebMemory,
  WebMemoryCandidate,
  WebMemoryState,
} from './types.js';

const categoryLabels = {
  rule: '规则',
  decision: '决策',
  fact: '事实',
  preference: '偏好',
} as const;

/** 展示并管理当前会话工作区内的长期记忆。 */
export function MemoryPanel({ sessionId }: { sessionId?: string }) {
  const [state, setState] = useState<WebMemoryState | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [editingCandidateId, setEditingCandidateId] = useState('');
  const [draft, setDraft] = useState('');
  const requestVersion = useRef(0);
  const operationVersion = useRef(0);
  const pendingRef = useRef(false);

  /** 获取指定会话的记忆状态，并忽略会话切换后的旧响应。 */
  async function loadMemoryState(targetId: string, version: number): Promise<void> {
    try {
      const nextState = await api<WebMemoryState>(
        `/api/sessions/${targetId}/memories`,
      );
      if (version === requestVersion.current) setState(nextState);
    } catch (failure) {
      if (version === requestVersion.current) {
        setError(failure instanceof Error ? failure.message : '加载记忆失败');
      }
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    const version = ++requestVersion.current;
    operationVersion.current++;
    pendingRef.current = false;
    setPending(false);
    setError('');
    setEditingCandidateId('');
    setDraft('');
    setState(null);
    if (!sessionId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadMemoryState(sessionId, version);
    return () => { requestVersion.current++; };
  }, [sessionId]);

  /** 串行执行写操作，仅让当前会话的最新操作更新面板。 */
  async function perform(action: () => Promise<WebMemoryState>): Promise<boolean> {
    if (pendingRef.current) return false;
    const request = requestVersion.current;
    const operation = ++operationVersion.current;
    pendingRef.current = true;
    setPending(true);
    setError('');
    try {
      const nextState = await action();
      if (
        request === requestVersion.current &&
        operation === operationVersion.current
      ) {
        setState(nextState);
        return true;
      }
      return false;
    } catch (failure) {
      if (
        request === requestVersion.current &&
        operation === operationVersion.current
      ) {
        setError(failure instanceof Error ? failure.message : '操作失败');
      }
      return false;
    } finally {
      if (operation === operationVersion.current) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  /** 接受候选原文，或提交编辑后的内容。 */
  async function acceptCandidate(
    candidateId: string,
    content?: string,
  ): Promise<void> {
    if (!sessionId) return;
    const accepted = await perform(() => api<WebMemoryState>(
      `/api/sessions/${sessionId}/memory-candidates/${candidateId}`,
      content === undefined ? { action: 'accept' } : { action: 'accept', content },
      'PATCH',
    ));
    if (accepted) {
      setEditingCandidateId('');
      setDraft('');
    }
  }

  /** 忽略一条不需要保留的候选。 */
  async function ignoreCandidate(candidateId: string): Promise<void> {
    if (!sessionId) return;
    await perform(() => api<WebMemoryState>(
      `/api/sessions/${sessionId}/memory-candidates/${candidateId}`,
      { action: 'ignore' },
      'PATCH',
    ));
  }

  /** 重新提取当前会话最后一轮完整普通任务。 */
  async function retryExtraction(): Promise<void> {
    if (!sessionId) return;
    await perform(() => api<WebMemoryState>(
      `/api/sessions/${sessionId}/memory-extraction/retry`,
      {},
    ));
  }

  /** 切换正式记忆的启用状态。 */
  async function toggleMemory(memory: WebMemory): Promise<void> {
    if (!sessionId) return;
    await perform(() => api<WebMemoryState>(
      `/api/sessions/${sessionId}/memories/${memory.id}`,
      { active: !memory.active },
      'PATCH',
    ));
  }

  /** 经用户确认后永久删除正式记忆。 */
  async function deleteMemory(memoryId: string): Promise<void> {
    if (!sessionId || !window.confirm('删除这条记忆？此操作无法撤销。')) return;
    await perform(() => api<WebMemoryState>(
      `/api/sessions/${sessionId}/memories/${memoryId}`,
      undefined,
      'DELETE',
    ));
  }

  /** 打开候选编辑器并以当前内容作为草稿。 */
  function editCandidate(candidate: WebMemoryCandidate): void {
    setEditingCandidateId(candidate.id);
    setDraft(candidate.content);
  }

  if (!sessionId) {
    return <div className="memory-panel"><div className="panel-empty">
      <p>选择会话后查看记忆。</p>
    </div></div>;
  }
  if (loading) {
    return <div className="memory-panel"><div className="loading">
      <span className="spinner" />正在读取记忆…
    </div></div>;
  }
  if (!state) {
    return <div className="memory-panel">
      {error && <div className="panel-error" role="alert">{error}</div>}
    </div>;
  }

  return <div className="memory-panel">
    {error && <div className="panel-error" role="alert">{error}</div>}
    {state?.extractionStatus === 'running' && <div className="memory-extraction">
      <span className="spinner" />正在提取记忆…
    </div>}
    {state?.extractionStatus === 'failed' && <div className="memory-extraction failed">
      <span>{state.extractionError || '记忆提取失败'}</span>
      <button className="memory-action" disabled={pending} onClick={() => void retryExtraction()}>
        <Icon name="refresh" size={13} />重试提取
      </button>
    </div>}

    {Boolean(state?.candidates.length) && <section className="memory-section">
      <div className="memory-section-heading">
        <strong>待确认</strong><span>{state?.candidates.length}</span>
      </div>
      {state?.candidates.map((candidate) => <article className="memory-row" key={candidate.id}>
        <div className="memory-row-meta">
          <span>{categoryLabels[candidate.category]}</span>
          <time>{new Date(candidate.createdAt).toLocaleDateString('zh-CN')}</time>
        </div>
        {editingCandidateId === candidate.id ? <div className="memory-editor">
          <textarea value={draft} maxLength={1000} rows={4}
            aria-label="编辑候选记忆"
            onChange={(event) => setDraft(event.target.value)} />
          <div className="memory-actions">
            <button className="memory-action" disabled={pending}
              onClick={() => { setEditingCandidateId(''); setDraft(''); }}>
              <Icon name="close" size={13} />取消
            </button>
            <button className="memory-action primary" disabled={pending || !draft.trim()}
              onClick={() => void acceptCandidate(candidate.id, draft)}>
              <Icon name="check" size={13} />接受修改
            </button>
          </div>
        </div> : <>
          <p className="memory-content">{candidate.content}</p>
          <div className="memory-actions">
            <button className="memory-action" disabled={pending}
              onClick={() => editCandidate(candidate)}>
              <Icon name="edit" size={13} />编辑
            </button>
            <button className="memory-action" disabled={pending}
              onClick={() => void ignoreCandidate(candidate.id)}>
              <Icon name="close" size={13} />忽略
            </button>
            <button className="memory-action primary" disabled={pending}
              onClick={() => void acceptCandidate(candidate.id)}>
              <Icon name="check" size={13} />接受
            </button>
          </div>
        </>}
      </article>)}
    </section>}

    <section className="memory-section">
      <div className="memory-section-heading">
        <strong><Icon name="memory" size={13} />已确认</strong>
        <span>{state?.memories.length ?? 0}</span>
      </div>
      {state?.memories.length ? state.memories.map((memory) =>
        <article className={`memory-row ${memory.active ? '' : 'inactive'}`} key={memory.id}>
          <div className="memory-row-meta">
            <span>{categoryLabels[memory.category]}</span>
            <time>{new Date(memory.updatedAt).toLocaleDateString('zh-CN')}</time>
          </div>
          <p className="memory-content">{memory.content}</p>
          <div className="memory-actions">
            <button className="memory-action" disabled={pending}
              onClick={() => void toggleMemory(memory)}>
              <Icon name={memory.active ? 'pause' : 'refresh'} size={13} />
              {memory.active ? '停用' : '恢复'}
            </button>
            <button className="memory-action danger" disabled={pending}
              onClick={() => void deleteMemory(memory.id)}>
              <Icon name="trash" size={13} />删除
            </button>
          </div>
        </article>) : <div className="memory-empty">当前没有已确认记忆。</div>}
    </section>
  </div>;
}
