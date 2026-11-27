# Mica 远程 Agent 上下文技术方案

状态：设计提案，尚未实现。
目标场景：A 是家里的开发机，B 是公司的工作电脑；用户在 B 上选择 A 作为一个上下文，
由 A 上的 Agent 使用 A 的项目、会话、文件和工具执行任务，B 只负责发起操作和显示结果。

## 1. 先明确目标

### 1.1 目标体验

```text
B（控制端）
  └─ 选择「家里的 Mac A」
      └─ 选择 A 上的项目和会话
          └─ 在 B 上输入任务
              └─ A 上的 Agent 读取 A 的工作区并执行
                  └─ 运行事件、回答和按需读取的内容实时回到 B
```

A 是工作区和执行状态的**唯一真实来源**。B 不是把会话复制过来，也不是在 B 上重新启动
一个看起来相同的 Agent。B 发出的 `turn/start`、文件读取和中止请求，最终都由 A 上的
运行时处理。

### 1.2 在线和离线的语义

| 状态 | B 可以做什么 | B 不可以做什么 |
| --- | --- | --- |
| A 在线 | 列出已授权会话、读取实时历史、读取 A 的工作区、启动/继续/中止 Agent 轮次、查看运行事件 | 超出授权范围的会话、工作区和工具操作 |
| A 暂时断线 | 查看 B 本地已经缓存的内容；查看最后一次在线时间和最后已知状态 | 读取当前文件、启动任务、执行命令、获取最新 diff |
| A 离线时任务正在运行 | 显示「结果未知」，等待 A 上线后查询最终状态 | 自动重跑可能已经执行过一半的任务 |
| A 恢复在线 | 通过运行 ID 和事件序号补齐状态；必要时重新读取历史页 | 不因重连自动再次发送有副作用的请求 |

“实时传输”指**操作请求和运行结果在 A 在线时实时转发**，不指把 A 的整个工作区持续
同步到 B 或中转机。文件内容只有在用户明确请求读取、或 A 上的 Agent 为当前轮次需要它时
才会离开 A。

### 1.3 非目标

第一版不做以下事情：

- 把项目目录、会话 JSON、配置文件或环境变量上传到中转机；
- 自动扫描工作区并持续同步文件变化；
- 让中转机挂载 A 的磁盘、执行 A 的 shell 或直接访问 provider key；
- 通过一个远程 token 直接暴露现有完整的 `/api/*`、文件、终端和 MCP 接口；
- 在 B 上迁移并重建 A 的 Agent；
- 用“加密”声称可以绕过公司网络的 DLP、代理或监控；
- 第一版就提供任意远程 shell 或任意文件写入。

## 2. 总体架构

```text
┌──────────────────── B：控制端 ────────────────────┐
│ Mica Desktop                                        │
│  Remote Context 插件                                │
│  本地 Chat UI / 本地 SSE                             │
│  Remote Context Client（设备密钥、缓存、重连）       │
└───────────────┬────────────────────────────────────┘
                │ WSS + 应用层加密信封
                │ 主动出站连接，不要求 B 接收入站端口
                ▼
┌────────────────── 中转机 Relay ───────────────────┐
│  账号/设备认证、配对、授权检查、在线状态、消息路由   │
│  默认不保存正文；可选保存端到端加密的事件密文         │
│  不挂载工作区、不执行命令、不解析业务正文             │
└───────────────┬────────────────────────────────────┘
                │ WSS + 应用层加密信封
                │ A 和 B 都主动连接
                ▼
┌──────────────────── A：执行端 ────────────────────┐
│ Mica Desktop / mica app-server                      │
│  Remote Worker / Remote Context Service              │
│  本地 SessionStore、turn lease、AgentRuntime          │
│  本地文件、Git、终端和插件工具                       │
└────────────────────────────────────────────────────┘
```

### 2.1 组件职责

| 组件 | 部署位置 | 职责 | 明确不负责 |
| --- | --- | --- | --- |
| `remote-context` 官方插件 | A、B 的 Mica | 机器列表、配对入口、上下文选择、在线状态、权限提示 | 自己实现加密协议、自己读 session 文件、自己拼路径 |
| Remote Context Client | B | 连接 relay、发送受限请求、接收事件、维护本地缓存和重连状态 | 执行 A 的工具或猜测 A 的当前状态 |
| Remote Worker | A | 维护机器级连接、把请求路由到本地会话宿主、投影受限结果 | 直接把整个文件系统或整个 session JSON 上传 |
| `mica app-server` / 本地 Host | A | 现有 Agent、turn、MCP、工具、会话锁和本地事件 | 认识具体的 relay 厂商或账号系统 |
| Relay | 中转机 | 认证、授权、路由、限流、连接状态 | 读取业务正文、执行 A 的命令、访问 A 的文件 |
| `mica-remote-protocol` | 共享包 | 协议类型、大小限制、错误码、事件序号、加密信封接口 | 读取本地文件或持有用户凭据 |

## 3. 插件和内核的边界

