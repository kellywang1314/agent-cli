import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { CodeView, CopyButton, Icon, ToolCard, toolText } from './components.js';
import { MemoryPanel } from './MemoryPanel.js';
import type { WebSession } from './types.js';

/** 提供工具活动、文件、Git 差异和长期记忆面板。 */
export function Inspector({ session, onClose }: { session?: WebSession; onClose: () => void }) {
  const [tab, setTab] = useState<'activity' | 'files' | 'diff' | 'memory'>('activity');
  const [files, setFiles] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedFile, setSelectedFile] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const requestVersion = useRef(0);

  /** 读取当前面板内容，以版本号隔离切换会话后的旧请求。 */
  async function inspect(kind: 'files' | 'file' | 'diff', filePath?: string): Promise<void> {
    if (!session) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError('');
    setTruncated(false);
    try {
      const result = await api<Record<string, unknown>>(`/api/sessions/${session.id}/inspect`, { kind, path: filePath });
      if (version !== requestVersion.current) return;
      if (typeof result.error === 'string') throw new Error(result.error);
      if (kind === 'files') setFiles((result.files as string[] ?? []).sort());
      else setContent(toolText(result));
      setTruncated(result.truncated === true);
    } catch (failure) {
      if (version === requestVersion.current) setError(failure instanceof Error ? failure.message : '读取失败');
    } finally { if (version === requestVersion.current) setLoading(false); }
  }

  useEffect(() => {
    requestVersion.current++;
    setSelectedFile('');
    setContent('');
    setFiles([]);
    setError('');
    setTruncated(false);
    setLoading(false);
    if (tab === 'files' || tab === 'diff') void inspect(tab);
    return () => { requestVersion.current++; };
  }, [session?.id, tab]);

  const visibleFiles = files.filter((file) => file.toLowerCase().includes(filter.toLowerCase()));
  return <aside className="inspector">
    <div className="inspector-heading"><span><Icon name="panel" size={16} />工作区</span>
      <button className="icon-button" onClick={onClose} title="关闭工作区面板" aria-label="关闭工作区面板"><Icon name="close" size={16} /></button>
    </div>
    <div className="inspector-tabs" role="tablist" aria-label="工作区面板">
      {([['activity', '活动'], ['files', '文件'], ['diff', '变更'], ['memory', '记忆']] as const).map(([value, label]) =>
        <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}
          {value === 'activity' && Boolean(session?.tools.length) && <span>{session?.tools.length}</span>}
          {value === 'memory' && Boolean(session?.pendingMemoryCount) && <span>{session?.pendingMemoryCount}</span>}
        </button>)}
    </div>
    {tab === 'activity' ? <div className="inspector-body">
      {session?.tools.length ? <><div className="section-caption">当前任务 · {session.tools.length} 次操作</div>
        {session.tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}</> :
        <div className="panel-empty"><span className="empty-icon"><Icon name="terminal" size={22} /></span>
          <strong>每一步，都看得见</strong><p>读取文件、执行命令和修改代码的过程会显示在这里。</p>
          <div className="capability-list"><span><Icon name="search" size={15} />理解你的代码库</span>
            <span><Icon name="code" size={15} />预览与应用修改</span><span><Icon name="shield" size={15} />重要操作由你确认</span></div>
        </div>}
    </div> : tab === 'memory' ? <MemoryPanel
      key={`${session?.id ?? ''}:${session?.memoryExtractionStatus ?? 'idle'}`}
      sessionId={session?.id}
    /> : <>
      <div className="file-toolbar">
        {tab === 'files' && selectedFile ? <button className="text-button" onClick={() => { setSelectedFile(''); void inspect('files'); }}>← 文件列表</button> :
          <span>{tab === 'files' ? `${files.length} 个路径` : '未暂存的 Git 差异'}</span>}
        <button className="icon-button" title="刷新" aria-label="刷新面板" disabled={!session || loading}
          onClick={() => void inspect(tab === 'files' && selectedFile ? 'file' : tab, selectedFile || undefined)}><Icon name="refresh" size={15} /></button>
      </div>
      {error && <div className="panel-error" role="alert">{error}</div>}
      {!session ? <div className="panel-empty"><p>开始一个任务后，即可浏览工作区。</p></div> :
        loading ? <div className="loading"><span className="spinner" />正在读取…</div> :
          tab === 'files' && !selectedFile ? <>
            <div className="file-search"><Icon name="search" size={15} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选文件…" aria-label="筛选文件" /></div>
            <div className="file-list">{visibleFiles.map((file) => {
              const directory = files.some((other) => other.startsWith(`${file}/`));
              return <button key={file} title={file} disabled={directory}
                onClick={() => { setSelectedFile(file); void inspect('file', file); }}>
                <Icon name={directory ? 'folder' : 'file'} size={15} /><span>{file}</span>
              </button>;
            })}{!visibleFiles.length && <p className="muted">没有匹配的文件</p>}</div>
          </> : <div className="file-preview">
            {selectedFile && <div className="file-name"><span>{selectedFile}</span><CopyButton text={content} /></div>}
            {content ? <CodeView text={content} diff={tab === 'diff'} /> : !error && <div className="panel-empty"><Icon name="check" size={24} /><strong>没有未暂存变更</strong><p>新增且未跟踪的文件不包含在 Git diff 中。</p></div>}
          </div>}
      {truncated && <div className="truncation-note">内容已达显示上限，请缩小读取范围。</div>}
    </>}
    <div className="inspector-footer"><span className="status-dot" />本地工作区 · 逐次授权</div>
  </aside>;
}
