# Agent CLI

参考[《实现一个自己的 Agent cli》](https://juejin.cn/post/7645339907674243082)，用 Node.js、TypeScript、React 实现本地代码 Agent 工作台，并保留 Ink 终端界面。模型通过 OpenAI 兼容协议接入 AIDP。

## 启动

需要 Node.js 22.13+、pnpm 10；`getDiff` 另需 Git。

```bash
cd /Users/bytedance/Documents/trae_projects/agent-cli
pnpm install
cp .env.example .env
```

在本地 `.env` 中填写 `AIDP_API_KEY`，然后启动可视化工作台：

```bash
pnpm dev
# 指定要分析和修改的项目
pnpm dev --workspace /absolute/path/to/project
```

服务仅监听 `127.0.0.1`，启动后会在 macOS 默认浏览器中打开类似 Codex 的本地界面。终端会同时显示带临时访问令牌的完整 URL；浏览器刷新或服务重启后会话仍可恢复。AK 只由本地 Node 服务读取，不发送给页面。

`.env` 从启动时的当前目录读取，`--workspace` 仅指定工具工作区。如果从其他目录启动构建产物，可设置 `DOTENV_CONFIG_PATH=/absolute/path/to/agent-cli/.env`，或直接配置环境变量。使用其他端口或不自动打开浏览器：

```bash
pnpm dev --port 4400
pnpm dev --no-open
```

编译和运行：

```bash
pnpm build
pnpm start --workspace /absolute/path/to/project
node dist/web/main.js --help
```

原终端界面仍可使用：

```bash
pnpm dev:cli
pnpm start:cli
```

包中声明的 `agent-cli` bin 对应终端版；如果希望系统中直接调用，可自行执行 `pnpm link --global`。终端交互需要 TTY，不能直接用管道传入文本。

## 配置

CLI 参数优先于环境变量。

| 环境变量 | CLI 参数 | 默认值 |
| --- | --- | --- |
| `AIDP_API_KEY` | `--api-key` | 必填，推荐 `.env` |
| `AIDP_MODEL` | `--model` | `gpt-5.5-2026-04-24` |
| `AIDP_IMAGE_MODEL` | `--image-model` | 沿用聊天模型 |
| `AIDP_CHAT_URL` | `--chat-url` | 下方聊天地址 |
| `AIDP_IMAGE_URL` | `--image-url` | 下方图片地址 |
| `AGENT_CLI_DB_PATH` | `--database-path` | macOS 应用支持目录中的 `agent.db` |
| `REDIS_URL` | `--redis-url` | 空，表示禁用 Redis；CLI 仅允许无认证地址 |
| `REDIS_CACHE_TTL_SECONDS` | `--redis-cache-ttl` | 300 秒，范围 1–86400 |
| — | `--workspace` | 当前目录 |
| — | `--max-rounds` | 20，范围 1–100 |

```text
聊天：https://aidp.bytedance.net/api/modelhub/online/v2/crawl
图片：https://aidp.bytedance.net/api/modelhub/online/v2/crawl/openai/images/generations
```

**聊天地址是完整端点，不要追加 `/openai/chat/completions`，该路径会返回 404。** URL 配置中不要包含 `ak`；程序发请求时自动注入。端点依据 [ModelHub 接入示例](https://bytedance.larkoffice.com/docx/ETX2dNa4lokExhxMjQIcurlOnIc)，已于 2026-09-29 使用 `gpt-5.5-2026-04-24` 验证 SSE 聊天、`tools` / `tool_calls` 和工具结果回传。不支持 Responses 协议或网关自定义包装。

**图片生成能力也需联调确认。** 默认模型名称按用户指定配置，不代表该模型必然支持图片接口。若网关要求专门的图片模型，请设置 `AIDP_IMAGE_MODEL`。图片解析支持标准 `data[0].url` / `data[0].b64_json`，仅接收 PNG/JPEG/WebP，最大 20 MiB。默认文件名为 `.png`，指定其他输出格式时请同时指定对应扩展名；程序保存原始图片字节，不转码。

## 本地数据

会话和已确认项目记忆默认保存在：

`~/Library/Application Support/agent-cli/agent.db`

可通过 `AGENT_CLI_DB_PATH` 或 `--database-path` 覆盖。数据库可能包含脱敏后的对话和代码片段，不要上传或提交该文件。删除会话不会删除已确认的项目记忆。

## Redis 可选加速层

Redis 只缓存模型注入所需的 active 项目记忆，SQLite 始终是唯一持久化真相源。未配置
`REDIS_URL`、首次连接失败或运行中断开时，应用会 fail-open 回源 SQLite，会话和记忆
管理仍可使用。

读取采用 Cache-Aside：

1. 先按工作区哈希查询 Redis；命中时直接使用缓存。
2. 未命中时读取 SQLite，并使用 `SET EX` 回填带 TTL 的缓存。
3. 接受、编辑、启停或删除记忆时，先提交 SQLite，再删除缓存 Key。
4. TTL 是失效删除失败后的最终恢复边界；默认 300 秒。

记忆变化还会发布不含正文和工作区路径的 Pub/Sub 事件，让其他工作台进程主动刷新。
Pub/Sub 消息是瞬时通知，离线订阅者不会补收，因此它不是持久消息队列。

macOS 可执行以下实验：

```bash
brew install redis
brew services start redis
redis-cli ping

# 在 .env 配置 REDIS_URL 后启动并触发一次记忆注入
pnpm dev --no-open

# 在另一个终端观察 Key 和剩余 TTL
redis-cli --scan --pattern 'agent-cli:v1:*'
redis-cli TTL '<key>'

# 停止 Redis 后继续使用应用，读取会自动回源 SQLite
brew services stop redis
```

远程 Redis 应使用 `rediss://`、认证和最小权限账户。认证 URL 必须通过 `REDIS_URL`
环境变量配置，不要放入 `--redis-url`，避免泄漏到 Shell 历史或进程列表。Redis 不是秘密
存储，不应缓存 API Key、完整提示词、工具输出或未确认的记忆。

## 交互

可视化界面包含左侧持久会话列表、中间流式对话和右侧工作区面板。右侧可查看工具过程、浏览普通文本文件、检查未暂存 Git diff，以及确认和管理当前工作区的项目记忆。每个会话拥有独立模型历史，刷新页面或服务重启后可以继续。

发送使用 Enter，换行使用 Shift+Enter。任务运行时发送按钮变为停止按钮。写文件、运行命令和图片生成会在对话区展示完整确认卡片，审批 ID 过期后无法误操作后续任务。

```text
❯ 列出项目结构，阅读 README，总结代码入口
❯ 修复 src/example.ts 中的问题，先读文件，展示补丁，再执行测试
❯ /image 一只坐在木桌上的橘猫，暖色自然光，真实摄影
```

| 命令 | 行为 |
| --- | --- |
| `/help` | 显示帮助 |
| `/new`、`/clear` | 新建会话，保留项目记忆 |
| `/sessions` | 列出当前工作区的终端会话 |
| `/resume <id>` | 使用完整 ID 或唯一八位前缀恢复会话 |
| `/delete-session <id>` | 删除会话，但保留已确认的项目记忆 |
| `/memory` | 查看、编辑、停用、恢复或删除项目记忆 |
| `/exit` | 退出 |
| `/image <提示词>` | 直接请求生成并保存图片 |
| `Ctrl+C` | 中断当前任务；再次按下退出。空闲时退出 |

自然语言也能触发图片工具，并指定 `outputPath`、`model`、`size`。图片保存到工作区下的 `generated/`，或用户指定的相对路径。

可视化界面使用“允许执行”或“拒绝”处理确认。终端版按 `y` 允许，`n`、回车或 Esc 拒绝；长内容按终端尺寸分页，用左右方向键或 PgUp/PgDn 查阅。确认图片前会展示提示词和路径；拒绝时不会发图片请求或创建文件。

## 工具

| 工具 | 参数示例 | 行为 |
| --- | --- | --- |
| `listFiles` | `{"path":".","maxEntries":500}` | 有界递归列出目录和文件 |
| `readFile` | `{"path":"src/main.tsx","maxBytes":65536}` | 读取 UTF-8 文本，最大 64 KiB |
| `search` | `{"query":"handleSubmit","path":"src","maxResults":100}` | 按行搜索字面量 |
| `applyPatch` | `{"patch":"--- a/file\n+++ b/file\n@@ ...\n..."}` | 单文件 unified diff 增删改 |
| `runCommand` | `{"command":"pnpm test","timeoutMs":30000}` | 确认后执行 Shell，最长 60 秒 |
| `getDiff` | `{}` | 当前工作区内的 Git 未暂存差异 |
| `generateImage` | `{"prompt":"一只小猫","outputPath":"generated/cat.png"}` | 确认后调用图片接口并保存 |

补丁不支持重命名、多文件补丁、二进制或模式变更。多文件修改需分别确认；新增/删除使用 `/dev/null`。授权等待期间文件变化会拒绝应用，模型需重新读文件。

自动目录遍历、搜索和 `readFile` 均拒绝 `.git`、`node_modules`、`.env*` 与符号链接；其他显式文件读取限制在工作区内普通文本。搜索有访问文件数、总读取字节数和输出数量上限，结果用 `truncated` 标记截断。`getDiff` 不显示未跟踪文件和已暂存改动。

## 权限和运行边界

文件工具会检查路径和现存父目录真实位置，拒绝目录穿越、符号链接越界和 `.git` 访问；写入前会再次校验。密钥不写入源码或日志，终端错误及回传模型的工具结果会脱敏，子进程不继承 `AIDP*` / `OPENAI*` / `REDIS*` 环境变量。

SQLite 数据库未做全库加密，仅依赖本机用户权限保护；数据库文件默认设为 `0600`，自动创建的数据目录设为 `0700`。**Shell 不是操作系统沙箱。** 确认的命令以当前系统用户身份运行，即使 cwd 在工作区，也能访问工作区外文件、网络及本地 `.env`。只确认你理解的命令。文件工具的校验也无法完全消除恶意进程同时替换父目录的竞争条件，勿把它作为隔离不可信系统用户的安全边界。

命令输出最多保留 64 KiB；超时和取消会终止进程组。非零退出码作为观察结果交给模型。聊天请求超时 120 秒，连接与部分 HTTP 错误由 SDK 最多重试两次；已开始的流不重放。图片生成不自动重试，避免重复计费。

## 源码入口

```text
src/main.tsx                  参数解析、项目上下文、Ink 启动
src/config/loadConfig.ts      配置校验与输出脱敏
src/providers/AidpProvider.ts  AIDP 聊天流和图片解析
src/agent/AgentLoop.ts         历史、工具循环、取消、循环限制
src/context/projectContext.ts 有限读取 README.md / AGENTS.md
src/cache/                    可选 Redis 缓存、Key 与失效事件
src/persistence/              SQLite Schema、会话与记忆持久化
src/memory/                   记忆提取、确认、校验与动态注入
src/sessions/                 Web/CLI 共享会话生命周期
src/prompts/systemPrompt.ts    模型工作规则
src/tools/ToolRegistry.ts      JSON Schema 与 Zod 校验
src/tools/builtin/             七个工具
src/tools/services/            有界文件操作和进程执行
src/security/                 路径校验、逐次权限确认
src/ui/App.tsx                终端交互与任务状态
src/ui/PermissionPrompt.tsx   可翻页的完整操作预览
src/web/main.ts               本地可视化服务入口
src/web/server.ts             HTTP/SSE、鉴权与静态资源
src/web/sessions.ts           浏览器会话、Agent 与审批桥接
src/web/Workbench.tsx         三栏工作台主界面
```

每个用户任务依次执行“模型决策 → 工具确认与执行 → 结果回传 → 模型继续”。工具失败进入历史作为观察结果；取消时给剩余工具补齐取消结果，避免下一次请求出现未配对的 `tool_call_id`。

当前不包含 MCP、子 Agent 或上下文压缩。长会话可通过 `/new` 或 `/clear` 重新开始；连续三次同参数工具调用会触发停止保护。

## 验证与联调

```bash
pnpm typecheck
pnpm test
pnpm build
```

自动测试使用临时工作区、本地 HTTP 模型网关和 Ink 输入事件，不请求真实 AIDP。覆盖文件越界、权限允许/拒绝、补丁过期、命令取消/超时/截断、流式参数组装、图片格式、消息配对、循环限制、终端交互，以及工作台鉴权、会话隔离、审批过期、重启恢复、持久化脱敏和记忆确认。

默认测试不依赖 Redis。已启动本地 Redis 时，可额外运行真实缓存与 Pub/Sub 集成测试：

```bash
TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm vitest run tests/redis.integration.test.ts
```

真实接口联调：

1. 配置 `.env` 并启动 CLI，输入“只回复 OK”验证聊天地址和模型。
2. 输入“记住：这个项目使用 pnpm”，只在确认候选后检查 `/memory`。
3. 退出并重新启动，确认会话和记忆恢复；新建会话询问包管理器，确认已确认记忆被注入。
4. 输入“读取 README.md 并概括”，确认网关支持工具调用。
5. 在临时样例项目中要求修改一个文件，先拒绝，再允许；检查真实差异。
6. 运行 `/image <提示词>`，确认后检查返回路径和图片。
7. 若 HTTP 404，检查 `.env` 或 `--chat-url` 是否仍配置了旧的 `/v2/crawl/openai/chat/completions`，改为上方完整聊天端点并重启；若 401/403，检查密钥与权限；若模型不支持图片，配置图片专用模型。

设计与计划位于 `docs/superpowers/`。测试通过不能替代真实网关联调。