### 3.1 推荐形态：插件入口 + 通用宿主能力

界面做成类似 SSH 插件的 `Remote Context` 插件，但远程执行不能只做成一个模型工具。
它需要在没有打开具体聊天页时也保持机器在线、接收配对请求和报告状态；当前插件的
`ctx.background` 是按宿主/会话装配的，不能直接拿它当机器级常驻服务。

建议先给插件系统增加一个不包含具体插件名的通用能力面，例如：

```ts
ctx.machineServices.register({
  id: 'remote-context-connector',
  start: ({ signal, owner }) => ...,  // 由宿主管理生命周期
  stop: () => ...,
});
```

实际 API 名称待实现时确定，但必须满足以下约束：

- 服务跟随插件启停，不安装 launchd、systemd 或其它脱离 Mica 的常驻 poller；
- 插件停用、注销机器或退出桌面时，连接、订阅和子进程都被关闭；
- 宿主只提供生命周期、连接和会话适配能力，不写 `if (pluginId === 'remote-context')`；
- 纯协议和授权规则放进共享包，可在没有桌面的测试进程中测试；
- 如果要支持 TUI 或无桌面服务器，另提供 `mica remote-worker` 入口，而不是让插件偷偷
  在一次性 `mica exec` 中常驻。

这符合项目的插件原则：用户可见能力属于插件，跨宿主需要的通用机制先扩展能力面，宿主
不为某个插件写死分支。

### 3.2 不直接复用现有 Connections 的远程 API

当前 `Connections` 主要是地址簿：它能探活、记住地址并打开另一台 Mica 的独立窗口；
现有桌面运行时的 `/api/invoke` 等接口则拥有文件、终端、配置等较宽权限。它们都不适合
直接作为“远程上下文”协议：

- 地址簿记录的是 URL，不是账号、设备、机器和会话授权；
- 打开远程页面会把页面切换到另一台运行时，不是让 B 当前页面选择 A 作为执行上下文；
- 直接转发完整 `/api/*` 会把本机管理 API 变成中转机后的远程 shell；
- 现有 mobile-relay 链接中的查询参数 token 是入口凭据，不能作为新协议的长期设备身份。

因此两者的关系是：

- `Connections` 继续负责“打开另一台 Mica 运行时地址”；
- 新的 `Remote Context` 负责“在当前 B 中选择一台已授权的远程执行机”；
- 两者可以共享 relay 的地址探活和设备发现代码，但不共享完整权限 token。

## 4. 用户流程

### 4.1 在 A 上注册机器

1. A 打开 `Remote Context` 设置，点击“添加到远程工作区”。
2. A 本地生成机器身份密钥，不让模型生成、不让用户手工复制长 token。
3. 插件通过 relay 的一次性配对动作拿到短期配对码或二维码。
4. 用户在 B 登录同一个账号，或者在 B 扫描配对码。
5. relay 将 B 的设备公钥和 A 的机器授权绑定；A 端显示并确认机器名称、账号和权限。
6. A 开始主动建立 WSS；界面显示“在线”后，B 才能实时操作。

配对码只允许一次使用、短时间有效，不能作为长期访问凭据。长期身份保存在设备密钥
和可撤销的刷新凭据中。凭据不出现在 URL、日志、会话正文或模型上下文里。

### 4.2 在 B 上选择 A

B 的上下文选择器显示：

```text
当前上下文：Local

可用机器
  ● 家里的 Mac A       在线       最近活动：刚刚
  ○ 办公室 Mac B       本机
  ○ 家里的 Mac A       离线       最后在线：今天 09:42
```

选择 A 后，B 请求 A 的工作区和会话目录。目录中的工作区只显示用户在 A 上显式授权的
逻辑名称，例如 `mica-home-project`，不显示 `/Users/...` 这类绝对路径。

选择远程上下文只改变当前聊天节点的执行目标，不改变 B 自己的本地工作区，也不把 B 的
provider 配置、环境变量和文件自动发送给 A。

### 4.3 在 B 上运行任务

1. B 创建一个带 `clientRequestId` 的 `turn/start` 请求。
2. A 校验设备、账号、机器、工作区、会话和当前权限。
3. A 将请求交给现有 `app-server` / `HeadlessTurnExecutor`，不在远程层重写 Agent 循环。
4. A 发送 `turn/started`、工具事件、文本增量和 `turn/completed` 等事件。
5. B 只把这些事件投影到本地 UI；B 不把事件再当成一个新的本地 Agent 请求。
6. 如果 B 在运行中断线，B 不自动重新发 `turn/start`；恢复后先查询这次 `runId` 的状态。

模型请求、工具执行、文件访问和 MCP 请求都发生在 A。B 的输入文本当然会传给 A；A 的
回答、必要的工具结果和按需读取的文件内容也可能传回 B。它们都是本方案明确的数据流，
不能宣传成“完全不出网”。

## 5. 数据传输和隐私边界

### 5.1 数据分类

