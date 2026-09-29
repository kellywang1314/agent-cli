# Agent 长期记忆与会话持久化设计

## 背景

当前 `AgentLoop.messages` 和 Web `SessionStore.records` 都只保存在进程内存中。页面刷新可以通过仍在运行的本地服务恢复状态，但 Node 进程退出后，会话、模型上下文和任务记录都会丢失。CLI 退出后同样无法继续原会话，也不存在跨会话共享的项目知识。

本设计为 Web 工作台和终端 CLI 增加统一的本地持久化能力，并在用户确认后沉淀当前工作区的长期记忆。

## 目标

- 使用本地 SQLite 持久化 Web 与 CLI 会话。
- 服务或 CLI 重启后恢复用户可见消息和模型原始上下文。
- 每次普通任务成功完成后提取项目记忆候选项。
- 候选项必须由用户逐条接受、编辑后接受或忽略。
- 正式记忆按工作区真实路径隔离，并注入该工作区后续会话。
- 会话一直保留，只有用户主动删除或清理时才移除。
- Web 和 CLI 共享存储、提取、确认、去重和注入逻辑。
- 保持现有工具逐次授权、工作区隔离和密钥脱敏边界。

## 非目标

- 不实现云同步、多用户共享或跨设备同步。
- 不实现向量数据库、语义检索或自动合并冲突记忆。
- 不自动保存未经用户确认的项目记忆。
- 不持久化运行中的 `AbortController`、权限等待状态或 Shell 进程。
- 不加密整个 SQLite 数据库。数据库目录依赖当前 macOS 用户权限保护。
- 不把记忆写入工作区 Markdown 文件，不产生 Git 变更。

## 已确认的产品决策

- 采用综合方案，同时实现会话恢复和项目级长期记忆。
- 使用规范化 SQLite 表，而不是整会话 JSON 快照。
- 记忆仅作用于当前工作区，不提供全局用户记忆。
- 每次普通任务成功完成后自动提取候选项。
- 用户可以逐条接受、编辑后接受或忽略候选项。
- 会话不自动过期，也不按数量自动淘汰。
- 已接受的项目记忆不随来源会话删除。

## 总体架构

### PersistenceStore

`PersistenceStore` 是唯一直接访问 SQLite 的模块，负责：

- 打开数据库和设置文件权限。
- 执行 Schema 迁移。
- 管理事务、外键、WAL 和查询。
- 持久化会话、显示消息、模型消息、候选记忆和正式记忆。
- 按工作区、客户端类型和会话 ID 查询数据。

上层模块不得直接拼接 SQL。测试可注入临时数据库路径。

### SessionService

现有 Web `SessionStore` 中的持久化职责下沉到共享的 `SessionService`：

- 创建、恢复、切换和删除会话。
- 将数据库记录转换为运行时 `AgentLoop`、`PermissionGate` 和 UI 状态。
- 在调用模型前持久化用户消息。
- 监听模型消息追加并立即持久化。
- 修复进程异常退出留下的未配对工具消息。

Web `SessionStore` 继续负责 SSE 状态和 Web 操作编排，CLI 使用同一个 `SessionService`。运行时对象仍只存在于内存中。

### AgentLoop

`AgentLoop` 保持与数据库实现解耦，但增加两个能力：

- 接收恢复后的历史模型消息。
- 在每次追加用户、助手或工具消息时，通过回调通知持久化层。

基础系统提示词和项目记忆不写入 `agentMessages`。每次模型请求时动态组合：

1. 当前版本的基础系统提示词。
2. 当前工作区已确认的有效记忆。
3. 持久化的会话模型消息。

这样可以让新确认、编辑或停用的记忆立即生效，也避免恢复时重复注入旧版记忆。

### MemoryService

`MemoryService` 负责：

- 查询当前工作区的有效记忆。
- 构造有界的记忆系统上下文。
- 在任务完成后调用模型提取候选项。
- 校验、脱敏和去重提取结果。
- 接受、编辑、忽略、停用、恢复或删除记忆。

