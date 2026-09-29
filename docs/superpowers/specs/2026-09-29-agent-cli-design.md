# Agent CLI 设计规格

用户已批准：Node.js + TypeScript ESM + Ink/React + OpenAI SDK + Zod + yargs + Vitest，使用 pnpm。代码 Agent 与图片生成同时提供，文件写入和 Shell 命令逐次确认。

## 功能

- 持续对话、流式文本、工具状态、耗时、权限预览。
- `listFiles`、`readFile`、`search`、`applyPatch`、`runCommand`、`getDiff`、`generateImage`。
- `/help`、`/clear`、`/exit`、`/image <prompt>`；Ctrl+C 中断任务，再按退出。
- Agent 消息循环支持轮次上限、重复调用检测、失败观察、任务取消。
- 项目上下文读取根目录 README.md 和 AGENTS.md，内容有上限。
- 不实现 MCP、子 Agent、会话持久化、上下文压缩、自动批准模式。

## 分层

`config` 校验配置；`providers` 封装聊天与图片接口；`agent` 编排消息；
`security` 校验路径与权限；`tools` 负责工具注册及执行；
`ui` 呈现 Ink 界面；`prompts` 定义系统行为；`context` 收集项目说明。

## 接口

默认模型 `gpt-5.5-2026-04-24`。
默认聊天 URL 为已验证地址 `https://aidp.bytedance.net/api/modelhub/online/v2/crawl`。
图片 URL 为 `https://aidp.bytedance.net/api/modelhub/online/v2/crawl/openai/images/generations`。
聊天使用 OpenAI Chat Completions 流式工具协议，图片支持 `data[].url` 和 `data[].b64_json`。
图片模型可独立配置，默认沿用聊天模型；聊天 SSE 与工具调用已完成真实网关联调，图片能力仍需按模型权限验证。

环境变量 `AIDP_API_KEY`、`AIDP_CHAT_URL`、`AIDP_IMAGE_URL`、`AIDP_MODEL`、
`AIDP_IMAGE_MODEL`；CLI 参数覆盖环境变量。AK 在请求时注入查询参数，不落盘、不记录日志。

## 安全与错误处理

- 文件路径校验真实路径与现存父目录，拒绝目录穿越及符号链接越界，保护 `.git`。
- 修改前展示完整补丁，执行前再次校验原文件，拒绝过期预览。
- 命令展示完整文本、设置 cwd、超时、输出上限，并清除子进程中的模型凭据。
- Shell 不是操作系统沙箱；经用户确认的任意命令能访问当前用户有权限的系统资源。
- 图片生成先确认提示词与目标路径，再请求模型和保存文件，拒绝不产生调用或写入。
- 网络错误有限重试；流中断不重复已展示文本，图片生成不自动重试避免重复计费。
- 取消、协议错误、工具错误不破坏下一轮消息协议；输出做凭据脱敏。
- 函数、变量采用驼峰命名，类和类型按 TypeScript 惯例使用 PascalCase；函数级注释。

## 验证

Vitest 使用临时目录和本地 HTTP 服务，覆盖多轮工具调用、分片流解析、图片两种格式、
权限拒绝、越界与符号链接、过期补丁、命令超时/截断、取消、轮次限制。
执行 typecheck、test、build，终端验证帮助及 Ink 输入/退出。
测试不访问真实 AIDP；README 给出真实接口联调步骤和已知限制。