| 数据 | 默认是否经过 relay | 传输方式 | 默认策略 |
| --- | --- | --- | --- |
| 在线/离线、机器别名、能力摘要 | 是 | relay 可见的最小路由元数据 | 可见，但不含路径和正文 |
| 设备身份、授权、会话 ID | 是 | TLS；业务字段再加密 | relay 只需要不透明 ID |
| 用户输入、Agent 回答、文件片段 | 是 | WSS + 端到端加密 | 只在实时请求或用户点开时发送 |
| 工具调用参数和结果 | 是 | WSS + 端到端加密 | 只投影当前运行需要的事件，按隐私模式过滤 |
| A 的整个 session JSON | 否 | 不允许此接口 | 只能由 A 本地 SessionStore 读取并投影 |
| A 的项目压缩包、目录快照 | 否 | 不提供上传接口 | 明确拒绝 |
| provider key、环境变量、系统 prompt | 否 | 不进入远程响应 | A 本地保留；必要时只显示固定状态 |
| B 的本地项目和配置 | 否 | 不因选择 A 自动上传 | B 的本地上下文仍是另一台机器 |

“不直接上传文件”应准确解释为：协议没有文件上传、目录同步和 session 文件同步接口。
但是 B 请求读取 A 的文件时，返回的文本或二进制片段就是数据传输；如果业务要求文件内容
绝不能离开 A，则 B 只能看到状态/摘要，不能显示文件全文，A 的 Agent 仍可在 A 本地读取。

### 5.2 隐私模式

每台机器和每个工作区分别设置，不用一个全局开关覆盖所有项目：

| 模式 | 允许实时传输 | 离线缓存 | 适用场景 |
| --- | --- | --- | --- |
| `metadata-only` | 在线状态、会话标题、轮次终态和固定摘要 | 只缓存元数据 | 工作电脑严格禁止源码离开 A |
| `live` | 当前用户输入、回答、按需文件片段、当前工具事件 | B 本地可选缓存已显示内容 | 默认远程开发模式 |
| `live-with-history` | `live` 全部内容 | A 将筛选后的历史事件端到端加密后交给 relay，按 TTL 保存 | A 离线时仍要查看历史 |

默认使用 `live`，不自动开启历史同步。`live-with-history` 必须显示预计保留时间、大小上限、
删除动作和“中转机管理员仍能看到流量元数据”的提示。

### 5.3 缓存策略

B 端缓存只能保存 B 实际收到的投影，不能在离线时伪造 A 的当前状态：

- 默认缓存会话元数据、事件序号、最后在线时间和用户已经看过的历史页；
- 严格模式不缓存文件内容、终端输出、原始工具结果和系统 prompt；
- 缓存放在 B 的 `$MICA_HOME/plugin-data/remote-context/`，使用 0600 文件和 CAS 写入；
- 缓存带机器/账号/会话绑定，注销设备时删除对应密钥和缓存；
- 过期缓存显示“最后已知”，所有读取当前状态的操作必须走 A；
- 中转机的离线历史只保存端到端密文，带 TTL、单机器配额和撤销后的删除流程；
- relay 默认不保存正文，只有显式启用 `live-with-history` 才启用密文事件存储。

## 6. 加密、认证和授权

### 6.1 两层加密

1. **传输层：TLS 1.3 / WSS**。防止普通网络观察者直接读取正文，防止连接被篡改。
2. **应用层：端到端加密信封**。A 与 B 的设备公钥完成密钥协商；relay 只转发密文，不能
   通过数据库或服务日志读取会话、文件和工具内容。

应用层加密不得手写算法。实现时使用经过审查的密码库和固定方案：

- 设备签名：Ed25519；
- 会话密钥协商：X25519；
- 派生：HKDF-SHA-256；
- 内容加密与完整性：AES-256-GCM 或库中等价的 AEAD；
- 每个信封使用唯一 nonce，计数器和密钥世代写入 AAD；
- 每个设备有签名公钥、加密公钥和密钥世代；换设备或撤销时生成新世代；
- 私钥只在本机安全存储中使用，不进入 relay、URL、日志或 Agent prompt；
- 浏览器端和 Node 端共用协议测试向量，禁止“Node 一套加密、浏览器另一套猜测实现”。

TLS 终止在 relay 并不等于 relay 能读到正文；正文是否能被 relay 解密由应用层密钥决定。
但 relay 仍能知道连接双方、时间、帧大小、在线状态和频率，端到端加密不能隐藏这些元数据。

### 6.2 身份层次

```text
Account
  ├─ Device B（控制端公钥）
  ├─ Device A（执行端公钥）
  └─ Machine A（机器身份，绑定一个或多个设备）
       └─ Workspace / Session grants
```

授权不以 session ID 作为身份。会话 ID 只是 A 本地会话的引用；账号、设备和工作区授权
独立保存，避免复制、fork 或恢复会话时意外获得另一台机器的权限。

建议最少提供三种角色：