未确认候选项绝不参与模型推理。

## SQLite 与文件位置

使用 Node 内置 `node:sqlite`，避免引入需要本地编译的 SQLite 扩展。项目 Node 版本要求调整为 `>=22.13.0`。

macOS 默认数据库路径：

```text
~/Library/Application Support/agent-cli/agent.db
```

支持通过配置覆盖数据库路径，测试必须使用临时目录。仅当数据库父目录由本次初始化新建时将其权限设为 `0700`；已有父目录权限保持不变。数据库及 WAL 相关文件限制为当前用户可读写。

数据库初始化设置：

- `PRAGMA journal_mode = WAL`
- `PRAGMA foreign_keys = ON`
- `PRAGMA busy_timeout = 5000`
- 使用 `PRAGMA user_version` 管理顺序迁移

数据库无法打开或迁移失败时终止启动，并显示脱敏后的数据库路径。系统不得静默退回内存模式。

## 数据模型

### sessions

保存会话元数据：

- `id`
- `clientType`：`web` 或 `cli`
- `workspace`：经过 `realpath` 解析的规范路径
- `title`
- `status`：`idle`、`running`、`interrupted` 或 `failed`
- `turns`
- `memoryExtractionStatus`：`idle`、`running`、`failed` 或 `complete`
- `memoryExtractionError`
- `createdAt`
- `updatedAt`

启动时所有 `running` 会话统一转换为 `interrupted`，所有 `memoryExtractionStatus = running` 的记录转换为 `failed` 并允许用户重试。`busy`、权限请求和控制器只属于运行时状态，不直接恢复。

### displayMessages

保存用户可见消息：

- `id`
- `sessionId`
- `sequence`
- `role`：`user`、`assistant` 或 `notice`
- `content`
- `createdAt`

`sessionId + sequence` 唯一，删除会话时级联删除。

### agentMessages

保存 OpenAI 兼容的原始模型上下文：

- `id`
- `sessionId`
- `sequence`
- `payloadJson`
- `createdAt`

每条 `payloadJson` 必须在写入和读取时通过消息 Schema 校验。表中不保存系统提示词。助手工具调用消息和对应工具结果按顺序独立保存。

### memoryCandidates

保存提取结果及其处理状态：

- `id`
- `workspace`
- `sourceSessionId`
- `sourceTurn`
- `category`
- `content`
- `normalizedContent`
- `status`：`pending`、`accepted` 或 `ignored`
- `acceptedMemoryId`
- `createdAt`
- `resolvedAt`

删除来源会话时，未确认候选项级联删除；已处理候选项可以删除，其对应正式记忆继续保留。

### memories

保存已确认的工作区记忆：

- `id`
- `workspace`
- `category`
- `content`
- `normalizedContent`
- `active`
- `sourceSessionId`
- `createdAt`
- `updatedAt`

`workspace + normalizedContent` 唯一。来源会话删除后，`sourceSessionId` 置空，不删除正式记忆。

首期类别限定为：

- `rule`：必须持续遵守的项目规则。
- `decision`：架构或实现决策及其约束。
- `fact`：稳定的项目事实。
- `preference`：仅适用于当前工作区的用户偏好。

不保存临时任务进度、命令输出、一次性错误、大段源码或未经验证的猜测。

## 会话生命周期

### 创建与提交

1. 创建会话时先写入 `sessions`。
2. 用户提交任务时，在事务中写入显示消息、模型用户消息并更新会话状态。
3. 事务成功后才允许调用模型。
4. `AgentLoop` 追加助手工具调用、工具结果或最终回复时，立即通知 `SessionService` 写入。
5. 最终显示消息和会话状态在事务中提交。

工具调用声明必须在工具执行前落库。每条工具结果在执行后立即落库。如果结果写入失败，停止后续 Agent 轮次并向用户报告持久化错误。

### 恢复

