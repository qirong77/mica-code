# Agent IPC/RPC Attach 实现方案

## 目标

实现一个完整的本地 agent 切换系统：任意 Mica 终端可以通过 `/agents` attach 到另一个正在运行的 agent，实时接管它的 UI、输入、命令、abort 和后续对话。被接管的 agent 原终端进入只读状态；所有工具调用、session 保存、配置读取和命令执行都发生在被接管 agent 的进程和 cwd 中。

最终体验类似：

```text
/agents -> 选择 agent -> attach -> 像本地一样操作 remote agent -> /detach 返回本地 agent
```

该文档只描述理想实现逻辑，不依赖当前代码结构。

---

## 通用概念导读

本方案里会反复出现 IPC、RPC、attach、controller、snapshot 等词。它们分别处在不同层次：

```text
用户操作层：  /agents、attach、detach、takeover
业务控制层：  controller、observer、control lock、runtime snapshot
协议调用层：  RPC / JSON-RPC request-response-event
进程通信层：  IPC / Unix domain socket / JSON Lines
运行实体层：  agent process、local agent、remote agent、session、cwd
```

可以用一个类比理解：

```text
两个 Mica 终端像两个房间里的操作台。
IPC 是两间房之间接好的线缆。
RPC 是线缆上约定好的对话格式。
attach 是一个操作台请求接管另一个操作台。
controller 是当前真正拥有操作权的人。
observer 是只能观看状态的人。
snapshot 是接管开始时先拍下的一张完整现场照片。
event stream 是接管后持续传来的现场变化。
```

### IPC 是什么

IPC 是 Inter-Process Communication，中文通常叫「进程间通信」。

一个 Mica CLI 终端就是一个操作系统进程。两个终端之间默认不能直接读写彼此内存，也不能直接调用彼此对象方法，所以需要一个通信机制来交换数据。IPC 解决的就是：

- 进程 A 如何找到进程 B
- 进程 A 如何连接进程 B
- 两个进程之间如何传输字节流
- 连接断开、进程退出、权限不足时如何处理

本方案选择 Unix domain socket 作为本机 IPC 方式。它类似本机专用的 socket 文件，不对外暴露 TCP 端口，适合「同一台机器上的多个 Mica 进程互相通信」。

### RPC 是什么

RPC 是 Remote Procedure Call，中文通常叫「远程过程调用」。

如果只有 IPC，两个进程只能互相发送字节，例如一段 JSON 字符串。RPC 在 IPC 之上约定了更高层的调用格式，让调用方可以表达：

```text
我要调用对端的 submit 方法，参数是 { text: "..." }，请返回结果或错误。
```

在这个方案里，RPC 负责定义：

- request：调用哪个方法，例如 `getState`、`attach`、`submit`
- response：这个调用成功还是失败，返回什么数据
- event：不需要请求也会主动推送的状态变化，例如 `text`、`toolCall`、`controlChanged`
- error：错误码、错误信息和可选调试数据

所以可以简单区分：

```text
IPC 关心「消息怎么送到另一个进程」。
RPC 关心「送过去的消息是什么意思」。
```

### Attach 是什么

attach 是「当前终端连接到另一个正在运行的 agent，并把自己的 UI 和输入临时切换到那个 agent」的动作。

attach 不是复制，也不是迁移：

- 不复制 remote agent 的 session
- 不把 remote agent 的 runtime 移到当前进程
- 不在当前进程执行 remote agent 的工具
- 不接管 remote 终端的原生 PTY

attach 后，当前终端更像一个远程控制台：

```text
当前终端负责显示 UI、接收用户输入、发送控制请求。
被 attach 的 agent 进程负责真正运行模型、执行工具、保存 session。
```

### Detach 是什么

detach 是 attach 的反向动作：当前终端释放 remote agent 的控制权，并切回自己原本的 local agent。

detach 后：

- 当前终端恢复自己的会话和 UI
- remote agent 原终端恢复输入能力
- remote agent 的 session、cwd、工具状态仍然留在 remote 进程里

### Takeover 是什么

Takeover 是「强制夺回或转移控制权」。常见场景包括：

- remote agent 原终端不想继续被控制，执行 `/takeover` 夺回控制权
- 第三个终端请求强制接管一个已被控制的 agent
- controller 崩溃或长期失联后，server 释放旧控制权

第一版可以只支持原终端手动 takeover；后续再增加确认式远程 takeover。

### Controller 和 Observer 是什么

Controller 是当前拥有输入控制权的一端。只有 controller 可以：

- submit 普通用户输入
- abort 当前 turn
- 执行 remote-capable slash command
- detach 释放控制权

Observer 是只读观察者。Observer 可以接收状态、流式文本、工具日志等事件，但不能修改 remote agent 状态。

一个 agent 同一时间只能有一个 controller，但可以有多个 observer。

### Snapshot 和 Event Stream 是什么

attach 要解决两个问题：

1. 刚接上时，当前 UI 需要立刻知道 remote agent 的完整状态。
2. 接上之后，当前 UI 需要持续收到后续变化。

因此协议采用「快照 + 增量事件」模式：

```text
attach 成功
  -> 先返回 RuntimeViewSnapshot 完整快照
  -> UI 根据快照一次性渲染当前现场
  -> 后续通过 event stream 持续应用 text/tool/status 等增量事件
```

Snapshot 是某一刻的完整状态，例如历史消息、当前 responseText、tool logs、usage、queue、control 状态。

Event stream 是之后不断发生的小变化，例如新增一段流式文本、工具调用开始、工具调用结束、控制权变化。

### Local Agent、Remote Agent 和 Background Agent 的区别

```text
Local Agent
  当前终端所在进程里的 agent。

Remote Agent
  另一个终端进程里的 agent，需要通过 IPC/RPC attach。

Background Agent
  同一个终端进程内，但当前没有显示在 UI 上的本地 agent。
```

三者的关键差异：

