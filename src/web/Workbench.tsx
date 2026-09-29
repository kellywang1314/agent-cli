import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { api, subscribe } from './api.js';
import { AgentMark, CopyButton, Icon, Markdown, PermissionCard } from './components.js';
import { Inspector } from './Inspector.js';
import type { WebState } from './types.js';

const suggestions = [
  { icon: 'search', title: '读懂一个项目', detail: '从结构到核心逻辑，快速上手', prompt: '请浏览项目结构，阅读 README 和主要入口，介绍这个项目的架构与运行方式。' },
  { icon: 'code', title: '一起改进代码', detail: '定位问题，给出清晰的修改', prompt: '请先阅读项目说明和核心代码，找出一个值得改进的问题并解释原因。修改前先向我展示方案。' },
  { icon: 'image', title: '把灵感变成图片', detail: '描述画面，生成创意素材', prompt: '/image ' },
];

/** 从路径取工作区名称，兼容根目录。 */
function workspaceName(workspace: string): string {
  return workspace.split('/').filter(Boolean).at(-1) || workspace || '选择工作区';
}

/** 渲染连接本地 Agent 的会话、任务输入及工作区检查界面。 */
export function Workbench() {
  const [state, setState] = useState<WebState | null>(null);
  const [activeId, setActiveId] = useState(sessionStorage.getItem('agentActiveSession') ?? '');
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState(false);
  const [input, setInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(window.innerWidth >= 1180);
  const [workspaceInput, setWorkspaceInput] = useState('');
  const [clock, setClock] = useState(Date.now());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const active = state?.sessions.find((session) => session.id === activeId);
  const workspace = active?.workspace ?? state?.workspace ?? '';

  useEffect(() => subscribe(setState, (ready, error) => {
    setConnected(ready);
    setConnectionError(error ?? '');
  }), []);
  useEffect(() => {
    sessionStorage.setItem('agentActiveSession', activeId);
    setActionError('');
    followRef.current = true;
    setSidebarOpen(false);
  }, [activeId]);
  useEffect(() => {
    if (state && activeId && !state.sessions.some((session) => session.id === activeId)) setActiveId('');
  }, [state, activeId]);
  useEffect(() => {
    if (followRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [active?.response, active?.messages.length, active?.permission, active?.tools.length, activeId]);
  useEffect(() => {
    if (!active?.busy) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active?.busy]);
  useEffect(() => {
    const textarea = composerRef.current;
    if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`; }
  }, [input]);

  /** 串行提交 UI 操作并集中反馈可恢复的网络错误。 */
  async function perform(action: () => Promise<void>): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setActionError('');
    try { await action(); } catch (error) {
      setActionError(error instanceof Error ? error.message : '操作失败');
    } finally { pendingRef.current = false; setPending(false); }
  }

  /** 新建独立会话并立即刷新列表，不依赖 SSE 到达顺序。 */
  async function createSession(targetWorkspace?: string): Promise<string> {
    setInput('');
    const { id } = await api<{ id: string }>('/api/sessions', { workspace: (targetWorkspace ?? workspace) || undefined });
    const nextState = await api<WebState>('/api/state');
    setState(nextState);
    setActiveId(id);
    return id;
  }

  /** 提交多行任务，首次发送时创建会话。 */
  async function submit(event?: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    const prompt = input.trim();
    if (!prompt || active?.busy || !connected) return;
    await perform(async () => {
      const id = active?.id ?? await createSession();
      await api(`/api/sessions/${id}/message`, { prompt });
      setInput('');
      followRef.current = true;
      setState(await api<WebState>('/api/state'));
    });
  }

  /** Enter 提交，Shift+Enter 换行，中文输入法候选确认不触发发送。 */
  function handleInputKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  /** 填入任务建议，并将光标放到编辑器。 */
  function chooseSuggestion(prompt: string): void {
    setInput(prompt);
    composerRef.current?.focus();
  }

  /** 显式切换会话时清理当前草稿，避免把任务发到错误上下文。 */
  function selectSession(id: string): void {
    setInput('');
    setActiveId(id);
  }

  /** 用户确认后仅删除空闲会话。 */
  function deleteSession(id: string): void {
    if (!window.confirm('删除这个会话？本地代码和文件不会被删除。')) return;
    void perform(async () => {
      await api(`/api/sessions/${id}`, undefined, 'DELETE');
      setState(await api<WebState>('/api/state'));
      if (activeId === id) setActiveId('');
    });
  }

  /** 更换工作区时创建新会话，保留原会话的代码上下文。 */
  function submitWorkspace(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    void perform(async () => {
      await createSession(workspaceInput.trim());
      dialogRef.current?.close();
    });
  }

  const elapsed = active?.startedAt ? Math.max(0, Math.floor((clock - active.startedAt) / 1000)) : 0;
  const hasConversation = Boolean(active?.messages.length);
  return <div className={`workbench ${sidebarOpen ? 'sidebar-open' : ''} ${inspectorOpen ? 'inspector-open' : ''}`}>
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} />}
    <aside className="sidebar">
      <div className="brand"><AgentMark /><strong>Agent</strong><span className="brand-tag">WORKSPACE</span>
        <button className="icon-button mobile-close" onClick={() => setSidebarOpen(false)} aria-label="关闭会话栏"><Icon name="close" /></button>
      </div>
      <button className="new-task" disabled={!connected || pending} onClick={() => void perform(async () => { await createSession(); })}>
        <Icon name="plus" size={17} /><span>新任务</span><span className="new-task-symbol">↗</span>
      </button>
      <button className="workspace-switch" title={workspace} disabled={!state || pending} onClick={() => {
        setWorkspaceInput(workspace); dialogRef.current?.showModal();
      }}><Icon name="folder" size={17} /><span>{workspaceName(workspace)}</span><Icon name="chevron" size={13} /></button>
      <div className="sidebar-section-label">任务记录<span>{state?.sessions.length ?? 0}</span></div>
      <nav className="session-list" aria-label="任务会话">
        {state?.sessions.length ? [...state.sessions].reverse().map((session) =>
          <div key={session.id} className={`session-row ${activeId === session.id ? 'selected' : ''}`}>
            <button className="session-select" onClick={() => selectSession(session.id)}>
              <span className={`session-dot ${session.busy ? 'running' : ''}`} />
              <span><strong>{session.title}</strong><small>{workspaceName(session.workspace)} · {session.permission ? '等待确认' : session.busy ? '进行中' : '本次运行'}</small></span>
            </button>
            {!session.busy && <button className="icon-button session-delete" disabled={pending} aria-label={`删除会话 ${session.title}`} onClick={() => deleteSession(session.id)}><Icon name="trash" size={14} /></button>}
          </div>) : <div className="no-sessions"><p>好想法，从一次对话开始。</p><span>你的任务会显示在这里</span></div>}
      </nav>
      <div className="sidebar-bottom">
        <div className="local-badge"><span className={`status-dot ${connected ? '' : 'offline'}`} /><span>{connected ? '本地服务已连接' : '正在连接本地服务'}</span></div>
        <div className="profile"><span className="profile-avatar">你</span><div><strong>个人工作区</strong><small>代码留在你的 Mac 上</small></div><Icon name="shield" size={16} /></div>
      </div>
    </aside>
    <main className="main-pane">
      <header className="topbar"><div className="breadcrumb">
        <button className="icon-button sidebar-toggle" aria-label="打开会话栏" onClick={() => setSidebarOpen(!sidebarOpen)}><Icon name="sidebar" /></button>
        <Icon name="folder" size={15} /><span>{workspaceName(workspace)}</span><span className="breadcrumb-separator">/</span>
        <strong>{hasConversation ? active?.title : '新任务'}</strong>
      </div><div className="topbar-actions"><span className="local-tag"><span className="status-dot" />本地</span>
        <button className={`icon-button ${inspectorOpen ? 'is-active' : ''}`} title="切换工作区面板" aria-label="切换工作区面板" aria-pressed={inspectorOpen}
          onClick={() => setInspectorOpen(!inspectorOpen)}><Icon name="panel" /></button></div></header>
      {!connected && <div className="connection-banner" role="status"><span className="spinner" />{connectionError || '正在连接本地服务…'}</div>}
      <div className={`conversation-scroll ${hasConversation ? '' : 'welcome-scroll'}`} ref={scrollRef} onScroll={() => {
        const element = scrollRef.current;
        if (element) followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
      }}>
        {!hasConversation ? <section className="welcome">
          <div className="welcome-eyebrow"><span className="eyebrow-line" />你的本地代码搭档</div>
          <AgentMark large />
          <h1>今天，我们构建什么？</h1><p className="welcome-description">从一个想法开始。理解代码、解决问题，或者创造点新东西。</p>
          <div className="suggestion-grid">{suggestions.map((suggestion) => <button key={suggestion.title} className="suggestion" onClick={() => chooseSuggestion(suggestion.prompt)}>
            <span className={`suggestion-icon ${suggestion.icon}`}><Icon name={suggestion.icon} size={20} /></span>
            <strong>{suggestion.title}</strong><p>{suggestion.detail}</p><span className="suggestion-arrow">↗</span>
          </button>)}</div>
          <div className="workspace-context"><Icon name="folder" size={14} /><span>工作目录</span><code title={workspace}>{workspaceName(workspace)}</code><span className="context-dot">·</span><span>需要操作时会向你确认</span></div>
        </section> : <section className="message-thread">
          {active?.messages.map((message) => <article className={`message ${message.role}`} key={message.id}>
            <div className="message-avatar">{message.role === 'user' ? <span>你</span> : message.role === 'notice' ? <Icon name="clock" /> : <AgentMark />}</div>
            <div className="message-body"><div className="message-meta"><strong>{message.role === 'user' ? '你' : message.role === 'notice' ? '任务状态' : 'Agent'}</strong>
              <time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
              {message.role === 'user' ? <p className="user-text">{message.content}</p> : <Markdown text={message.content} />}
              {message.role === 'assistant' && <CopyButton text={message.content} />}
            </div>
          </article>)}
          {active?.busy && <article className="message assistant live-message"><div className="message-avatar"><AgentMark /></div>
            <div className="message-body"><div className="message-meta"><strong>Agent</strong><span className="live-label"><span className="spinner" />{active.status}</span></div>
              {active.response ? <Markdown text={active.response} /> : <div className="thinking-dots"><i /><i /><i /></div>}
              {active.tools.length > 0 && <button className="tool-progress" onClick={() => setInspectorOpen(true)}><Icon name="terminal" size={14} />
                {active.tools.filter((tool) => tool.status === 'done').length} 项操作已完成 <Icon name="chevron" size={12} /></button>}
            </div></article>}
          {active?.permission && <PermissionCard permission={active.permission} disabled={pending || !connected}
            onRespond={(approved) => void perform(async () => {
              await api(`/api/sessions/${active.id}/permission`, { id: active.permission!.id, approved });
              setState(await api<WebState>('/api/state'));
            })} />}
        </section>}
      </div>
      <div className="composer-region">
        {actionError && <div className="action-error" role="alert"><span>{actionError}</span><button className="icon-button" onClick={() => setActionError('')} aria-label="关闭错误"><Icon name="close" size={14} /></button></div>}
        <form className={`composer ${active?.busy ? 'busy' : ''}`} onSubmit={(event) => void submit(event)}>
          <textarea ref={composerRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleInputKey}
            placeholder={active?.busy ? '任务进行中，你可以先写下下一步…' : '描述你的任务，或输入 /image 生成图片…'}
            rows={2} maxLength={16384} aria-label="任务输入" />
          <div className="composer-toolbar"><div className="composer-options">
            <button type="button" className="composer-workspace" title={workspace} onClick={() => { setWorkspaceInput(workspace); dialogRef.current?.showModal(); }} disabled={!state || pending}>
              <Icon name="folder" size={15} /><span>{workspaceName(workspace)}</span>
            </button><span className="toolbar-divider" /><span className="model-label" title={state?.model}><Icon name="spark" size={14} />{state?.model ?? '正在加载模型'}</span>
          </div>{active?.busy ? <button type="button" className="send-button stop-button" aria-label="停止任务" disabled={!connected || pending}
            onClick={() => void perform(async () => { await api(`/api/sessions/${active.id}/cancel`, {}); })}><span /></button> :
            <button type="submit" className="send-button" aria-label="发送任务" disabled={!input.trim() || !connected || pending}><Icon name="arrow" size={19} /></button>}</div>
        </form>
        <div className="composer-footer"><span>{active?.busy ? `${active.status} · ${elapsed}s` : <><span className="status-dot" />准备就绪</>}</span>
          <span>Enter 发送 <span className="footer-separator">·</span> Shift + Enter 换行</span></div>
      </div>
    </main>
    {inspectorOpen && <Inspector session={active} onClose={() => setInspectorOpen(false)} />}
    <dialog ref={dialogRef} className="workspace-dialog">
      <form onSubmit={submitWorkspace}><div className="dialog-heading"><span className="empty-icon"><Icon name="folder" /></span>
        <button type="button" className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="关闭"><Icon name="close" /></button></div>
        <h2>打开一个工作区</h2><p>为这个目录创建独立会话。Agent 会先了解项目，再和你一起完成任务。</p>
        <label htmlFor="workspace-path">本地目录路径</label><input id="workspace-path" autoFocus value={workspaceInput} onChange={(event) => setWorkspaceInput(event.target.value)} placeholder="/Users/you/projects/my-project" required />
        {actionError && <p className="dialog-error" role="alert">{actionError}</p>}
        <div className="dialog-actions"><button type="button" className="button secondary" onClick={() => dialogRef.current?.close()}>取消</button>
          <button type="submit" className="button primary" disabled={!workspaceInput.trim() || pending || !connected}>打开工作区 <Icon name="arrow" size={15} /></button></div>
      </form>
    </dialog>
  </div>;
}
