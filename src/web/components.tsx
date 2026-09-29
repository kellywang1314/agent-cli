import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WebPermission, WebTool } from './types.js';

const iconPaths: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  folder: <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3V7Z" />,
  file: <path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 13h8m-8 4h6" />,
  code: <path d="m7 7-5 5 5 5m10-10 5 5-5 5m-4-14-2 18" />,
  terminal: <path d="m4 5 6 7-6 7m9 0h7" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="1" /><path d="m3 17 6-6 4 4 3-3 5 5" /></>,
  trash: <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />,
  search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  refresh: <path d="M20 7A9 9 0 1 0 21 14M20 3v5h-5" />,
  branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 7v10m12-9c0 6-12 3-12 7" /></>,
  spark: <path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z" />,
  shield: <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6" />,
};

/** 用统一线宽绘制轻量界面图标。 */
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name] ?? iconPaths.file}</svg>;
}

/** 展示工作台标识，不依赖远端图片资源。 */
export function AgentMark({ large = false }: { large?: boolean }) {
  return <span className={`agent-mark ${large ? 'large' : ''}`} aria-hidden="true"><Icon name="code" size={large ? 32 : 18} /></span>;
}

/** 将剪贴板操作限制在用户点击中，并反馈失败状态。 */
export function CopyButton({ text }: { text: string }) {
  const [status, setStatus] = useState('');
  /** 复制当前内容，并短暂提示操作结果。 */
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(text); setStatus('已复制'); }
    catch { setStatus('复制失败'); }
    setTimeout(() => setStatus(''), 1800);
  }
  return <button className="icon-button copy-button" onClick={() => void copy()} title={status || '复制内容'} aria-label="复制内容">
    <Icon name={status === '已复制' ? 'check' : 'copy'} size={15} />{status && <span>{status}</span>}
  </button>;
}

/** 安全渲染 Markdown；不执行 HTML，也不自动加载模型返回的远端图片。 */
export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
    img: ({ alt }) => <span className="muted">[图片：{alt || '查看生成结果路径'}]</span>,
  }}>{text}</ReactMarkdown></div>;
}

/** 用行号和增删色标展示完整差异或普通文本。 */
export function CodeView({ text, diff = false }: { text: string; diff?: boolean }) {
  return <div className={`code-view ${diff ? 'diff-view' : ''}`} tabIndex={0}>
    {text.split('\n').map((line, index) => <div key={index} className={
      diff && line.startsWith('+') && !line.startsWith('+++') ? 'line-added' :
        diff && line.startsWith('-') && !line.startsWith('---') ? 'line-removed' :
          diff && line.startsWith('@@') ? 'line-hunk' : ''
    }><span className="line-number">{index + 1}</span><code>{line || ' '}</code></div>)}
  </div>;
}

/** 将 JSON 工具响应转换为更适合阅读的文本。 */
export function toolText(result: unknown): string {
  if (typeof result === 'string') {
    try { return toolText(JSON.parse(result)); } catch { return result; }
  }
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    for (const key of ['error', 'diff', 'content', 'output']) if (typeof record[key] === 'string') return record[key];
  }
  return JSON.stringify(result, null, 2) ?? '';
}

const toolLabels: Record<string, string> = {
  listFiles: '浏览项目文件', readFile: '读取文件', search: '搜索代码',
  applyPatch: '应用代码补丁', runCommand: '执行命令', getDiff: '检查代码变更', generateImage: '生成图片',
};

/** 展示可展开的单次工具结果及执行耗时。 */
export function ToolCard({ tool }: { tool: WebTool }) {
  return <details className={`tool-card ${tool.status}`}>
    <summary>
      <span className={`tool-state ${tool.status}`}>{tool.status === 'running' ? <span className="spinner" /> :
        <Icon name={tool.status === 'error' ? 'close' : 'check'} size={14} />}</span>
      <span>{toolLabels[tool.name] ?? tool.name}</span>
      <span className="tool-duration">{tool.elapsedMs === undefined ? '执行中' : `${(tool.elapsedMs / 1000).toFixed(1)}s`}</span>
      <Icon name="chevron" size={13} />
    </summary>
    <div className="tool-detail"><code>{tool.name}</code>{tool.result ? <pre>{toolText(tool.result)}</pre> : <p>等待执行结果…</p>}</div>
  </details>;
}

/** 展示完整权限预览，默认不批准且按钮关联唯一审批 ID。 */
export function PermissionCard({ permission, disabled, onRespond }: {
  permission: WebPermission;
  disabled: boolean;
  onRespond: (approved: boolean) => void;
}) {
  const diff = permission.detail.includes('@@') || permission.detail.includes('--- ');
  return <section className="permission-card" aria-label="操作确认">
    <div className="permission-heading"><span className="permission-icon"><Icon name="shield" /></span>
      <div><strong>{permission.title}</strong><p>此操作需要你的确认</p></div><span className="waiting-tag">等待确认</span>
    </div>
    <CodeView text={permission.detail} diff={diff} />
    <div className="permission-actions"><span>仅授权本次操作</span>
      <button className="button secondary" disabled={disabled} onClick={() => onRespond(false)}>拒绝</button>
      <button className="button primary" disabled={disabled} onClick={() => onRespond(true)}><Icon name="check" size={15} />允许执行</button>
    </div>
  </section>;
}