```text
local current agent      当前终端直接控制，不需要 IPC
local background agent   同进程内切换，类似浏览器标签页，不需要 IPC
remote agent             跨进程接管，需要 IPC、RPC、权限校验和 control lock
```

---

## 核心概念

### Agent Process

每一个正在运行的 Mica CLI 进程都是一个 agent process。

它同时拥有：

- agent runtime
- terminal UI
- input controller
- tool execution environment
- session state
- IPC server
- registry heartbeat

### Local Agent

当前终端启动时创建的 agent。

### Remote Agent

通过 IPC 被当前终端 attach 的另一个 agent。

### Controller

拥有某个 agent 输入控制权的一端。

一个 agent 同一时间只能有一个 active controller：

```text
local terminal controller
或
remote terminal controller
```

### Observer

没有输入控制权，只能接收事件并显示状态的一端。

### Attach

一个 agent terminal 连接另一个 agent process，并请求成为它的 controller。

### Detach

controller 主动释放控制权，返回自己的 local agent。

### Takeover

被控 agent 原终端或另一个授权终端强制夺回控制权。

### IPC（进程间通信）

IPC 是 Inter-Process Communication 的缩写，指同一台机器上不同进程之间交换数据的机制。在这个方案中，两个 Mica CLI 进程之间通过 **Unix Socket** 建立 IPC 通道，Terminal A 的 IPC Client 连接到 Terminal B 的 IPC Server，在这条通道上双向传输数据。

可以把 IPC 理解为「电话线」—— 它解决的是两个进程怎么连上、怎么传输字节流的问题。

### RPC（远程过程调用）

RPC 是 Remote Procedure Call 的缩写，是一种让调用方像调用本地函数一样调用远程进程上方法的协议。在这个方案中，IPC 通道之上运行 **JSON-RPC** 协议，定义了请求/响应的标准格式（方法名、参数、返回值、错误码等），让 Terminal A 能够以结构化的方式调用 Terminal B 的能力——比如发送消息、订阅事件流、查询状态快照。

可以把 RPC 理解为「电话里说什么语言、按什么格式对话」—— 它解决的是数据怎么组织、怎么路由到正确的处理函数的问题。

### 两者关系

```text
Terminal A                          Terminal B
┌──────────────┐                   ┌──────────────┐
│ 业务层       │ ←── RPC 调用 ───→ │ 业务层       │
│ (RemoteRuntimeClient)            │ (RuntimeController)
├──────────────┤                   ├──────────────┤
│ JSON-RPC     │ ←── 协议层 ────→ │ JSON-RPC     │
├──────────────┤                   ├──────────────┤
│ Unix Socket  │ ←── 传输层 ────→ │ Unix Socket  │
└──────────────┘                   └──────────────┘
         └────── IPC 通道 ───────────┘
```

IPC 是底层传输通道（Unix Socket），RPC 是上层调用协议（JSON-RPC）。IPC 负责把字节送到对端，RPC 负责把字节解析成有意义的方法调用和返回值。

---

## 用户可见效果

### 查看 agents

```text
/agents
```

展示：

```text
Agents

● current
  agent-a
  pid 12345 · idle · local
  /repo/project-a

○ attachable
  agent-b
  pid 67890 · running · controlled locally
  /repo/project-b
  openai/gpt-4.1 · updated 3s ago

○ controlled
  agent-c
  pid 88888 · streaming · controlled by pid 99999
  /repo/project-c
```

### attach 到运行中的 agent

选择 agent-b 后：

```text
Attached to agent-b
cwd: /repo/project-b
mode: exclusive control
/detach to return
```

当前终端立即渲染 agent-b 的完整状态：

- 历史 conversation messages
- 正在流式输出的 response text
- thinking 内容
- tool call / tool result 日志
- usage / context size
- provider / model
- session 信息
- queue 状态
- working status

之后当前终端输入的普通消息都会发给 agent-b。

### 被接管终端

agent-b 原终端进入只读状态：

```text
Agent is controlled by pid 12345
Readonly mode.
Use /takeover to regain control.
```

原终端仍然可以显示 agent-b 的实时输出，但不能提交普通输入，也不能 abort 或修改状态。

### detach

当前终端输入：

```text
/detach
```

效果：

```text
Detached from agent-b
Returned to local agent-a
```

agent-b 原终端恢复控制权。

### controller 崩溃

如果 controller 终端退出、崩溃或 socket 断开：

- remote agent 自动释放控制锁
- remote agent 原终端恢复控制权
- registry 更新 control 状态

---

## 总体架构

```text
┌────────────────────────────┐
│ Terminal A                 │
│                            │
│ UI                         │
│ ActiveController           │
│  ├─ LocalRuntimeController │
│  └─ RemoteRuntimeClient    │
│ IPC Client                 │
└──────────────┬─────────────┘
               │ Unix Socket / JSON-RPC
               ▼
┌────────────────────────────┐
│ Terminal B / Agent B       │
│                            │
│ IPC Server                 │
│ ControlLock                │
│ RuntimeController          │
│ Agent Runtime              │
│ Tool Runtime               │
│ Session Store              │
│ UI                         │
└────────────────────────────┘
```

关键原则：

1. UI 不直接知道当前控制的是本地还是远程。
2. 所有输入都走 `ActiveController`。
3. `LocalRuntimeController` 直接操作本地 runtime。
4. `RemoteRuntimeClient` 通过 IPC 操作 remote runtime。
5. remote agent 的工具、session、cwd、配置永远留在 remote 进程中。
6. controller 只显示 UI、发送输入、接收事件。

---

## IPC 传输

### 传输方式

使用 Unix domain socket。

路径：

```text
~/.mica/agents/{agentId}.sock
```

原因：

- 本机 IPC 简单可靠
- 不暴露 TCP 端口
- 支持双向长连接
- 可以基于文件系统权限保护
- Node/Bun 可用 `node:net` 实现

### 消息格式