- Web 启动只读取轻量会话摘要，具体消息在会话被选中时按需加载。
- CLI 启动自动恢复当前工作区最近一次 CLI 会话。
- CLI 增加 `/sessions`、`/resume <id>` 和 `/new`；现有 `/clear` 作为 `/new` 的兼容别名，旧会话仍保留。
- 恢复时重新创建 `AgentLoop` 和 `PermissionGate`，不恢复执行中的任务或审批。
- 如果最后一条助手消息声明了工具调用但缺少对应工具结果，则为缺失项补充“服务中断，工具结果未知”的工具消息。
- 恢复后的 `running` 会话增加一条可见通知，并标记为 `interrupted`。

### 删除

- 删除忙碌会话前仍要求先中断。
- 删除会话级联删除显示消息、模型消息和未确认候选项。
- 已接受记忆保留，来源会话引用置空。

## 会话列表扩展

由于会话不会自动淘汰，Web 不再把全部历史消息放进全量 `WebState`：

- 会话列表只返回 ID、标题、工作区、状态和时间等摘要。
- 选中会话后通过单独接口加载完整显示消息。
- SSE 继续推送运行中会话的增量状态。
- 首期可以返回全部摘要；消息和模型上下文始终按需加载，不在启动时全部驻留内存。

这保证长期保留不会让启动时间和 SSE 快照随历史消息总量线性膨胀。

## 记忆提取生命周期

### 触发条件

- 只在普通 Agent 任务成功完成后触发。
- `/image`、失败、取消和只有状态通知的任务不触发。
- 提取在主任务完成后后台执行，失败不改变任务成功状态。
- 每次只分析本轮用户消息、最终回复和必要的工具结果摘要，不重复发送完整会话。

### 模型输出

提取请求不提供工具，只允许返回 JSON：

```json
{
  "candidates": [
    {
      "category": "decision",
      "content": "项目使用 React 19 和原生 CSS，不引入 UI 组件库。"
    }
  ]
}
```

响应必须完整通过 `JSON.parse` 和 Zod Schema 校验，不使用正则截取或宽松修复。单轮最多接受 5 条候选，每条内容最多 1000 个字符。格式错误时记录为可重试状态，不创建部分候选。

提取提示词包含当前有效记忆摘要，要求模型跳过重复、临时、敏感或无法验证的信息。服务端使用 Unicode NFKC、去除首尾空白、合并连续空白并对 ASCII 字符转小写后生成 `normalizedContent`，再执行精确去重。

### 确认与注入

- `pending` 候选支持接受、编辑后接受和忽略。
- 接受操作在单个事务中创建或更新正式记忆，并将候选标记为 `accepted`。
- 编辑后必须重新执行长度、敏感信息和重复校验。
- 忽略后候选不再提示，也不参与后续提取。
- 每次模型请求最多注入 50 条有效记忆，总文本不超过 12 KiB。
- 超限时按 `updatedAt` 从新到旧选择，保持确定性顺序。
- 记忆以“用户确认的项目记忆”独立系统消息注入，并明确其不能覆盖工具授权、安全边界或当前用户指令。

## Web 交互

工作区检查面板新增“记忆”标签：

- 顶部显示候选数量和提取状态。
- 待确认区域逐条展示类别与内容。
- 每条候选提供接受、编辑和忽略操作。
- 正式记忆按类别分组，支持编辑、停用、恢复和删除。
- 所有写操作复用现有本地令牌、Host 和 Origin 校验。
- 提取失败显示非阻塞错误和重试入口。

会话完成后，聊天区域只显示简短的候选数量提示，引导用户打开记忆面板，不在消息列表中插入大型嵌套卡片。

建议的会话级接口：

- `GET /api/sessions/:sessionId`
- `GET /api/sessions/:sessionId/memories`
- `POST /api/sessions/:sessionId/memory-extraction/retry`
- `PATCH /api/sessions/:sessionId/memory-candidates/:candidateId`
- `PATCH /api/sessions/:sessionId/memories/:memoryId`
- `DELETE /api/sessions/:sessionId/memories/:memoryId`

服务端必须验证候选或记忆的工作区与目标会话一致。

