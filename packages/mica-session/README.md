# mica-session

`mica-session` 是 Mica Code 的会话持久化包，负责保存、读取和列出 agent runtime 快照。

会话文件默认保存到：`~/.mica/sessions`；设置 `MICA_HOME` 时保存到 `$MICA_HOME/sessions`。

## 主要能力

- 创建会话 store：`micaSession.createStore()`。
- 创建会话 ID：`micaSession.createId()`。
- 读取最近会话列表：`store.list(limit)`。
- 加载指定会话：`store.load(id)`。
- 保存会话快照：`store.save(session)`。
- 获取写入租约：`micaSession.acquireTurnLease(id)`；拿不到返回 `null`。句柄的 `isHeld()` 核对未释放且磁盘 token 仍匹配，`release()` 幂等且只释放自身 token。
- 删除会话：`store.delete(id)`；先取得同一把写入租约，已有 writer 持锁时返回 `false`，不会清除其锁或会话数据。
- 列出正在运行的会话：`listSessionTurnLocks()`（读 `sessions/.turn-locks`，按持有进程是否存活判定）。
- 列出最近结束的会话：`listRecentSessionFiles({ since, limit })`（按 session 文件写入时间与头部 `updatedAt` 判定窗口，不持锁即代表那一轮已结束）。

## 使用入口

```ts
import { micaSession } from '../packages/mica-session/index.js';

const store = micaSession.createStore();
const sessions = store.list(10);
```

## 设计约束

- 本包只负责会话文件存储，不直接调用 provider 或渲染 UI。
- `listSessionTurnLocks()` 只读 `sessions/.turn-locks/<id>.lock` 的 `pid` 与 session 文件头部 4 KiB（`title`/`cwd`/`turnState`/`model`），不解析完整快照：会话文件可达几十 MB。
- `listRecentSessionFiles()` 同样只读文件头部：先用文件 mtime 粗筛窗口，再以头部 `updatedAt` 为准（缺失时退回 mtime），按最新在前排序并截断 `limit`；`session-index.json` 与非常规文件名不算会话。
- turn 锁是「某个进程正在跑这一轮」的唯一跨进程事实来源；空闲实例不持锁，因此不在列表里。
- 会话 ID 和路径需要做安全处理，避免越权读取任意文件。
- 保存内容应是可序列化快照，便于后续 resume、fork 或 session graph 扩展。
- 当前 `snapshot.messages` 统一保存 `@earendil-works/pi-ai` 的 `Message[]`，每份快照必须明确写 `messageFormat: 'pi-ai-v1'`。协议只决定下一次请求的传输；跨协议切换保留消息、工具结果和签名。没有标记的旧 Chat / Responses wire 历史只由 evolution 的 `pi-messages-v1` 一次性迁移，加载时不做旧格式回退；未知标记或非法协议拒绝读取。
- `interruptedThinking` / `activeThinking` 保存完整思考边界的展示进度，四种协议都可用；恢复时仍核对 provider、协议、模型与 endpoint，避免把另一模型的进度接到当前思考。`activeTurn` 在 `running` 状态保留输入及提交标志，所有协议共用中断恢复规则。
- `turnState` 记录最近一轮是 `running`、`completed`、`aborted` 还是 `error`；旧会话缺少该字段时按 `completed` 读取。
- 列表里的垃圾会话（`list`/`listRecent` 不展示、重建索引时删文件）指**占位标题 `Untitled session` + 无 user/assistant 对话 + 无 usage** 的空占位；`SessionSummary` 的 `hasConversation`/`hasUsage` 承载后两项，隐藏与删除共用同一谓词。`turnState === 'running'` 的会话一律保留且照常列出：那是异常终止留下的、需要用户找回并续跑的会话。
- `$MICA_HOME/session-index.json` 是元数据缓存，不是事实来源；字段不完整（例如旧版本写入、缺少 `hasConversation`/`hasUsage`）或版本号对不上时整份索引重建，避免把缺字段误读成「无内容」而隐藏真实会话。
- `listAllForUsage()` 只读取当前标记的会话。`version: 1` 之前的裸消息数组与 `{ id, title, messages }` 缺少恢复所需的 provider/model/cwd 元信息，这个形态不再支持；文件保留，索引记录为 rejects，不推测其身份或重新生成账本。
- `snapshot.subagentUsageHistory`（可选）保存该会话 owner 发起的 subagent 任务 usage（逐条请求 + 任务元数据），包括 Agent 工具的子任务与 helper 子代理（commit message / btw / compact 摘要）；`origin` 区分这笔开销的来源：`delegation`（主对话经工具委派，带 `initiatedByCallId`）、`plugin` + `pluginId`（插件自己的模型请求与它起的后台任务）、`helper`（内核后台助手）。三者共用同一份数组、同样计入会话开销，统计页按它分类。插件请求发起时绑定会话 id，等待期间切换会话后只更新原会话的用量；原会话被删除则不重建。旧快照缺少该字段时按空数组读取。fork 不继承它（也不继承 `usageHistory`），只继承描述继承上下文的 `lastUsage`。
- 新增会话字段时应明确版本策略和默认值。

## 目录说明

- `sessionStore.ts`：会话类型、文件存储实现、ID 创建和路径安全处理。
- `liveSessions.ts`：运行中会话枚举（turn 锁持有者 + session 头部元数据）。
- `index.ts`：公共 API 聚合导出。