使用 JSON Lines。

每条消息一行：

```json
{"type":"request","id":"1","method":"getState","params":{}}
```

好处：

- 实现简单
- 易调试
- 单连接内天然保序
- 支持 request/response/event 混合

### 消息类型

```ts
type RpcMessage = RpcRequest | RpcResponse | RpcEvent;

type RpcRequest = {
  type: 'request';
  id: string;
  method: string;
  params?: unknown;
};

type RpcResponse = {
  type: 'response';
  id: string;
  result?: unknown;
  error?: RpcError;
};

type RpcEvent = {
  type: 'event';
  event: string;
  seq: number;
  payload?: unknown;
};

type RpcError = {
  code: string;
  message: string;
  data?: unknown;
};
```

### event seq

每个 IPC server 维护递增事件序号：

```ts
let eventSeq = 0;
```

发送事件时：

```ts
send({ type: 'event', event, seq: ++eventSeq, payload });
```

用途：

- 调试事件顺序
- 检测断流
- 未来支持断线重连补事件

---

## Registry 记录

每个 agent process 启动时写入 registry 文件：

```text
~/.mica/agents/{agentId}.json
```

记录结构：

```ts
type AgentRegistryRecord = {
  version: 2;
  id: string;
  pid: number;
  cwd: string;

  providerId: string;
  providerName: string;
  model: string;
  status: string;

  sessionId?: string;
  sessionTitle?: string;

  startedAt: string;
  updatedAt: string;

  ipc: {
    transport: 'unix';
    socketPath: string;
    protocol: 'mica-agent-rpc';
    version: 1;
  };

  capabilities: {
    attach: true;
    exclusiveControl: true;
    observe: true;
    remoteCommands: true;
    takeover: true;
  };

  control: {
    mode: 'local' | 'remote-controlled';
    controllerAgentId?: string;
    controllerPid?: number;
    controllerCwd?: string;
    attachedAt?: string;
  };
};
```

心跳规则：

- 每 10s 更新 `updatedAt`
- status 变化时立即写入
- control 状态变化时立即写入
- 退出时删除 registry 文件和 socket 文件
- 发现 pid 不存在或超过 stale 时间，清理记录

---

## 安全模型

### 文件权限

```text
~/.mica                0700
~/.mica/agents         0700
~/.mica/agents/*.json  0600
~/.mica/agents/*.sock  0600
~/.mica/agents/*.auth  0600
```

### attach token

每个 agent 启动生成随机 token：

```text
~/.mica/agents/{agentId}.auth
```

内容：

```json
{
  "agentId": "agent-b",
  "token": "random-256-bit-token",
  "createdAt": "..."
}
```

连接时 client 必须先 hello：

```ts
type HelloParams = {
  protocol: 'mica-agent-rpc';
  protocolVersion: 1;
  clientAgentId: string;
  clientPid: number;
  clientCwd: string;
  token: string;
};
```

server 校验：

- protocol 是否正确
- version 是否兼容
- token 是否正确
- clientPid 是否活着
- 是否 attach 自己
- 是否允许被 attach

校验失败立即断开。

---

## RuntimeViewSnapshot

attach 的关键是先拿完整快照，再订阅增量事件。

```ts
type RuntimeViewSnapshot = {
  agent: {
    id: string;
    pid: number;
    cwd: string;
    providerId: string;
    providerName: string;
    model: string;
    status: AgentRuntimeStatus;
  };

  session: {
    id?: string;
    title?: string;
    branchId?: string;
    updatedAt?: string;
  };

  conversation: {
    messages: ConversationMessage[];
    responseText: string;
  };

  turn: {
    isRunning: boolean;
    runId: number | null;
    startedAt?: string;
    elapsedMs?: number;
  };

  queue: {
    pending: string[];
    pendingCount: number;
  };

  toolLogs: ToolLogItem[];

  usage: {
    contextSize: number;
    cachedTokenRate: number;
    lastUsage?: UsageRecord;
    usageHistory: UsageRecord[];
  };

  control: {
    mode: 'local' | 'remote-controlled';
    controllerAgentId?: string;
    controllerPid?: number;
    controllerCwd?: string;
    attachedAt?: string;
  };

  capabilities: {
    commands: string[];
    tools: string[];
    canAbort: boolean;
    canSubmit: boolean;
    canTakeover: boolean;
  };
};
```

要求：

- snapshot 必须是可序列化 JSON
- 不包含 API key、环境变量、token 等敏感信息
- responseText 表示当前正在流式输出但尚未落入 messages 的内容
- toolLogs 表示当前 turn 的完整工具日志
- pending queue 可只返回数量；完美版可返回文本，但 UI 默认不展示具体内容

---

## RPC 方法

### hello

建立认证和能力协商。

```ts
hello(params: HelloParams): HelloResult
```

返回：

```ts
type HelloResult = {
  agentId: string;
  protocolVersion: 1;
  serverPid: number;
  capabilities: AgentCapabilities;
};
```

### getState

获取完整快照。

```ts
getState(): RuntimeViewSnapshot
```

### attach

请求 attach。

```ts
type AttachParams = {
  mode: 'control' | 'observe';
  takeover?: boolean;
};
```

返回：

```ts
type AttachResult = {
  attached: boolean;
  mode: 'control' | 'observe';
  snapshot: RuntimeViewSnapshot;
};
```

规则：

- `mode=observe` 不获取控制权，只订阅事件
- `mode=control` 请求独占控制
- 已有 controller 时拒绝，除非 `takeover=true`
- attach 成功后 server 广播 `controlChanged`
- 原终端 UI 进入 readonly

### detach

释放控制权。

```ts
detach(): { detached: true }
```

规则：

- 只有当前 controller 可以 detach
- detach 后 control mode 回到 local
- 原终端恢复输入
- 远端 controller 收到 detached event

### takeover

强制夺回控制权。

```ts
takeover(params: { reason?: string }): { ok: true }
```

