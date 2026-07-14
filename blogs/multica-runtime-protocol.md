# Agent Runtime 协议：Mica 为什么选择 DevEco

> 本文是 [mica-code](https://github.com/qirong77/mica-code) 系列文章之一。mica-code 是一个从零搭建的 CLI code agent，基于 Bun + TypeScript + React（Ink）+ Anthropic SDK，目标是搞清楚 Claude Code 这类工具底层到底怎么工作。

把 Mica 接进 Multica，最开始看起来只是一个进程启动问题。

Multica 拿到任务，执行：

```bash
mica-code "fix the failing tests"
```

Mica 完成任务，退出。事情似乎就结束了。

但 Multica 不是一个 Shell 脚本，它是调度平台。任务执行期间，它需要回答一连串问题：Agent 启动成功了吗？现在还在思考，还是已经卡死？这段输出是给用户看的文本，还是工具日志？调用了哪个工具？消耗了多少 Token？用户取消任务后，模型请求和子进程真的停了吗？下一轮任务怎样接着当前会话继续？

只会启动一个命令，回答不了这些问题。

真正需要的不是“找到 Mica 可执行文件”，而是让 Multica 和 Mica 对一次 Agent 运行形成共同理解。这个共同理解，就是 **Agent Runtime 协议**。

这篇记录 Mica 接入 Multica 时的协议选型：为什么需要 Runtime 协议，Claude stream-json、Codex app-server、ACP 和 DevEco/OpenCode run JSON 有什么区别，以及为什么当前最终选择了 Multica 的 `deveco` protocol family。

---

## 一、能启动，不等于能调度

假设没有任何协议，Multica 只能把 Mica 当成一个普通子进程：

```text
spawn mica-code
      │
      ├── stdout: 一些文本
      ├── stderr: 一些错误
      └── exit code: 0 或非 0
```

对于 `ls`、`git status` 这样的命令，这已经够了。但 Agent 不是一次普通命令。

一个 Code Agent 可能连续经历：

```text
理解任务
  ↓
读取文件
  ↓
输出一段解释
  ↓
执行测试
  ↓
继续调用模型
  ↓
修改代码
  ↓
再次测试
  ↓
保存会话
```

如果所有内容都只是普通 stdout，Multica 无法区分：

- 哪些是 Assistant 的最终回答；
- 哪些是工具调用；
- 哪些是工具返回结果；
- 哪些只是运行时诊断；
- 哪个事件代表任务已经完成；
- 当前执行能否恢复。

更麻烦的是，Mica 原本是交互式终端应用。Ink 会控制终端刷新，输出中可能包含 ANSI 转义序列、状态栏、临时动画和重绘内容。这些内容对坐在终端前的人有意义，对上游 parser 没有稳定语义。

所以接入调度平台时，不能把 TUI 输出原样转发。需要为机器消费者提供另一条稳定边界：

```text
人类交互模式：TUI
机器运行模式：结构化 Runtime Protocol
```

### 1.1 Runtime 协议至少要约定什么

一套可用的 Agent Runtime 协议，至少需要回答五类问题。

第一类是启动：

- Prompt 通过 argv 还是 stdin 传入？
- 工作目录怎样指定？
- 模型、推理强度和权限模式怎样覆盖？
- 如何恢复已有 Session？

第二类是事件：

- 如何表示 Agent 开始运行？
- 文本、工具调用、工具结果和错误分别是什么消息？
- Token Usage 放在哪个事件中？

第三类是状态：

- 什么叫成功？
- 什么叫失败？
- 什么叫取消？
- JSON 中的状态和进程退出码冲突时，以谁为准？

第四类是生命周期：

- SIGTERM 到来时，正在进行的模型请求是否会停止？
- Shell、MCP 和子 Agent 是否收到同一个取消信号？
- 父进程退出前，后台资源是否清理完毕？

第五类是输出通道：

```text
stdout = 协议数据
stderr = 人类可读诊断
```

如果 stdout 约定每行是一个 JSON，那么哪怕混进一句 `loading config...`，上游解析器也可能直接失败。

这也是这次改造最重要的认识：

> JSON 只是一种编码格式。消息类型、字段语义、状态机和进程生命周期都确定下来之后，它才是一套协议。

### 1.2 不要把 Runtime 协议和 MCP 混在一起

Mica 接入 Multica 后，系统里同时存在好几层协议：

```text
Multica Server
      │
      │ HTTP / WebSocket：任务分发与状态上报
      ▼
Multica Daemon
      │
      │ Runtime Protocol：启动、事件、取消、Session
      ▼
     Mica
      │
      ├── Provider API：与模型通信
      └── MCP：连接外部工具服务
```

MCP 解决的是“Agent 如何连接外部工具”，Runtime 协议解决的是“调度平台如何管理 Agent”。MCP 可以出现在一次 Runtime 执行内部，但它不能替代 Runtime 协议。

---

## 二、四种候选协议

Multica 已经支持多种 Agent backend。对 Mica 来说，真正的问题不是“能不能自己发明一套 JSON”，而是应该兼容哪一套已有契约。

这次主要比较了四个方向：Claude stream-json、Codex app-server、ACP，以及 DevEco/OpenCode 风格的 run JSON。

### 2.1 Claude stream-json：能力完整，但不是“输出几行 JSON”

Claude Code 的 headless 模式提供 `stream-json`。表面看，它和 Mica 需要的东西很像：都是 CLI，都输出 NDJSON，都包含文本、工具和 Session。

但继续看 Claude Code 的实现会发现，它不是简单的单向日志格式，而是一套双向 SDK 协议：

```text
调用方                          Claude Code
  │                                 │
  ├──── user message ──────────────►│
  │                                 │
  │◄──── system / assistant ────────┤
  │◄──── control_request ───────────┤
  ├──── control_response ──────────►│
  │◄──── user(tool_result) ─────────┤
  │◄──── result ────────────────────┤
```

它要处理的不只是输出，还包括：

- stdin 消息循环；
- `system`、`assistant`、`user`、`result` 等 envelope；
- 权限请求和响应；
- MCP 控制消息；
- 部分消息与完整消息；
- Session 初始化和恢复；
- Runtime 配置更新。

这套协议的优点是能力完整。调用方可以在 Agent 运行期间继续和它交互，Agent 也能暂停等待权限决策。

问题是，Mica 当前没有完全对应的控制状态机。为了“兼容 Claude”，只实现几个同名 JSON 字段不够；那只是长得像，真正遇到权限、MCP 或多轮输入时仍会失效。

Claude Code 的源码依然非常有参考价值。这次 Mica 对严格 stdout、Session 优先初始化、取消传播和资源清理的处理，都参考了它的工程思路。但参考设计不等于复制 wire protocol。

### 2.2 Codex app-server：把 Agent 变成常驻服务

Codex app-server 采用的是另一种模型：长期运行的 JSON-RPC 服务。

它的核心抽象更接近：

```text
initialize
thread/start
turn/start
turn/cancel
thread/resume
```

这种设计把 Thread 和 Turn 分得很清楚。一个进程可以服务多个回合，不需要每个任务重新启动；取消、审批和状态更新也有正式的 RPC 方法。

但 Mica 当前的生命周期是：

```text
启动 CLI
  ↓
执行一轮任务
  ↓
保存 Session
  ↓
退出
```

如果选择 app-server，就不只是增加一个输出格式，而是要把 Mica 改造成常驻服务：实现 JSON-RPC request ID、响应、通知、Thread 管理和进程级并发。

这可能是未来的能力，但对“先稳定接入 Multica”来说，改造范围太大。

### 2.3 ACP：更标准的长期方向

ACP（Agent Client Protocol）同样基于 JSON-RPC，目标是让编辑器、客户端和不同 Agent 之间使用统一接口。

它通常包括：

```text
initialize
session/new
session/load
session/prompt
session/cancel
```

ACP 的优势很明确：

- 不绑定某一家 Agent；
- 有能力协商；
- Session 和取消是一等概念；
- 更适合作为长期公共边界。

但在当前项目里，Mica 还不是 ACP Server，Multica 也没有现成的原生 Mica 接入。选择 ACP 意味着两侧同时改造。

如果目标是设计未来统一的 Agent 平台，ACP 很有吸引力；如果目标是以最小改动先跑通 Mica，它不是最短路径。

### 2.4 DevEco/OpenCode run JSON：一轮任务，一个进程

Multica 的 `deveco` protocol family 使用一种更简单的进程模型：

```bash
agent run --format json [options] "prompt"
```

Prompt 和运行参数通过 argv 传入，Agent 在 stdout 上输出一行一个 JSON 事件，完成后退出。

它的核心事件只有几类：

```text
step_start
text
tool_use
error
step_finish
```

没有常驻 RPC Server，没有 request ID，也没有双向 control message。一次任务对应一个进程，Session 通过命令行参数恢复。

这里说的“DevEco 协议”，特指 Multica 中 `protocol_family=deveco` 所实现的这份进程契约。它的事件形状与 OpenCode 的 `run --format json` 很接近，因此也可以把它理解为 DevEco/OpenCode 风格的 run JSON，而不是一个覆盖所有 Agent 能力的行业标准。

### 2.5 放在一起比较

| 维度                     | DevEco/OpenCode | Claude stream-json | Codex app-server | ACP                         |
| ------------------------ | --------------- | ------------------ | ---------------- | --------------------------- |
| 通信模型                 | 单次子进程      | 双向流             | 常驻 JSON-RPC    | 常驻 JSON-RPC               |
| Prompt 输入              | argv            | stdin message      | RPC request      | RPC request                 |
| 过程输出                 | stdout NDJSON   | stdout NDJSON      | RPC notification | RPC notification            |
| Session                  | `--session`     | resume + SDK 消息  | thread           | session                     |
| 取消                     | OS signal       | control + signal   | RPC cancel       | RPC cancel                  |
| 权限协商                 | 弱              | 完整               | 较完整           | 可协商                      |
| 实现复杂度               | 低              | 中高               | 高               | 高                          |
| 与当前 Mica 匹配度       | 高              | 中                 | 低               | 中低                        |
| Multica 是否已有 backend | 是              | 是                 | 是               | 有 ACP 支持，但 Mica 未实现 |

能力最多的协议不一定是当前最合适的协议。协议选型还要考虑已有架构、两侧改造成本和这次真正需要解决的问题。

---

## 三、为什么最终选择 DevEco

这次选型的目标不是找到“最先进”的协议，而是在几个明确约束下找到最合适的边界：

1. 尽量不修改 Multica Server 和 Daemon；
2. 不把 Mica 改造成常驻服务；
3. 能表达文本、工具、错误、Usage 和 Session；
4. 取消后能够完整清理资源；
5. 后续仍然保留演进到 ACP 的空间。

在这些约束下，DevEco 的优势很直接。

### 3.1 Multica 已经有完整 backend

Multica 的 DevEco backend 已经负责：

- 组装 `run --format json`；
- 传入工作目录、模型、推理强度和 Session；
- 读取 stdout NDJSON；
- 区分文本、工具、错误和 Usage；
- 根据退出状态生成任务结果。

Mica 只需要实现协议的另一端，不需要在 Multica 里新增 parser 和任务状态机。

最终形成的关系是：

```text
Multica devecoBackend
          │
          │ run --format json
          ▼
      mica-code
```

### 3.2 它和 Mica 的生命周期一致

Mica 已经是一轮任务一个进程。DevEco 也是一轮任务一个进程。

两边天然可以对齐：

```text
Multica 创建任务
  ↓
启动 Mica 进程
  ↓
Mica 创建或恢复 Session
  ↓
流式输出事件
  ↓
保存 Session
  ↓
进程退出
```

不需要把 AgentRuntime 提升为 daemon，也不需要在内部增加 Thread Server。

### 3.3 它已经覆盖当前核心需求

这次接入真正需要的是：

```text
开始运行
Assistant 文本
工具调用和结果
错误
Token Usage
Session ID
结束状态
```

DevEco 的几个事件已经能承载这些信息。它没有 Claude SDK 那么完整，但当前缺少的高级能力，并不是跑通调度的前置条件。

### 3.4 不需要伪装成 Claude Code

Mica 内部确实参考了很多 Claude Code 的设计，但“参考 Claude Code”和“实现 Claude Code 协议”是两回事。

如果把 Mica 注册为 `claude`，就意味着 Multica 有理由期待所有 Claude 行为：双向输入、权限控制、control request、MCP 控制和精确的 result subtype。只实现一个近似输出，会把协议不完整的问题推迟到运行时暴露。

选择 `deveco` 的好处是，声明的能力和实际实现一致。

### 3.5 它是当前成本和能力的平衡点

可以把最终选择总结成一句话：

> ACP 更适合作为长期标准，Claude stream-json 更适合完整 Claude SDK 场景，而 DevEco/OpenCode run JSON 最适合当前“一轮一个进程”的 Mica。

---

## 四、最终协议长什么样

Mica 对 Multica 暴露三类入口。

第一类是版本探测：

```bash
mica-code --version
```

第二类是模型发现：

```bash
mica-code models
```

输出一行一个模型：

```text
deepseek/deepseek-chat
openrouter/openai/gpt-5
```

第三类是真正执行任务：

```bash
mica-code run \
  --format json \
  --dangerously-skip-permissions \
  --dir /work/task \
  --model openrouter/openai/gpt-5 \
  --session session-id \
  "fix the failing tests"
```

运行期间，stdout 输出 NDJSON：

```json
{"type":"step_start","sessionID":"session-id","part":{"type":"step-start"}}
{"type":"text","sessionID":"session-id","part":{"type":"text","text":"I will inspect the tests."}}
{"type":"tool_use","sessionID":"session-id","part":{"type":"tool","tool":"run_shell","callID":"call-1","state":{"status":"completed","input":{"command":"bun test"},"output":"..."}}}
{"type":"step_finish","sessionID":"session-id","part":{"type":"step-finish","reason":"completed","tokens":{"input":1200,"output":300,"cache":{"read":400,"write":0}}}}
```

协议还约定：

- stdout 只承载 JSON；
- stderr 承载诊断；
- 一行只能有一个完整事件；
- 成功退出码是 `0`；
- 失败退出码是 `1`；
- 取消退出码是 `130`；
- Session 创建后，事件使用同一个 `sessionID`。

### 4.1 协议兼容不等于自动发现

Mica 实现 DevEco 协议之后，Multica 仍然不会仅凭 `mica-code` 这个命令名自动判断它支持 DevEco。

Multica 的自动发现不是能力协商，也不会扫描 PATH 中所有程序并试探协议。内置 Agent 依赖硬编码命令名；对于 Mica，需要通过 Custom Runtime Profile 明确声明：

```bash
multica runtime profile create \
  --protocol-family deveco \
  --command-name mica-code \
  --display-name "Mica Code"
```

两个字段分别回答两个不同问题：

```text
command_name     = 启动谁
protocol_family  = 怎样和它通信
```

所以当前实际组合是：

```text
Executable：mica-code
Backend：   devecoBackend
Protocol：  DevEco/OpenCode run JSON
```

协议解决的是“发现后怎么说话”，Runtime Profile 解决的是“Multica 怎么知道该用哪种方式和 Mica 说话”。

---

## 五、Mica 做了哪些改造

实现这套协议，并不是在现有 TUI 后面加几行 `JSON.stringify`。真正的改造集中在几个运行时边界上。

### 5.1 在加载 TUI 前划分进程模式

Mica 现在会先解析命令行，再决定进入哪种模式：

```text
无参数             → 交互式 TUI
--version          → 版本探测后退出
models             → 输出模型列表后退出
run --format json  → Headless Runtime
```

这个判断发生在加载 UI 和 AgentRuntime 之前。尤其是 `--dir`，必须先切换工作目录，再加载配置、项目指令和 Skills，否则 Agent 看到的仍然是 daemon 的启动目录。

### 5.2 增加协议投影层

Mica 内部已经有自己的事件：

```text
text
thinking
toolCall
toolResult
usage
```

这些事件不应该直接绑定 Multica schema。因此新增了一层 projector：它订阅 AgentRuntime 事件，再转换成 `text`、`tool_use` 和 `step_finish`。

```text
AgentRuntime events
        │
        ▼
RunJsonProjector
        │
        ▼
Multica DevEco NDJSON
```

这样交互式 UI、未来 ACP adapter 和当前 DevEco adapter 可以共享同一个 AgentRuntime，而不需要把某个上游协议写进核心循环。

### 5.3 补齐 Session、模型和项目上下文

Headless 模式需要：

- 创建和保存 Session；
- 通过 `--session` 恢复；
- 将 Multica 传入的模型和 effort 作为本轮覆盖；
- 不污染用户持久化的最后选择；
- 读取任务目录里的项目指令。

Multica 会在工作目录注入 `AGENTS.md` 和 `.deveco/skills`，所以 Mica 也补上了这些发现路径。否则进程虽然启动成功，却拿不到调度平台准备的任务上下文。

### 5.4 让取消信号贯穿整条调用链

Headless Runtime 最怕“主进程看起来退出了，实际子资源还活着”。

取消信号现在需要贯穿：

```text
Multica SIGTERM
      │
      ▼
AgentRuntime AbortController
      │
      ├── 模型请求
      ├── Shell 工具
      ├── MCP connect/list/call
      ├── 子 Agent
      └── 后台任务清理
```

这里的关键不是捕获一次 `SIGTERM`，而是所有可能阻塞的边界都使用同一取消语义。

### 5.5 把 stdout 当作网络协议通道

机器消费 stdout 时，它就不再是一个可以随手 `console.log` 的地方。

Mica 为此补了几层保护：

- 普通诊断只写 stderr；
- 大文本拆成多个事件；
- 工具结果和错误限制大小；
- 每一行保持合法 JSON；
- 退出前完整刷新 stdout；
- MCP 子进程的 stderr 即使不展示也持续 drain，避免 pipe 写满。

Bun 下直接调用 `process.exit()` 可能截断尚未刷完的管道内容。对 TUI 来说偶尔少半行日志可能不明显，对协议来说，少一个右花括号就会让整个事件失效。

所以 Headless Runtime 的结束顺序是：

```text
写入最终事件
  ↓
清理资源
  ↓
刷新并结束 stdout
  ↓
退出进程
```

这也是为什么“增加 JSON 输出”最终会扩展成一次完整的 Runtime 生命周期改造。

---

## 六、这套选择的边界

DevEco 是当前最匹配的方案，不代表它没有限制。

第一，Multica 当前的 DevEco backend 不会自动把 Agent 的托管 MCP 配置转换成 Mica 的 `--mcp-config`。Mica 已经支持显式 MCP 配置，但自动转发仍需要 Multica 侧配合。

第二，DevEco 事件没有一个不会造成重复计数的 tool-start/tool-progress 形态。Mica 当前在工具结束时输出一次完整 `tool_use`，因此超长工具主要受普通 idle watchdog 管理，而不是更长的 in-flight-tool watchdog。

第三，Multica 的 DevEco `step_start` 处理目前没有把事件里的 `sessionID` 带到 status message。正常完成后的 Resume 没问题，但如果进程在最终结果前崩溃，早期 Session 指针可能没有被固定。

第四，Mica 不会因为支持了 DevEco 协议就被 Multica 自动发现。当前仍然需要 Runtime Profile 显式声明 executable 和 protocol family。

这些限制没有必要用伪造事件或虚假 heartbeat 掩盖。协议表达不了的能力，应该明确记录边界，再决定是改进 Multica backend，还是升级到更完整的协议。

从长期看，如果 Mica 需要：

- 运行中持续接收新输入；
- 正式的权限协商；
- 客户端能力协商；
- 多 Session 常驻服务；
- 更细粒度的工具进度；

那么 ACP 会比继续扩展 run JSON 更合理。

但在此之前，DevEco 提供了一个足够清晰的过渡层：它不假装覆盖所有能力，也没有迫使 Mica 提前变成一个复杂的 RPC Server。

---

## 七、选择协议，本质是在选择边界

这次接入最初看起来是一个 CLI 兼容问题，最后真正处理的是三个边界。

第一个是人和机器的边界：TUI 给人看，NDJSON 给调度平台解析。

第二个是 Agent 和调度器的边界：Mica 负责执行任务，Multica 负责启动、观察、取消和恢复。

第三个是当前和未来的边界：现在用与现有架构匹配的 DevEco，未来需要更强能力时再走向 ACP。

回头看四种候选协议：

- Claude stream-json 能力完整，但绑定了一套更复杂的双向控制语义；
- Codex app-server 的 Thread/Turn 模型清晰，但要求常驻 JSON-RPC 服务；
- ACP 更开放、更标准，但需要两侧共同建设；
- DevEco 能力较少，却正好覆盖当前 Mica 接入 Multica 的核心需求。

所以最终的判断不是“DevEco 是最好的 Agent 协议”，而是：

> 在不修改 Multica backend、不改变 Mica 单轮进程模型的约束下，DevEco/OpenCode run JSON 是能力与改造成本之间最合适的平衡点。

Mica 这次真正增加的，也不只是一个 JSON 输出选项。它从一个“可以被脚本启动的交互式 CLI”，变成了一个能够被调度平台理解、观察、取消和恢复的 Agent Runtime。