| 角色 | 能力 |
| --- | --- |
| `observer` | 查看在线状态、已授权会话和允许的历史；不能启动 Agent 或读取工作区文件 |
| `operator` | `observer` + 向指定会话发送输入、steer、interrupt、读取明确请求的文件片段 |
| `owner` | 管理机器、工作区、设备、权限、历史保留和撤销 |

角色不是本地安全沙箱。`operator` 能让 A 的 Agent 执行哪些工具，仍由 A 的会话能力选择、
插件、MCP 和本地运行策略决定；远程请求不能把 A 的能力从受限改成更高权限。第一版不
提供 B 直接执行任意 shell 的 `command/exec`。

### 6.3 授权校验位置

授权至少在三处校验：

1. B 的 UI 只展示 relay 返回的授权结果；
2. relay 校验账号、设备、机器和 grant，拒绝未授权路由；
3. A 再校验设备签名、机器密钥世代、workspace/session 映射和本地策略。

relay 返回的“已授权”不能替代 A 的本地校验。A 离线缓存的授权也不能在恢复后继续盲信，
恢复连接时必须完成新的握手和密钥世代检查。

## 7. 协议设计

### 7.1 信封格式

业务消息统一包在一个版本化信封中。relay 只需要解析路由头，不解析加密 body：

```json
{
  "version": 1,
  "kind": "request",
  "route": "opaque-machine-id",
  "senderDevice": "opaque-device-id",
  "keyGeneration": 3,
  "messageId": "uuid",
  "requestId": "uuid",
  "sessionRef": "opaque-session-ref",
  "sequence": 1842,
  "sentAt": 1760000000000,
  "nonce": "base64url",
  "ciphertext": "base64url",
  "signature": "base64url"
}
```

注意事项：

- `sessionRef` 使用不可猜测的不透明引用；relay 不需要知道真实本地文件名；
- `messageId` 防止同一帧重复投递；`requestId` 防止副作用请求重发；
- `sequence` 是每个机器/会话方向的单调序号，用于补帧和检测重放；
- body 中才放具体 RPC 名称、路径、输入文本和结果；
- `sentAt` 只用于过期检查，不能单独作为防重放依据；
- 所有未知版本、未知 key generation、坏签名、坏 nonce、过期或超限消息都拒绝；
- 错误响应只带固定错误码和经过截断的人类说明，不回传堆栈、环境变量和绝对路径。

### 7.2 第一版 RPC

| RPC | 方向 | 说明 | 幂等性 |
| --- | --- | --- | --- |
| `context/list` | B → A/Relay | 获取已授权机器和能力摘要 | 是 |
| `workspace/list` | B → A | 获取 A 上显式授权的逻辑工作区 | 是 |
| `session/list` | B → A | 分页获取会话元数据 | 是 |
| `session/attach` | B → A | 绑定一个会话并开始事件订阅 | 是 |
| `session/history.page` | B → A | 按游标读取一页已授权历史 | 是 |
| `workspace/file.read` | B → A | 按相对路径和范围读取小片段 | 是 |
| `turn/start` | B → A | 启动一轮 Agent | 由 `requestId` 去重 |
| `turn/steer` | B → A | 在允许的迭代边界注入输入 | 由 `inputId` 去重 |
| `turn/interrupt` | B → A | 中止当前轮次 | 可重试 |
| `turn/status` | B → A | 查询 run/turn 最终状态 | 是 |
| `session/detach` | B → A | 取消订阅，不停止 A 上的任务 | 是 |

第一版明确不提供：`workspace/archive`、`workspace/upload`、`workspace/download`、
`command/exec`、`session/raw`、`config/read`、`env/read` 和 `provider/key`。

### 7.3 事件

事件名称尽量复用现有 `mica app-server` / Codex 投影，避免 B 再实现一套 Agent 语义：

```text
context/online
session/attached
session/history/replaced
turn/started
turn/retrying
item/started
item/agentMessage/delta
item/reasoning/textDelta       # 按隐私策略可关闭
item/commandExecution/outputDelta
item/completed
thread/tokenUsage/updated      # 可只传汇总
turn/completed
error
warning
```

每个事件附带：`sessionRef`、`runId`、`turnId`、`eventId`、`sequence` 和 `emittedAtMs`。
文本增量不是每个字符发一个 WebSocket 帧，而是在 50–250ms 窗口内合并，或达到字节阈值
立即发送。B 收到重复事件时按 `eventId` 去重，收到序号空洞时请求补帧或重新读取历史页。

### 7.4 文件读取

文件读取是最容易把“不上传文件”误解成安全保证的地方，第一版必须限制形状：

```json
{
  "workspaceId": "opaque-workspace-id",
  "path": "src/app.ts",
  "startByte": 0,
  "maxBytes": 65536,
  "expectedRevision": "sha256:..."
}
```

A 端规则：

