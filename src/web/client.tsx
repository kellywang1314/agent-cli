import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Workbench } from './Workbench.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('页面缺少根节点');

/** 挂载本地 Agent 可视化工作台。 */
function renderWorkbench(): void {
  createRoot(root!).render(<StrictMode><Workbench /></StrictMode>);
}

renderWorkbench();