常见来源：

- 被控 agent 原终端
- 新的 remote controller

规则：

- 当前 controller 被断开或降级为 observer
- 广播 `controlChanged`
- 发送 `detached` 给旧 controller

### submit

提交普通用户输入。

```ts
submit(params: { text: string }): { accepted: true; queued: boolean }
```

规则：

- 只有 controller 可以 submit
- observer 不允许
- 如果 agent 正在运行，输入进入 remote agent 自己的 queue
- 执行 cwd、tools、session 均属于 remote agent

### abort

中断当前 turn。

```ts
abort(): { aborted: boolean }
```

规则：

- 只有 controller 可以 abort
- 没有 running turn 时返回 `{ aborted: false }`

### runCommand

执行 slash command。

```ts
type RunCommandParams = {
  command: string;
  args: string;
  raw: string;
};
```

返回：

```ts
type RunCommandResult = {
  handled: boolean;
  message?: string;
};
```

规则：

- command 必须在 remote agent 的 command registry 中声明为 remote-capable
- local-only 命令不能远程执行
- 命令产生的 UI 变化通过 event stream 推送

### clear

清空 remote agent 当前会话或 UI，具体语义由 remote command 实现。

```ts
clear(): { ok: true }
```

### ping

健康检查。

```ts
ping(): { pong: true; now: string }
```

---

## 事件定义

### state

完整状态快照。

```ts
{ event: 'state', payload: RuntimeViewSnapshot }
```

用于 attach 后初始渲染，或重大状态变化后重新同步。

### status

agent 状态变化。

```ts
{ event: 'status', payload: AgentRuntimeStatus }
```

### text

assistant 流式文本增量。

```ts
{ event: 'text', payload: { text: string } }
```

### thinking

thinking 流式文本增量。

```ts
{ event: 'thinking', payload: { text: string } }
```

### toolCall

工具调用开始。

```ts
{
  event: 'toolCall',
  payload: {
    id?: string;
    name: string;
    args: string;
  }
}
```

### toolResult

工具调用完成。

```ts
{
  event: 'toolResult',
  payload: {
    id?: string;
    name: string;
    result: string;
  }
}
```

### usage

usage 更新。

```ts
{ event: 'usage', payload: UsageRecord }
```

### conversationChanged

历史消息变化。

```ts
{
  event: 'conversationChanged',
  payload: {
    messages: ConversationMessage[];
    responseText: string;
  }
}
```

### queueChanged

输入队列变化。

```ts
{
  event: 'queueChanged',
  payload: {
    isRunning: boolean;
    pendingCount: number;
  }
}
```

### controlChanged

控制权变化。

```ts
{ event: 'controlChanged', payload: ControlState }
```

### detached

当前连接被解除控制。

```ts
{
  event: 'detached',
  payload: {
    reason: 'client-request' | 'server-shutdown' | 'takeover' | 'connection-lost' | 'permission-revoked';
    message?: string;
  }
}
```

### error

远程错误。

```ts
{
  event: 'error',
  payload: {
    message: string;
    code?: string;
  }
}
```

---

## 控制权状态机

### 状态

```text
LOCAL_CONTROL
REMOTE_CONTROLLED
SHUTTING_DOWN
```

### 转移

```text
LOCAL_CONTROL --attach(control)--> REMOTE_CONTROLLED
REMOTE_CONTROLLED --detach--> LOCAL_CONTROL
REMOTE_CONTROLLED --controller socket close--> LOCAL_CONTROL
REMOTE_CONTROLLED --takeover by local--> LOCAL_CONTROL
REMOTE_CONTROLLED --takeover by another remote--> REMOTE_CONTROLLED(new controller)
ANY --shutdown--> SHUTTING_DOWN
```

### LOCAL_CONTROL

- 本地终端可输入
- remote observe 可连接
- remote control attach 可请求

### REMOTE_CONTROLLED

- 本地终端只读
- controller remote 可 submit/abort/runCommand
- observer 只能看
- 本地可 `/takeover`

### SHUTTING_DOWN

- 拒绝新 attach
- 向所有连接发送 detached
- 删除 socket 和 registry

---

## 输入路由

所有输入先进入 `ActiveController`。

```ts
interface ActiveController {
  kind: 'local' | 'remote';
  submit(text: string): Promise<void>;
  abort(): Promise<void>;
  runCommand(raw: string): Promise<void>;
  detach?(): Promise<void>;
}
```

### 本地模式

```text
terminal input -> LocalRuntimeController.submit -> local runtime
```

### attach 模式

```text
terminal input -> RemoteRuntimeClient.submit -> IPC -> remote runtime
```

### slash command 路由

命令分为三类：

```ts
type CommandScope = 'local-only' | 'remote-capable' | 'remote-only-when-attached';
```

建议：

```text
/agents       local-only
/detach       local-only
/local        local-only
/takeover     local-only 或 remote-capable，根据上下文
/abort        remote-capable
/clear        remote-capable
/model        remote-capable
/provider     remote-capable
/mcp          remote-capable
/resume       remote-capable
/compact      remote-capable
/status       remote-capable
/logs         local-only 或 both，视日志语义决定
```

attach 模式下：

- local-only：本地执行
- remote-capable：RPC 到 remote agent 执行
- unsupported：提示该命令不支持 remote attach

---

## UI 渲染逻辑

UI 有两种数据来源：

```text
LocalRuntimeController events
RemoteRuntimeClient events
```

UI 不应该关心事件来源。

### attach 渲染流程

```text
1. 保存 local UI snapshot
2. 清空当前 UI
3. 渲染 remote RuntimeViewSnapshot
4. 状态栏显示 attached 标识
5. 订阅 remote events
6. 增量更新 UI
```

### detach 渲染流程

```text
1. 取消 remote event subscription
2. 发送 detach RPC
3. 清空 remote UI
4. 恢复 local UI snapshot
5. 状态栏移除 attached 标识
```