- 只接受相对路径，拒绝绝对路径、`..`、空字节和未知工作区；
- 解析后校验 realpath 仍在工作区根目录内，明确处理符号链接逃逸；
- 每次最多返回 64 KiB，单请求设置超时和取消；
- 大文件必须由 B 分段、主动请求，不能由 A 自动推送完整内容；
- 返回 `revision` 和 `truncated`，B 不能把截断结果当成完整文件；
- 默认不读取 `.env`、密钥目录、插件 secret、配置 key 和系统目录；
- 文件内容只在 `live` 或更宽的隐私模式下允许返回；
- 第一版没有 `file.write`。Agent 修改文件仍走 A 本地工具；
- 未来若提供编辑器写回，只接受带 `expectedRevision` 的受限 patch，不接受“上传文件”语义，
  并且必须单独授权。patch 中的代码仍属于数据传输，需要在 UI 明确提示。

## 8. 请求大小、频率和连接策略

以下是建议的初始硬上限，最终值集中在协议包，不散落在 UI、relay 和 worker 中：

| 项目 | 建议上限/间隔 | 超限行为 |
| --- | --- | --- |
| 单个加密 WebSocket 帧 | 256 KiB | 拒绝该帧并记录固定错误码 |
| 单次历史页 | 128 KiB 或 80 条消息，先达到者为准 | 返回分页游标，不拆成无限推送 |
| 单次文件读取 | 64 KiB | 要求 B 显式请求下一段 |
| 文本增量批量窗口 | 50–250ms | 合并后发送，不逐字符发送 |
| 状态/心跳 | 30 秒心跳；状态只在变化时发送 | 不因为 UI 轮询而上传全量状态 |
| 同一设备控制请求 | 每秒 10 个、短时 burst 20 | 返回 `rate_limited`，不排队执行 |
| 同一会话并发读取 | 4 个 | 返回 `busy` 或让客户端退避 |
| 单个远程连接 | 2 个活跃会话；其余只读或显式切换 | UI 显示限制，不隐式开更多宿主 |
| relay 离线密文缓存 | 每设备/工作区有字节配额和 TTL | 新事件停止入队并提示，不无限堆积 |

运行事件只在有订阅者或启用历史同步时发送。A 本地可以把短时间内的事件合并为一帧，
但不能为了省流量丢掉 `turn/completed`、错误和最终状态。

## 9. 实时连接和断线恢复

### 9.1 连接建立

1. A、B 分别通过 HTTPS 完成账号/设备认证，随后主动建立 WSS；不要求家庭网络开放端口。
2. WSS 首帧完成协议版本、设备公钥、key generation 和能力协商。
3. relay 只根据已认证的 opaque route 将两条连接桥接；不接受客户端指定任意目标地址。
4. A 发布机器在线状态和协议版本；B 获取到授权列表后才显示可操作。
5. 每个 `session/attach` 生成新的订阅代号和客户端 nonce，防止旧连接的事件混入新页面。

### 9.2 请求去重

| 请求 | 丢响应后 B 的行为 |
| --- | --- |
| `workspace/file.read`、`session/history.page` | 可使用同一个 request ID 重试 |
| `turn/start` | 不自动重发；先 `turn/status(requestId)`，由 A 返回已接受/运行中/已完成/未知 |
| `turn/steer` | 使用 `inputId` 查询是否已注入；未确认前不重复发送 |
| `turn/interrupt` | 可重试；A 端按 runId 幂等处理中止 |

`turn/start` 的去重记录至少保留到该轮终态并写进 A 的小型本地状态文件，不能只放内存；
否则 A 进程重启后，B 重连会再次执行一次可能有副作用的任务。

### 9.3 事件补齐

- B 每个会话保存最后确认的 `sequence`；
- 重连时发送 `resume(sessionRef, lastSequence)`；
- A 只从有界的本地事件 outbox 补帧；
- outbox 没有覆盖到该序号时，A 回 `history_gap`，B 重新读取历史页和当前运行态；
- 历史页使用现有游标/前缀校验思路，不能用旧缓存覆盖补读期间的新事件；
- 事件补齐不重新启动 Agent，不重新计费用量，不执行工具；
- relay 不为一条永不结束的 WebSocket 保存无限 backlog。

### 9.4 A 离线和恢复

断线时 B 显示：

```text
家里的 Mac A：离线
以下内容是最后一次在线时缓存的状态，不代表当前工作区。
```

所有需要 A 当前事实的操作统一返回固定错误：

```text
remote.offline
remote.stale_snapshot
remote.session_not_attached
remote.permission_denied
remote.request_unknown
remote.history_gap
remote.rate_limited
```

如果 A 在轮次中断线，B 显示“任务状态未知”，而不是“失败”或“成功”。A 恢复后，B
查询 `runId`；如果本地记录表明 A 已经完成，就只补显示结果；如果 A 没有这条记录，才
允许用户明确点击“重新执行”。

## 10. A 端与现有代码的接入点

### 10.1 复用现有能力

远程层不应复制这些逻辑：

- `mica app-server` 的 `thread/start`、`thread/resume`、`turn/start`、`turn/steer` 和
  `turn/interrupt`；