## CLI 交互

- 启动时显示恢复的会话标题和最近更新时间。
- 任务完成并提取到候选后，进入逐条确认状态。
- 每条候选可接受、编辑或忽略，行为与 Web 完全一致。
- `/memory` 查看当前工作区正式记忆并进入管理操作。
- `/sessions` 列出当前工作区最近的 CLI 会话。
- `/resume <id>` 恢复指定空闲 CLI 会话。
- `/delete-session <id>` 删除指定空闲 CLI 会话。
- `/new` 创建新会话；`/clear` 保留为兼容别名。

CLI 只负责展示和输入，所有状态转换调用共享 `SessionService` 与 `MemoryService`。

## 数据安全

- 用户消息、模型消息和工具结果写入前执行现有已知密钥、Bearer token 和 URL 鉴权参数脱敏。
- 当前运行可以短暂使用原始用户输入；重启后只恢复已脱敏版本。
- 候选记忆除脱敏外，还拒绝 PEM 私钥、常见访问令牌格式和明显高熵凭据。
- `.env`、Git 元数据和依赖目录的读取限制保持不变。
- 数据库可能包含代码片段和对话内容，界面与文档必须明确其本地路径。
- 全库加密、系统钥匙串和导入导出不在首期范围内。

## 错误处理

- 数据库打开、迁移或完整性检查失败：终止启动，不进入降级模式。
- 用户消息事务失败：不调用模型，允许用户重试。
- 模型消息持久化失败：停止后续 Agent 轮次，保留明确错误通知。
- 任务成功但记忆提取失败：任务保持成功，记忆状态标记为可重试。
- 候选确认冲突或已处理：返回冲突错误，不重复创建记忆。
- 会话切换期间的旧请求：沿用请求版本隔离，防止覆盖当前视图。
- 服务退出：先取消任务和记忆提取，等待工具及后台任务清理，再关闭数据库。

## 测试策略

### PersistenceStore

- 使用临时目录测试首次建库和连续版本迁移。
- 验证事务回滚、外键、唯一约束和级联行为。
- 验证不同工作区和不同客户端类型的数据隔离。
- 验证数据库打开失败和损坏数据处理。

### SessionService 与 AgentLoop

- 重启后恢复显示消息和模型消息。
- 恢复时使用当前系统提示词和当前有效记忆。
- 修复未配对工具调用，并保持 OpenAI 消息序列合法。
- 用户消息写入失败时不调用模型。
- 工具结果写入失败时不继续下一轮。
- `/new`、`/clear` 和 `/resume` 不误删旧会话。

### MemoryService

- 成功提取四类候选并限制数量和长度。
- 拒绝非法 JSON、未知类别、敏感内容和重复内容。
- 验证接受、编辑后接受、忽略、停用、恢复和删除。
- 验证未确认候选不注入。
- 验证 50 条和 12 KiB 注入上限。
- 验证提取失败不改变主任务结果。

### Web 与 CLI

- HTTP 集成测试启动服务、创建会话、完成任务、关闭并使用同一数据库重启。
- 验证会话摘要和详情按需加载。
- 验证记忆接口鉴权、工作区校验和过期操作。
- Ink 测试覆盖会话恢复、候选确认和记忆命令。
- 浏览器测试覆盖记忆面板、编辑状态、错误状态和移动端布局。

### 回归验证

- 运行全部 Vitest 测试。
- 运行 TypeScript 类型检查。
- 运行 Web 和 CLI 生产构建。
- 使用本地假模型执行确定性的持久化集成测试。
- 使用真实 AIDP 配置执行一次只读聊天和候选提取联调。

## 实施边界

实现应保持最小范围：

- 不重写现有工具或权限系统。
- 不引入 UI 组件库或全栈框架。
- 函数名和变量名使用 camelCase。
- 新增或修改的非平凡函数提供简洁的函数级注释。
- 优先拆分持久化和记忆服务，避免继续扩大现有 `sessions.ts` 和 `App.tsx` 的职责。