### attached 状态栏

建议显示：

```text
attached agent-b · /repo/project-b · openai/gpt-4.1 · running
```

### readonly 状态栏

被控端显示：

```text
controlled by pid 12345 · readonly · /takeover
```

---

## 工具执行语义

remote attach 时，工具永远在 remote agent process 执行。

这包括：

```text
read_file
write_file
edit_file
list_files
grep_search
run_shell
web_fetch
web_search
Skill
MCP tools
```

语义：

```text
cwd = remote agent cwd
env = remote agent env
config = remote agent config
mcp connections = remote agent mcp connections
session = remote agent session
```

controller 不直接执行任何工具。

如果 remote agent 请求需要用户确认的危险操作，确认 UI 应显示在 controller 终端，同时被控端只读显示该请求。

---

## Session 语义

attach 不复制 session，不 fork session，不迁移 session。

规则：

- agent-b 的 session 仍由 agent-b 保存
- agent-a attach agent-b 时，agent-a 不保存 agent-b 的对话
- detach 后 agent-a 恢复自己的 session
- remote command `/resume` 作用于 agent-b
- remote command `/clear` 作用于 agent-b

避免两个进程写同一个 session。

---

## 错误处理

### socket 连接失败

提示：

```text
Unable to attach: agent is no longer reachable
```

然后刷新 `/agents` 列表并清理 stale registry。

### 协议不兼容

提示：

```text
Unable to attach: incompatible protocol version
```

该 agent 仍可展示，但标记为不可 attach。

### 已被控制

提示：

```text
Agent is already controlled by pid 12345
Use takeover? [y/N]
```

### controller 断线

server 自动：

```text
release control -> local control -> broadcast controlChanged
```

client 自动：

```text
show disconnected -> restore local UI
```

### remote agent 退出

client 收到 socket close：

```text
Remote agent exited
Returned to local agent
```

### 大消息保护

每条 JSON line 限制大小，例如：

```text
max message size = 4MB
```

大型 tool result 需要 chunk：

```ts
toolResultChunk
```

或 server 先截断，提供完整结果保存在 remote 日志中。

---

## Backpressure 和性能

### 事件发送队列

每个连接维护发送队列。

如果队列超过阈值：

- observer 连接可以丢弃部分高频 text/thinking 事件，然后发送 state resync
- controller 连接优先保证不丢事件
- 超过硬限制时断开慢客户端

### 高频 text 合并

server 可以在 16ms 或 32ms 窗口内合并 text chunk：

```text
多个 text event -> 一个 text event
```

降低 IPC 压力。

### state resync

当 client 检测 event seq 跳跃或丢失：

```text
request getState -> rerender snapshot -> continue events
```

---

## 断线重连

完美版本支持 controller 临时断线后短时间重连。

机制：

- control lock 有 lease
- controller socket 断开后进入 grace period，例如 5s
- 5s 内同一个 clientAgentId 携带 token 重连，可恢复控制权
- 超时后释放给 local

状态：

```ts
type ControlState =
  | { mode: 'local' }
  | { mode: 'remote-controlled'; controllerAgentId: string; controllerPid: number }
  | { mode: 'reconnect-grace'; controllerAgentId: string; expiresAt: string };
```

如果不需要复杂度，第一版可以不做 grace period，断线立即释放。

---

## 实现模块建议

即使不绑定当前架构，建议按以下逻辑模块实现。

```text
agent-ipc/
  protocol.ts
  jsonLine.ts
  errors.ts
  auth.ts
  AgentIpcServer.ts
  AgentIpcClient.ts
  AgentRegistry.ts
  ControlLock.ts
  RuntimeViewSnapshot.ts

runtime-control/
  RuntimeController.ts
  LocalRuntimeController.ts
  RemoteRuntimeController.ts
  ActiveController.ts

ui-attach/
  renderSnapshot.ts
  applyRemoteEvent.ts
  AttachStatusBar.ts
  ReadonlyOverlay.ts
```

### protocol.ts

定义所有 request/response/event 类型。

### jsonLine.ts

负责：

- encode
- decode
- split line
- max message size
- parse error handling

### auth.ts

负责：

- token 生成
- token 读取
- token 校验
- 文件权限设置

### AgentIpcServer

职责：

- 创建 socket
- 接收连接
- hello 鉴权
- request dispatch
- event broadcast
- 连接生命周期管理

### AgentIpcClient

职责：

- 连接 socket
- hello
- request/response promise map
- event emitter
- reconnect/close

### ControlLock

职责：

- acquire control
- release control
- takeover
- 判断当前连接是否 controller
- socket close 自动释放

### RuntimeController

职责：

- submit
- abort
- runCommand
- getSnapshot
- subscribe runtime events

### ActiveController

职责：

- 当前 UI 输入路由
- local/remote controller 切换
- attach/detach 生命周期

---

## Attach 详细流程

```text
用户在 agent-a 输入 /agents
  -> 读取 registry
  -> 展示 attachable agents
  -> 用户选择 agent-b
  -> 读取 agent-b auth token
  -> 创建 AgentIpcClient
  -> connect agent-b socket
  -> hello
  -> attach({ mode: 'control' })
```

agent-b server：

```text
收到 attach
  -> 校验连接已 hello
  -> 校验没有 active controller
  -> ControlLock.acquire
  -> 本地 UI 进入 readonly
  -> 更新 registry control 状态
  -> 创建 RuntimeViewSnapshot
  -> 返回 AttachResult(snapshot)
  -> 向所有连接广播 controlChanged
```

agent-a client：

```text
收到 AttachResult
  -> 保存 local UI snapshot
  -> 设置 ActiveController = RemoteRuntimeController(agent-b)
  -> 清空当前 UI
  -> renderSnapshot(snapshot)
  -> 状态栏显示 attached
  -> 开始处理 event stream
```

---

## Submit 详细流程