- `HeadlessTurnExecutor` 的 lease、队列、中止、重试和终态收尾；
- `CodexProjector` 的 Agent 事件投影；
- `SessionStore` 的会话保存、`sessions/.turn-locks/<id>.lock` 和跨进程写入保护；
- 桌面端现有的历史分页、SSE 断线恢复和 `chat:restore`；
- 工作区访问的 realpath、路径归属和现有文件服务边界。

Remote Worker 应当是一个适配器：

```text
Remote RPC
  → 权限/路径/大小校验
  → 本地 session host / app-server 请求队列
  → 现有 HeadlessTurnExecutor / SessionStore
  → 现有 Codex/Mica 事件
  → 远程事件投影与加密信封
```

不能通过“直接 JSON.parse `$MICA_HOME/sessions/*.json` 再上传”的方式实现。会话元数据可用
session index 和 `sessionFileHead` 的轻量读取，历史应经现有分页/投影链路；大消息、系统
提示词和 provider 原始 usage 不因远程功能重新落盘或上传。

### 10.2 建议的代码布局

以下是实现时的建议布局，名称可以在编码前调整，但职责不要混在一起：

```text
packages/mica-remote-protocol/
  envelope.ts          # 信封、版本、路由头、大小限制
  messages.ts          # RPC 与事件类型
  errors.ts            # 固定错误码
  sequence.ts          # 去重、序号、resume 状态机
  crypto.ts            # 加密接口和 Node/浏览器适配，不写自制算法

apps/cli/src/remote/
  RemoteWorker.ts      # A 端机器级 worker
  RemoteSessionBridge.ts
  RemoteRequestPolicy.ts
  RemoteOutbox.ts

apps/desktop/src/host/
  remote-context-service.js  # 桌面宿主生命周期、spawn、状态投影
  remote-context-cache.js    # B 端缓存与清理
  remote-context-transport.js

plugins/remote-context/
  plugin.json
  index.ts
  desktop.jsx
  permissions.ts
  cache.ts
  README.md
  *.test.ts

apps/relay/                 # 若与主仓库同库；也可以单独仓库部署
  src/server.ts
  src/auth.ts
  src/presence.ts
  src/router.ts
  src/store.ts
  src/limits.ts
  README.md
```

relay 服务不应依赖 `apps/desktop`、`mica-session` 或本地插件；它只依赖协议包和自己的
账号/存储接口。这样中转机升级不会拖着桌面端安装器，也不会获得本地文件能力。

### 10.3 生命周期

```text
插件启用
  → 宿主登记 machine service
  → 读取本机密钥和远程设置
  → worker 主动连接 relay
  → 发布在线状态

插件停用 / 注销 / 桌面退出
  → 停止接受新请求
  → 取消订阅和本地等待
  → 关闭 WebSocket
  → 终止由 worker 启动的 session host（不杀用户自己打开的独立 host）
  → 清理临时密钥、outbox 和内存缓存
```

不能用 launchd 装一个插件停用后仍会继续连接的 poller。若 worker 必须独立于某一条
聊天会话存在，由宿主负责监管子进程，并要求子进程跟随父进程退出，避免孤儿连接。

## 11. Relay 服务设计

### 11.1 服务端最小职责

relay 只需要提供：

- 账号/设备认证和公钥登记；
- 一次性设备配对和撤销；
- machine route 的授权检查；
- A/B 出站连接的桥接；
- 在线状态、连接代次和能力版本；
- 帧大小、频率、并发连接和密文存储配额；
- 可选的端到端加密事件密文存储和 TTL 清理。

relay 不提供以下接口：

- `GET /files`、`POST /shell`、任意 URL 代理；
- 以机器 ID 读取 A 的 session 文件；
- 让客户端自选目标 IP、端口或 Unix socket；
- 在日志中记录请求 body、文件路径、用户输入、token 或密文解密结果。

### 11.2 存储模型

```text
accounts
  id, auth_provider_subject, created_at

devices
  id, account_id, kind, signing_public_key, encryption_public_key,
  key_generation, revoked_at, last_seen_at

machines
  id, owner_account_id, label, protocol_version, revoked_at

machine_grants
  machine_id, device_id/account_id, role, workspace_scope,
  session_scope, expires_at, created_at

presence
  machine_id, connection_generation, online, capabilities, updated_at

encrypted_events       # 仅 live-with-history 开启时存在
  machine_id, session_ref, sequence, ciphertext, expires_at, byte_size
```

真实表结构以部署环境为准。`encrypted_events` 不应保存明文标题、路径、输入、回答、
工具参数或原始错误；日志也不能通过“调试字段”绕过这个边界。

### 11.3 Relay 连接协议

建议接口：

```text
POST /v1/devices/pair/start
POST /v1/devices/pair/complete
POST /v1/devices/revoke
GET  /v1/health
GET  /v1/relay-capabilities
WSS  /v1/relay
```

