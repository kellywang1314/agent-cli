# Agent CLI Redis 可选加速层设计

## 背景

Agent CLI 当前使用本地 SQLite 持久化 Web 与 CLI 会话、消息和项目记忆。SQLite
是单机本地工具合适的真相源，但无法直接演示服务端系统常见的缓存命中、缓存失效和
跨进程通知模式。

本设计在不改变 SQLite 持久化职责的前提下，引入可选 Redis 加速层。首期重点不是为
当前数据规模解决性能瓶颈，而是用真实业务路径展示 Cache-Aside 和 Pub/Sub 的正确用法。

## 目标

- SQLite 继续作为会话、消息和项目记忆的唯一持久化真相源。
- 使用 Redis 缓存模型注入所需的启用项目记忆，减少每轮任务的重复 SQLite 查询。
- 项目记忆变化后删除共享缓存，并通过 Pub/Sub 通知其他进程刷新状态。
- Redis 未配置、连接失败或运行中断开时，Web 与 CLI 仍能完整工作。
- 复用 Web 与 CLI 的缓存、序列化、Key 生成和失效逻辑。
- 提供 macOS 本地 Redis 启动、配置和观察方式，便于学习缓存行为。

## 非目标

- 不使用 Redis 替代 SQLite。
- 不缓存模型消息、API Key、完整提示词、工具输出或其他高敏感内容。
- 不在首期实现分布式锁、任务队列、限流器或延迟任务。
- 不保证 Redis Pub/Sub 消息持久化或离线补发。
- 不要求开发、测试或生产环境必须安装 Redis。
- 不为当前单机数据规模承诺可量化的性能收益。

## 方案比较

### 方案 A：Cache-Aside，可选 Redis

业务服务先查询 Redis，未命中时查询 SQLite 并回填。写操作先提交 SQLite，成功后删除
Redis Key。Redis 故障时直接访问 SQLite。

优点是职责清晰、降级自然、改动范围小，适合当前项目。缺点是业务服务需要显式处理
缓存命中和失效。

### 方案 B：Read-Through 存储适配器

用统一 Repository 包装 SQLite 和 Redis，上层只调用 Repository。

优点是业务层更干净。缺点是需要重构现有 `PersistenceStore` 调用面，且缓存策略容易
隐藏在通用接口中，不利于学习具体的数据流。

### 方案 C：Redis 主存储

会话和记忆直接写入 Redis，SQLite 退化为备份或取消。

该方案破坏离线能力，引入数据持久性和一致性问题，不适合本地 Agent。

首期采用方案 A。

## 总体架构

```text
Web / CLI
    |
SessionService / MemoryService
    |                    |
PersistenceStore        CacheService
    |                    |
SQLite                   Redis（可选）
真相源                   缓存与通知
```

`PersistenceStore` 保持唯一 SQL 入口。`CacheService` 是独立旁路依赖，不包装或替代
`PersistenceStore`。`MemoryService` 显式执行 Cache-Aside，便于从代码中观察缓存行为。

## 组件设计

### CacheService

新增共享接口，提供：

- `getJson`：读取并解析 JSON 缓存，未命中或失败返回 `null`。
- `setJson`：写入 JSON 并设置 TTL。
- `delete`：删除一个或多个 Key。
- `publish`：发布缓存失效事件。
- `subscribe`：订阅缓存失效事件。
- `close`：关闭命令连接和订阅连接。

缓存接口不暴露 Redis Client，避免业务服务依赖 Redis 命令细节。

### RedisCacheService

使用官方 `redis` npm 包。实例维护：

- 一个普通命令连接。
- 需要订阅时通过 `duplicate()` 创建的独立订阅连接。
- 连接状态和一次性错误回调。

所有运行时 Redis 错误都脱敏后记录。缓存方法采用 fail-open：读取错误视为未命中，
写入、删除和发布错误不影响 SQLite 结果。

### NullCacheService

未配置 `REDIS_URL` 或首次连接失败时使用：

- 读取始终返回 `null`。
- 写入、删除、发布和订阅均为空操作。
- 不改变现有 Web 与 CLI 行为。

这也作为单元测试和无 Redis 环境的默认实现。

### createCacheService

启动时根据配置创建缓存：

1. 未配置 `REDIS_URL`，返回 `NullCacheService`。
2. 配置后尝试连接，连接时间上限为 1 秒。
3. 首次连接失败，显示一次脱敏警告并返回 `NullCacheService`。
4. 已连接后运行中断开，由 Redis Client 按有界退避重连；重连期间缓存方法 fail-open。

Web 和 CLI 关闭时必须调用 `close`，不得留下重连定时器或 Socket。

## 配置

新增环境变量和对应 CLI 参数：

| 环境变量 | CLI 参数 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `REDIS_URL` | `--redis-url` | 空 | Redis 连接地址；空表示禁用 |
| `REDIS_CACHE_TTL_SECONDS` | `--redis-cache-ttl` | `300` | 缓存 TTL，范围 1–86400 秒 |

`REDIS_URL` 可能包含用户名和密码，不得出现在日志、错误、Web 状态或模型上下文中。
配置脱敏沿用现有 `redactSecrets` 边界。

macOS 本地学习环境：

```bash
brew install redis
brew services start redis
redis-cli ping
```

`.env` 示例只填写无密码的本地地址，不提交真实凭据：

```env
REDIS_URL=redis://127.0.0.1:6379
REDIS_CACHE_TTL_SECONDS=300
```

## Key 设计

Redis Key 不包含原始工作区绝对路径，使用规范化工作区路径的 SHA-256 摘要：