```text
agent-a terminal 输入普通文本
  -> ActiveController.submit(text)
  -> RemoteRuntimeController.submit(text)
  -> RPC submit
```

agent-b server：

```text
收到 submit
  -> 校验该连接是 controller
  -> 调用本地 RuntimeController.submit(text)
  -> 如果 running，进入本地 queue
  -> 返回 accepted
```

agent-b runtime 后续产生：

```text
status/text/thinking/toolCall/toolResult/usage/conversationChanged
```

server 广播给：

- controller agent-a
- 本地 UI agent-b
- observers

---

## Detach 详细流程

agent-a：

```text
/detach
  -> RPC detach
  -> close subscription
  -> ActiveController = LocalRuntimeController
  -> 清空 remote UI
  -> 恢复 local UI snapshot
```

agent-b：

```text
收到 detach
  -> 校验 controller
  -> ControlLock.release
  -> 本地 UI 退出 readonly
  -> 更新 registry
  -> 广播 controlChanged
```

---

## Takeover 详细流程

agent-b 原终端：

```text
/takeover
  -> ControlLock.takeover(local)
  -> 断开或降级 remote controller
  -> 本地 UI 恢复输入
  -> 广播 controlChanged
```

agent-a 收到：

```text
detached(reason='takeover')
  -> 显示提示
  -> 恢复 local UI
```

---

## 测试计划

### 单元测试

- JSON line parser
- RPC request/response 匹配
- auth token 校验
- registry stale 清理
- ControlLock 状态机
- command scope 路由
- RuntimeViewSnapshot 序列化

### 集成测试

启动两个 agent process：

1. agent-a list agents 能看到 agent-b
2. agent-a attach agent-b 成功
3. agent-b 原终端进入 readonly
4. agent-a submit，agent-b runtime 收到输入
5. agent-b streaming，agent-a 能实时显示
6. agent-a abort，agent-b 中断
7. agent-a detach，agent-b 恢复 local control
8. agent-a 崩溃，agent-b 自动恢复
9. agent-b 崩溃，agent-a 自动回本地
10. 第三个 agent attach 已被控制的 agent 时被拒绝
11. takeover 能踢掉旧 controller
12. remote command 在 remote agent 执行

### 安全测试

- token 错误拒绝连接
- protocol version 不兼容拒绝连接
- 非 controller submit 被拒绝
- observer abort 被拒绝
- socket 文件权限正确
- registry 不泄露 token/api key/env

### 压力测试

- 大量 text chunks
- 大 tool result
- 慢 observer
- 多 observer 同时订阅
- controller 快速 attach/detach
- remote agent running 时 attach

---

## 分阶段实现建议

### Phase 1：IPC 基础

完成：

- registry v2
- socket server/client
- hello/ping/getState
- auth token

验收：

- 一个 agent 能连接另一个 agent
- 能拿到 RuntimeViewSnapshot

### Phase 2：Attach 只读

完成：

- observe attach
- state 渲染
- event stream

验收：

- agent-a 可以实时观看 agent-b 输出
- 不允许输入控制

### Phase 3：独占控制

完成：

- control lock
- attach control
- submit/abort
- readonly mode
- detach

验收：

- agent-a 可完整控制 agent-b
- agent-b 原终端只读
- detach 后恢复

### Phase 4：Remote command

完成：

- command scope
- runCommand RPC
- remote-capable commands

验收：

- attach 模式下 `/model`、`/clear`、`/status` 等作用于 remote agent

### Phase 5：稳定性

完成：

- takeover
- 断线恢复
- backpressure
- state resync
- 大消息 chunk

验收：

- 崩溃、断线、慢客户端、大输出都不会破坏 agent 状态

---

## 同终端本地 Background Agents

除了跨终端 IPC attach，还需要支持同一个终端内创建多个独立 agent session。

该能力用于以下场景：

```text
当前 agent 正在回答问题 A，用户马上想问问题 B。
用户执行 /new 问题 B，系统在当前终端内创建一个新的独立 session/agent。
问题 A 对应的 agent 不被中断，继续作为 background agent 运行。
用户可以通过 /agents 切换回问题 A 对应的 agent。
```

这个能力不需要 IPC。它发生在同一个进程、同一个终端 UI 中。

---

### 目标效果

用户在当前终端中输入：

```text
> 分析一下这个 bug
```

agent-1 开始运行。

用户马上输入：

```text
/new 帮我设计一下 todo 系统
```

系统执行：

```text
1. 创建 agent-2
2. 创建 agent-2 的独立 session
3. 当前 UI 切换到 agent-2
4. agent-2 立即处理 prompt：帮我设计一下 todo 系统
5. agent-1 继续在后台运行
```

此时 `/agents` 展示：

```text
Agents

Local agents

● agent-2  current · running
  todo 系统设计
  session: session-b
  cwd: /repo/project

○ agent-1  background · running
  分析 bug
  session: session-a
  updated 12s ago

Remote agents

○ pid 67890 · idle · attachable
  /repo/other-project
```

选择 `agent-1` 后：

```text
Switched to agent-1
```

当前 UI 立即恢复 agent-1 的完整状态：

- 历史 conversation
- 当前 responseText
- 当前 thinking
- 当前 tool logs
- 当前 status
- usage/context size
- pending queue

如果 agent-1 还在 streaming，切回来后可以继续看到流式输出。

---

### `/new` 命令语义

```text
/new
```

创建一个空的新 local agent session，并切换过去。

```text
/new <prompt>
```

创建一个新的 local agent session，切换过去，并立即提交 prompt。

等价流程：

```text
create local agent
switch to new agent
submit prompt to new agent
```

`/new` 不影响原 active agent：

- 不 abort
- 不 clear
- 不复用 session
- 不抢占原 agent 的 queue
- 原 agent 继续作为 background agent 运行

---

### Local Agent 与 Remote Agent 的统一模型

`/agents` 应成为统一 agent switcher。

它展示两类 agent：

