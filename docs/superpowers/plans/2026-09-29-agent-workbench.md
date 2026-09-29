# Agent Workbench Implementation Plan

**Goal:** 交付可运行、接通本地工具的 Codex 风格工作台。
**Architecture:** React 页面通过令牌鉴权的 HTTP/SSE 与本地 Node 服务通信；每个会话复用独立 AgentLoop 与 PermissionGate。
**Tech Stack:** TypeScript、React 19、React DOM、Node HTTP、esbuild、Vitest。

1. 新增 `src/web/types.ts`：定义快照、消息、工具状态、会话与审批 ID。
2. 新增 `src/web/sessions.ts`：管理会话生命周期、脱敏、工具事件、审批、中断。新会话读取所选工作区 README/AGENTS；不向前端暴露 provider/config。
3. 新增 `src/web/server.ts`：严格 Host/Origin/令牌校验、JSON 请求体 64 KiB 上限、SSE 快照、只读工具白名单、固定静态资源映射。JSON 输入使用 Zod。
4. 新增 `src/web/main.ts`：加载 `.env`、解析工作区/端口、绑定 loopback、打开浏览器、退出时取消任务。保留旧 CLI 入口。
5. 新增 `src/web/client.tsx`、`src/web/Workbench.tsx`、`src/web/styles.css`、`src/web/index.html`：会话栏、Markdown、任务建议、工具面板、文件读取与 diff、审批、快捷键、移动端布局；React 自动转义所有模型和文件内容。
6. 修改 `package.json` 启动与构建脚本；新增 `scripts/buildWeb.mjs` 打包前端；`README.md` 说明图形入口、会话内存范围与本地访问方式。
7. `tests/web.test.ts` 使用假模型和临时工作区验证 HTTP 服务、隔离、授权、取消；不消耗线上模型。
8. 执行 `pnpm typecheck`、`pnpm test`、`pnpm build`；启动服务做浏览器交互检查；最后用实际 AIDP 做只读验证。

实施授权来自用户“可视化界面，类似 codex”和“重试”。在当前未提交的新项目中实现，不创建会遗漏当前文件的工作树，不代替用户提交或发布。