```text
agent-cli:v1:memory:<workspaceHash>:active
agent-cli:v1:events:invalidate
```

- `active` 用于模型提示词注入。
- `v1` 支持未来不兼容的缓存格式升级。
- 所有数据 Key 必须有 TTL；事件 Channel 不设置 TTL。

Web 和 CLI 的记忆管理列表保持同步读取 SQLite，不为缓存改造现有同步快照接口。缓存内容
继续通过 `StoredMemory` Schema 校验。JSON 无法解析或 Schema 校验失败时，删除损坏 Key
并回源 SQLite，不把无效数据交给业务层。

## 读取流程

以有效项目记忆为例：

1. `MemoryService` 根据规范化工作区生成 `active` Key。
2. 调用 `CacheService.getJson`。
3. 命中且 Schema 校验通过，直接返回缓存内容。
4. 未命中、连接错误或数据无效时，查询 `PersistenceStore.listMemories`。
5. 异步使用 `SET EX` 回填 Redis，不阻塞 SQLite 查询结果。
6. TTL 到期后下一次读取自然回源。

首期不实现分布式防击穿锁。当前数据量和并发有限，同时回源 SQLite 的成本可接受。

## 写入与失效流程

所有接受、编辑、启停和删除记忆的操作遵循：

1. 在 SQLite 中完成事务。
2. 事务成功后删除该工作区的 `active` Key。
3. 发布包含 `workspaceHash` 和变更类型的失效事件。
4. 当前进程立即刷新自己的 UI 状态。
5. 其他 Web 或 CLI 进程收到事件后，重新读取需要展示的数据。

不得先更新 Redis 再提交 SQLite，也不得把 SQLite 与 Redis 伪装成一个原子事务。
删除缓存失败时依靠 TTL 最终过期；SQLite 结果仍然成功返回。

发布事件只包含：

```json
{
  "version": 1,
  "resource": "memory",
  "workspaceHash": "<sha256>",
  "action": "invalidate"
}
```

事件不包含记忆正文和原始工作区路径。

## 一致性模型

本设计采用最终一致性：

- SQLite 提交成功即视为业务写入成功。
- Redis 可能在 TTL 范围内短暂返回旧值。
- 正常路径通过事务后删除 Key 将窗口缩短。
- Pub/Sub 只负责主动刷新，不承担数据持久化。
- 进程漏掉通知时，下一次缓存未命中或 TTL 到期后恢复正确数据。

模型提示词注入要求尽可能读取新记忆，因此当前进程在写入后不复用旧缓存结果。

## 安全与隐私

- Redis 仅缓存已确认的项目记忆，不缓存候选项和完整会话。
- Redis URL 作为密钥处理，进入统一脱敏列表。
- Key 使用工作区哈希，不泄露用户名和本地目录。
- Pub/Sub 事件不携带业务正文。
- 远程 Redis 推荐使用 `rediss://`、认证和最小权限账户。
- 子进程继续不继承 Redis 与 AIDP 凭据环境变量。
- README 明确 Redis 是可选外部服务，不是安全存储。

## 可观测性

首期使用有限的本地日志：

- Redis 已启用或未配置。
- 首次连接失败并降级。
- 运行中连接断开和恢复。
- 缓存 JSON 或 Schema 无效并回源。

不记录 Redis URL、Key 中的工作区哈希、缓存正文或 Pub/Sub 载荷。缓存命中率统计作为后续
扩展，不在首期增加全局指标系统。

## 测试策略

### 单元测试

使用内存 Fake 实现 `CacheService`，覆盖：

- 命中时不查询 SQLite。
- 未命中时查询 SQLite 并回填 TTL。
- Redis 读取异常时回源 SQLite。
- SQLite 写入成功后删除两个 Key 并发布事件。
- SQLite 写入失败时不删除缓存、不发布事件。
- 损坏 JSON 或不合法 Schema 被删除并回源。
- Redis URL 和错误文本不会泄漏凭据。

### 集成测试

默认测试不依赖 Redis 服务，确保 `pnpm test` 在任何机器上可运行。

当设置 `TEST_REDIS_URL` 时，增加可选真实 Redis 集成测试：

- 使用测试运行唯一前缀写入和清理 Key。
- 验证 TTL、缓存命中、删除和 Pub/Sub。
- 验证 Redis 断开后 SQLite 路径仍可用。

### 回归验证

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- 无 `REDIS_URL` 启动 Web 与 CLI，行为与当前版本一致。
- 本地 Redis 启动后完成记忆读取、编辑、失效和跨进程刷新。

## 文档与学习说明

README 增加“Redis 可选加速层”章节，解释：

- Cache-Aside 的适用场景。
- 为什么 SQLite 仍是真相源。
- 缓存命中、未命中、回填、失效和 TTL。
- Pub/Sub 与持久消息队列的区别。
- macOS 安装、启动、观察 Key 和停止 Redis 的命令。
- Redis 不可用时如何确认应用已经降级。

## 验收标准

- 未安装或未配置 Redis 时，现有功能和测试不受影响。
- Redis 命中时，模型注入所需的启用记忆读取不访问 SQLite。
- Redis 未命中或失败时，启用记忆正确从 SQLite 返回。
- 记忆写入只在 SQLite 成功后失效缓存并发布事件。
- Web 与 CLI 可通过 Pub/Sub 感知其他进程的记忆失效。
- Redis 断开、损坏缓存和无效配置不会导致任务失败。
- 日志、Web 状态和模型上下文不泄露 Redis 凭据。
- README 能支持 macOS 用户完成一次可观察的缓存实验。