```ts
type AgentEntry = LocalAgentEntry | RemoteAgentEntry;

type LocalAgentEntry = {
  scope: 'local';
  id: string;
  title: string;
  sessionId: string;
  cwd: string;
  status: string;
  active: boolean;
  background: boolean;
  updatedAt: string;
  action: 'switch';
};

type RemoteAgentEntry = {
  scope: 'remote';
  id: string;
  pid: number;
  cwd: string;
  status: string;
  updatedAt: string;
  action: 'attach';
};
```

行为：

```text
选择 local current agent      -> 保持当前或关闭面板
选择 local background agent   -> switch
选择 remote process agent     -> attach
```

用户不需要理解底层差异：

```text
/agents 看到的是所有可以切换或接管的 agent。
```

---

### AgentManager

同终端多 agent 由 `AgentManager` 管理。

```ts
type LocalAgentInstance = {
  id: string;
  title: string;

  sessionId: string;
  cwd: string;

  runtime: AgentRuntime;
  queue: MessageQueue;
  toolLogs: ToolLogController;
  sessionController: SessionController;

  viewState: AgentViewState;

  status: AgentRuntimeStatus;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
};
```

核心状态：

```ts
class AgentManager {
  agents: Map<string, LocalAgentInstance>;
  activeAgentId: string;

  createAgent(options: CreateAgentOptions): LocalAgentInstance;
  switchAgent(agentId: string): void;
  closeAgent(agentId: string): void;
  killAgent(agentId: string): void;

  submitToActive(text: string): Promise<void>;
  abortActive(): void;

  listLocalAgents(): LocalAgentEntry[];
}
```

每个 local agent 都是独立的：

```text
独立 AgentRuntime
独立 SessionController
独立 MessageQueue
独立 ToolLogController
独立 AgentViewState
独立 sessionId
```

可以共享：

```text
provider/model config
cwd
工具注册表
MCP 连接策略，按后续实现决定共享或隔离
```

建议第一版：

```text
每个 local agent 独立 runtime/session/queue/viewState。
共享全局配置和 cwd。
```

---

### AgentViewState

每个 local agent 必须保存自己的 UI 状态。

```ts
type AgentViewState = {
  conversationMessages: ConversationMessage[];
  responseText: string;

  status: AgentRuntimeStatus;

  toolLogs: ToolLogItem[];

  contextSize: number;
  cachedTokenRate: number;

  isRunning: boolean;
  pendingCount: number;

  lastUsage?: UsageRecord;
  usageHistory: UsageRecord[];
};
```

规则：

```text
active agent 的事件：
  更新自身 viewState
  同步渲染当前 UI

background agent 的事件：
  只更新自身 viewState
  不直接改当前 UI
  必要时显示全局通知
```

这样 background agent 继续运行时，不会污染当前正在查看的 agent UI。

---

### `/new` 实现流程

```text
用户输入 /new <prompt>
```

执行：

```text
1. AgentManager.createAgent()
2. 为新 agent 创建独立 sessionId
3. 创建 runtime/queue/toolLogs/sessionController/viewState
4. 注册 runtime event listeners
5. capture 当前 active agent 的 viewState
6. activeAgentId = newAgent.id
7. 清空当前 UI
8. render newAgent.viewState
9. 如果存在 prompt，submitToActive(prompt)
```

伪代码：

```ts
async function handleNewCommand(prompt?: string) {
  const agent = agentManager.createAgent({
    title: inferAgentTitle(prompt),
    cwd: process.cwd(),
  });

  agentManager.switchAgent(agent.id);

  if (prompt?.trim()) {
    await agentManager.submitToActive(prompt);
  }
}
```

---

### `/agents` 切换 local background agent

当用户在 `/agents` 中选择 local background agent：

```text
1. capture 当前 active agent 的 UI/viewState
2. activeAgentId = targetAgent.id
3. 清空当前 UI
4. render targetAgent.viewState
5. 更新状态栏 current agent 信息
6. 输入框后续 submit 到 targetAgent
```

伪代码：

```ts
function switchLocalAgent(agentId: string) {
  agentManager.captureActiveViewState();
  agentManager.setActiveAgent(agentId);
  renderAgentViewState(agentManager.getActiveAgent().viewState);
}
```

切换不影响任何 agent 的运行：

```text
正在运行的 agent 继续运行
idle agent 保持 idle
queued messages 保持在各自 queue 中
```

---

### Background Agent 事件处理

每个 local agent 的 runtime event 都进入统一分发器。

```ts
function onAgentEvent(agentId: string, event: AgentEvent) {
  const agent = agentManager.get(agentId);
  updateViewState(agent.viewState, event);
  agent.updatedAt = new Date().toISOString();

  if (agentId === agentManager.activeAgentId) {
    applyEventToUI(event);
    return;
  }

  maybeNotifyBackgroundAgent(agent, event);
}
```

通知规则：

```text
background agent completed -> 显示 completed 通知
background agent failed    -> 显示 failed 通知
background agent needs permission -> 显示 needs permission 通知
background agent streaming -> 默认不打扰，最多更新 /agents 状态
```

---

### 权限确认语义

background agent 如果遇到需要用户确认的操作，不应该静默继续。

推荐规则：

```text
background agent 请求危险操作确认
  -> 暂停该 agent
  -> 记录 permission request 到该 agent.viewState
  -> 当前 UI 显示全局通知
  -> 用户通过 /agents 切换到该 agent
  -> 在该 agent 的 UI 中 approve/reject
```

通知示例：

```text
agent-1 needs permission for run_shell
Use /agents to switch back
```

第一版不需要在当前 agent UI 中直接审批 background agent，避免上下文混淆。

---

### Session 语义

每个 `/new` 都创建独立 session。

```text
agent-1 -> session-a
agent-2 -> session-b
agent-3 -> session-c
```

规则：