长期 token 不放在 URL 查询串；HTTP 使用授权 header，WebSocket 使用握手 header 或第一
个已认证帧。`/v1/health` 只返回服务版本、协议版本和是否可配对，不返回机器列表、会话
标题或任何用户数据。

## 12. 失败、错误和安全审计

### 12.1 错误分类

客户端需要区分：

- `offline`：A 没有可用连接；
- `busy`：A 在线，但会话由另一轮或另一个 writer 占用；
- `permission_denied`：设备/角色/工作区/会话不允许；
- `stale_snapshot`：只能拿到缓存，不能当作当前事实；
- `request_unknown`：请求可能送达但结果未知，必须查询状态；
- `history_gap`：事件 outbox 已过期，需要重新读历史页；
- `conflict`：文件或会话版本变化；
- `rate_limited` / `payload_too_large`：本地或 relay 限制；
- `protocol_mismatch` / `key_generation_mismatch`：需要重新握手或重新配对。

不能把所有情况压成“网络错误”，否则用户会误以为任务没有执行过而重复发送。

### 12.2 审计

A、B 和 relay 只记录固定元数据：

- 设备、机器和会话的不透明 ID；
- 固定操作名，如 `session.attach`、`turn.start`、`file.read`；
- 成功、拒绝、离线、超限、冲突、未知等固定结果码；
- 字节数、耗时、事件序号和连接代次；
- 错误分类，不记录原始正文、命令、文件内容、绝对路径或 stack trace。

审计不是正文备份，也不能为了排查问题把加密前 payload 写日志。需要调试时使用本地
开发开关、合成数据和明确的脱敏输出。

## 13. 实施阶段

### 阶段 0：协议和安全基线

交付：

- `mica-remote-protocol` 的类型、版本、错误码、大小限制和状态机；
- 设备身份、配对、密钥世代和信封加解密测试向量；
- threat model 和数据分类；
- 内存 fake relay，不连接真实中转机；
- 验证重复 `turn/start`、序号空洞、错误签名、过期帧和超限帧。

验收：relay 无法从测试数据库和日志读出明文业务 body；同一 request ID 不会启动两次。

### 阶段 1：设备注册和在线状态

交付：

- A/B 设备配对和撤销；
- Remote Context 插件的机器列表；
- A 主动连接 relay，B 显示 online/offline；
- 无会话时也能保持机器级连接；
- 关闭插件、注销机器和退出桌面会真正断开连接。

验收：A 在线/断网/重连时，B 状态正确；没有打开聊天页也能显示 A 在线；停止插件后
relay 不再看到该机器连接。

### 阶段 2：只读会话目录和实时历史

交付：

- `workspace/list`、`session/list`、`session/attach`；
- 历史分页和事件序号；
- 只读 `observer` 角色；
- B 本地缓存与 stale 标记；
- 严格禁止 raw session JSON、完整工作区和 provider 配置外传。

验收：B 能看到 A 上授权的会话；A 离线时只能看到缓存并明确标 stale；未授权账号看不到
机器和会话；relay 存储与日志中没有明文历史。

### 阶段 3：远程 Agent 运行

交付：

- `turn/start`、`turn/steer`、`turn/interrupt`、`turn/status`；
- Remote Worker 到本地 `app-server` 的桥；
- 复用现有 turn lease、队列、重试和 Codex/Mica 事件；
- `runId` / `requestId` 去重和断线状态查询；
- `operator` 授权和当前会话能力策略校验。

验收：B 发起的轮次在 A 的工作区执行；B 能看到实时事件；强制断开 relay 后不会重复
执行；A 恢复后能判断最终状态；A 本地用户同时运行时，远程请求按现有 busy/lease 规则处理。

### 阶段 4：按需文件读取和离线历史

交付：

- `workspace/file.read` 的路径归属、范围、大小和敏感路径规则；
- `metadata-only` / `live` / `live-with-history` 三种模式；
- 可选的端到端密文事件存储、TTL 和删除；
- 受限文件查看器，不提供任意文件下载按钮。

验收：B 读取 A 的文件时只产生一个有界请求；不能通过路径穿越读出工作区外文件；大文件
不会被自动整份传输；A 离线时文件读取明确失败；历史密文过期后不可恢复。

### 阶段 5：可选的工作区交互

只有前几阶段稳定后再考虑：

- Git 状态和 diff 摘要；
- 受限终端输出；
- 带 CAS revision 的 patch 编辑；
- 交互式审批或更细粒度工具授权。

每一项都要单独加入数据分类、权限和限流规则，不能因为已经有 `turn/start` 就顺手把整个
桌面 `/api/*` 代理出去。

## 14. 测试和验收清单

### 协议和密码学

- 不同版本协商、未知字段、坏签名、坏 nonce、错误 key generation；
- 每个 nonce 唯一；序号回退、重复、空洞和过期帧；
- relay 只转发密文，日志和 SQLite fixture 无明文 body；
- 设备撤销后旧连接和旧密钥都不能继续发请求；
- 连接重建不会复用旧的 session nonce。

### 权限和路径