- local agents 不共享 messages
- local agents 不共享 responseText
- local agents 不共享 pending queue
- local agents 不共享 session snapshot
- 切换 agent 不触发 session merge
- close agent 前保存该 agent 的 session

`/resume` 的语义需要明确：

```text
普通模式下 /resume：作用于当前 active local agent。
/agents 选择历史 session：可以创建一个新的 local agent 并 load session。
```

---

### 关闭与中止

建议提供：

```text
/agent close <id>
/agent kill <id>
```

语义：

```text
close idle agent:
  保存 session
  从 AgentManager 移除

close running agent:
  需要确认，或提示先 kill

kill running agent:
  abort runtime
  保存 partial session
  标记 killed
```

如果关闭 active agent：

```text
1. 如果还有其他 local agent，切换到最近活跃的 agent
2. 否则创建一个新的空 agent
```

---

### 与 IPC Attach 的关系

同终端 local background agent 与跨终端 remote attach 是同一个 `/agents` 入口下的两种动作。

```text
local background agent:
  switch，不需要 IPC，不需要 control lock

remote process agent:
  attach，需要 IPC，需要 control lock
```

统一选择逻辑：

```ts
async function selectAgent(entry: AgentEntry) {
  if (entry.scope === 'local') {
    agentManager.switchAgent(entry.id);
    return;
  }

  if (entry.scope === 'remote') {
    await attachRemoteAgent(entry.id);
  }
}
```

最终 `/agents` 是：

```text
本终端内 local agents 的 switcher
+
其他终端 remote agents 的 attach browser
```

---

### 本地多 Agent 风险

#### 工具并发冲突

多个 local agents 共享同一个 cwd，可能同时修改同一个文件。

风险：

```text
agent-1 edit src/a.ts
agent-2 edit src/a.ts
```

缓解：

- 工具层保留文件修改历史
- edit/write 前检查文件是否发生外部变化
- 对写操作加 per-file lock
- 在冲突时暂停其中一个 agent 并提示用户

#### 用户上下文混淆

用户必须始终知道当前 active agent。

UI 必须显著显示：

```text
current: agent-2 · session-b · running
```

#### 后台权限请求

后台 agent 不能弹出和当前 agent 混在一起的确认框。

必须关联到对应 agent，并要求用户切换过去处理。

#### 内存占用

多个 runtime 保留多份 messages 和 tool logs。

需要支持：

```text
/agent close
/agent compact
/agent archive
```

#### session 保存

每个 local agent 独立保存自己的 session，避免互相覆盖。

---

### 本地多 Agent 测试计划

#### 单元测试

- AgentManager create/switch/close
- activeAgentId 切换
- 每个 agent 独立 queue
- 每个 agent 独立 viewState
- background event 不污染 active UI
- `/new <prompt>` 创建并提交
- `/agents` local entry 选择触发 switch

#### 集成测试

1. 启动默认 agent-1
2. agent-1 submit 后保持 running
3. 执行 `/new hello`
4. 创建 agent-2 并切换到 agent-2
5. agent-1 继续在后台运行
6. `/agents` 展示 agent-1 background、agent-2 current
7. 选择 agent-1 后恢复 agent-1 UI
8. agent-1 streaming 可以继续显示
9. 切回 agent-2 后恢复 agent-2 UI
10. close idle background agent 成功
11. kill running background agent 成功
12. 每个 agent 保存到不同 session

---

### 本地多 Agent 分阶段实现

#### Phase Local 1：AgentManager 基础

完成：

- LocalAgentInstance
- AgentManager
- activeAgentId
- 默认启动创建 main local agent

验收：

- 可以创建多个 local agent
- 可以列出 local agents

#### Phase Local 2：`/new`

完成：

- `/new [prompt]` 命令
- 创建独立 session
- 切换 active agent
- prompt 自动提交

验收：

- 当前 agent running 时执行 `/new` 不会中断原 agent
- 新 agent 独立运行

#### Phase Local 3：ViewState 隔离

完成：

- 每个 agent 独立 viewState
- background event 只更新 background viewState
- active event 渲染 UI

验收：

- 多个 agent streaming 不互相污染 UI
- 切换后能恢复完整 UI 状态

#### Phase Local 4：`/agents` local switch

完成：

- `/agents` 合并展示 local agents
- 选择 local background agent 触发 switch
- 状态栏显示 current agent

验收：

- `/agents` 可以切回之前的 background agent
- 切换不影响任何 agent 的运行

#### Phase Local 5：关闭、权限与稳定性

完成：

- `/agent close`
- `/agent kill`
- background permission notification
- per-session save
- 写操作冲突保护

验收：

- running/idle/failed agents 都能安全管理
- session 不互相覆盖
- 后台危险操作不会静默执行



完美版本也不应该做这些：

- 不跨机器 attach
- 不把 remote agent runtime 迁移到当前进程
- 不接管 remote 终端的原生 PTY
- 不让 controller 本地执行 remote 工具
- 不让两个 controller 同时控制同一个 agent
- 不把 remote session 复制到 local session

---

## 最终定义

实现完成后，`/agents` 是一个真正的统一 agent switcher。

用户可以：

```text
在同一个终端内通过 /new 创建新的独立 local agent session；原 agent 继续在后台运行；/agents 可以展示这些 local background agents，并随时切换回来继续查看和对话。
```

用户也可以：

```text
在任意 Mica 终端中查看其他终端里运行的 remote process agents；选择一个 remote agent 后实时 attach；当前终端立即呈现目标 agent 的完整 UI 状态；后续输入、命令、abort 都作用于目标 agent；目标 agent 原终端进入只读；detach、takeover、断线和退出都能安全恢复控制权。
```

一句话：

```text
/agents 同时是本终端 local background agents 的 switcher，也是其他终端 remote agents 的 attach browser。
```

更形象地说：

```text
同终端像浏览器标签页一样切换多个独立 agent session；跨终端像 tmux attach-session 一样 attach 到另一个 Mica agent runtime。
```