- observer 无法启动/中止 turn；
- operator 无法管理设备或改变 A 的能力选择；
- 未授权 workspace/session 的 ID 猜测无效；
- 相对路径、`..`、符号链接、大小写和跨平台分隔符测试；
- `.env`、secret、配置和系统路径按策略拒绝；
- B 的本地项目不会随着选择 A 被读取或上传。

### 断线和幂等

- 请求发到 A 但响应丢失时，`turn/status` 能返回真实状态；
- relay 断线、A 进程重启、B 页面刷新、事件重复/乱序/丢帧；
- A 在工具执行中断线时不自动重试；
- `turn/interrupt` 重试不产生多次副作用；
- 历史 gap 触发重读而不是拼接过期缓存；
- 会话 lease 与本地窗口、远程窗口并发时不产生双写。

### 大小和频率

- 长回答增量按窗口合并，不能一字符一帧；
- 大文件只能分段读取，超过上限返回固定错误；
- 高频点击、恶意循环和多标签页受到限流；
- relay 不会因为离线而无限积压密文；
- 长时间 idle 连接只发送心跳和状态变化。

### 真实 A/B 流程

用隔离的 `MICA_HOME`、临时项目、mock provider 和 fake relay 验证：

1. A 注册，B 配对，B 能选择 A；
2. B 选择 A 上的测试项目和会话；
3. B 发起一轮，文件读取和工具执行都发生在 A；
4. B 看到实时事件和最终回答；
5. 断开 A，B 只能看缓存，读文件和发任务失败；
6. 恢复 A，B 查询断线期间的真实 run 状态；
7. 用重复消息和乱序消息确认不会重复写文件或重复收费；
8. 删除授权后，已打开的 B 页面也必须在下一次请求时被拒绝。

测试不能使用真实工作目录、真实密钥、真实会话或生产 relay。涉及桌面实例时按项目约定
隔离 `MICA_HOME`、`MICA_DESKTOP_USER_DATA`、`MICA_DESKTOP_PORT` 和 Electron user-data。

## 15. 发布和运维

- relay 作为独立服务发布，不随桌面端静默安装或自动升级；
- relay 只开放 HTTPS/WSS，反向代理也必须限制 Host、Origin、连接数和 body/frame 大小；
- 账号登录、设备配对、撤销和历史删除都要有可观察的固定审计事件；
- 数据库备份若包含历史密文，也必须按密钥和 TTL 生命周期处理；
- relay 不保存私钥，不保存 provider key，不保存解密后的正文；
- 先灰度给单个测试账号和 fake relay，再允许真实机器注册；
- 升级协议时保留版本协商，旧客户端不能静默降级成无加密或宽权限模式；
- 出现协议错误时宁可离线，也不能回退到现有完整 `/api/*` 或明文 WebSocket；
- 提供“撤销所有设备”“删除机器缓存”“删除 relay 历史密文”“关闭远程能力”四个独立动作。

## 16. 关键取舍和未决事项

以下事项在开始编码前需要明确，但不影响上面的总体架构：

1. **账号体系**：复用现有账号、第三方 OIDC，还是 relay 自有账号。第一版必须至少支持
   设备撤销和一键重新配对，不能只靠一个永不过期 URL token。
2. **密钥恢复**：设备丢失后是否允许从账号恢复历史解密密钥。默认倾向“不自动恢复”，
   用新设备重新配对；否则账号被盗就可能解密旧历史。
3. **离线历史默认值**：工作电脑场景更安全的默认是不开启 relay 历史保存，只显示 B 本地
   已看过的缓存；需要“换电脑也能读旧历史”时显式开启 `live-with-history`。
4. **直接编辑和终端**：第一版只支持 Agent 在 A 上改文件，B 通过事件看结果；直接编辑器
   写回和终端必须等权限、审计和 CAS 方案单独评审。
5. **多账号共享机器**：是否允许同一台 A 授权多个账号。若允许，workspace/session grant
   必须独立于 machine owner，不能用机器在线就让所有账号看到所有会话。
6. **中转机部署位置**：可以把 `apps/relay` 放在本仓库，也可以拆成独立仓库；无论哪种，
   中转机都不能反向依赖桌面端或本地会话存储。

## 17. 结论

推荐实现为：

> **Remote Context 插件负责“选择哪台机器”，Remote Worker 负责“把请求交给 A 的本地
> Agent”，Relay 负责“认证、授权和转发”，A 永远是工作区与执行状态的真实来源。**

实时链路只传当前请求和结果，不做项目同步；文件内容按需、有界、受隐私模式控制地传输。
TLS 保护传输，应用层端到端加密保护 relay 数据库和 relay 进程；断线时显示最后已知缓存，
绝不把缓存冒充实时状态，也绝不自动重跑状态未知的有副作用任务。

这样既能实现“在 B 上像选择 SSH 上下文一样操作 A”，又不会为了实现远程 Agent 而把现有
Mica 的完整文件、终端和配置 API 暴露到中转机后面。
