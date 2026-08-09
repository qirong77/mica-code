# Mica Code Agent 手册

本文件是 Mica Code 仓库的长期工程说明，面向后续 agent 和开发者。它不是普通 README：`packages/mica-agent/prompt/index.ts` 会在当前工作目录读取根目录 `AGENT.md`，并把内容注入系统提示词的 `<project-instructions>` 段。因此这里的文字会直接影响 Mica Code 自身在本仓库里的工作方式。

本文件的优先级低于系统、开发者和当前用户指令，但高于普通实现偏好。源码、测试和 package README 是具体事实来源；如果本文件与当前代码不一致，以当前代码为准，并在同一次变更中修正本文件。

## 维护红线

- 如果本次变更涉及已经影响到 `AGENT.md` 所描述事实、约束、目录、命令、配置、运行链路或开发流程的内容，必须在同一个变更中更新本文件；不要把文档修正留给后续。
- 如果新增、删除或重命名长期模块、核心服务、内置命令、公共 package、provider 协议、工具注册方式、session 存储格式、runtime 生命周期、UI 状态模型、本地数据格式或验证命令，必须同步更新本文件对应章节。
- 如果修改的是用户可见命令，还要同步检查根 `README.md` 的常用命令列表和 `packages/mica-builtin-commands/README.md`。
- 如果新增 package、移动公共 API、改变 package 依赖边界或修改导出入口，还要同步检查 `packages/README.md` 和对应 package README。
- 如果修改 prompt 构建、skills 加载、工具描述、联网策略或 project instructions 读取方式，必须特别谨慎：这些改动会改变 agent 行为和 prompt cache 前缀。
- 不要把本文件写成流水账。它应记录会影响未来修改方式的稳定约束、架构边界、运行链路和验证习惯。

## 项目定位

- Mica Code 是一个基于 Bun、TypeScript、React 和 Ink 的终端 code agent。
- 核心目标是把 CLI 启动、runtime turn loop、模型 provider、工具、命令、会话、配置、UI、插件和 skills 分层管理，让 compact、rewind、memory、todo、fork、多 agent、后台任务等长期能力有清晰扩展点。
- 仓库结构是 `src/` 应用装配层加 `packages/` 可复用包。新增稳定领域能力优先沉淀到对应 package，`src/` 负责应用级 wiring、生命周期和跨包编排。
- 设计偏向 append-only 会话历史和稳定 prompt 前缀。默认追加用户消息、助手消息、工具调用、工具输出、notice 和日志；只有上下文压力明显影响继续推进时，才在明确阶段边界 compact。
- Mica Code 是终端原生工具，不是网页应用。UI 设计应保持信息密度、低噪音、键盘优先、状态明确，不引入营销式页面或装饰性 UI。

## 快速命令

项目使用 Bun 作为包管理器和运行时，Node 要求 `>=22`。

```bash
bun install             # 安装依赖
cd apps/desktop && npm install   # 桌面应用（Electron）依赖是独立 npm 项目，根 bun install 不覆盖；npm run build:app 的 prebuild:app 会自动检测并补装
bun run dev             # 开发运行：bun run apps/cli/src/index.ts
bun run typecheck       # 类型检查：bunx tsc --noEmit
bun run test            # 运行 Vitest 测试：vitest run
bun run test:watch      # 运行 Vitest watch
bun run build           # 先 typecheck，再 compile 单二进制，postbuild 安装本地入口
bun run dev:config-web  # Config Web Vite 调试：热更新 apps/config-web/web
npm run build:app       # 构建桌面应用（cd apps/desktop && bun run build:mac；依赖缺失时 prebuild:app 自动 npm install）
bun run build:sync-web   # Mica Sync Web 前端构建（apps/sync/web/dist）
bun run build:sync-server # Mica Sync 中心服务 Node bundle（dist/mica-sync-server.js）
bun run format          # 格式化 README、AGENT、apps、plugins、packages、scripts、docs、blogs
cd apps/website && bun run dev     # 官网（Astro）开发服务器
cd apps/website && bun run build   # 官网静态构建（apps/website/dist）
```

常用局部验证：

```bash
bunx tsc --noEmit
bunx prettier --check AGENT.md
bunx prettier --write AGENT.md
bun run test -- apps/cli/src/app/adapters/LocalRuntimeController.test.ts
bun run test -- packages/mica-builtin-commands/tests/configSwitch.test.ts
git diff --check
```

不要使用 Bun 自带的 `bun test` 运行项目测试；它不兼容测试中使用的部分 Vitest API。项目级测试入口是 `bun run test`，局部测试通过 `bun run test -- <测试文件>` 显式传入路径。

## 当前源码版图

```text
apps/
  cli/src/                          Mica CLI 主应用（原根目录 src/）
    index.ts                        CLI 入口：模式分派、全局错误钩子、Application 启停
    buildMeta.ts                    构建元信息
    cli/
      args.ts                       `run` / `models` / `--version` argv 解析
      modelCatalog.ts               Multica runtime 模型 ID 列举与解析
      runExec.ts                    无 UI 一次性执行（mica exec：默认文本，--json 输出 codex ThreadEvent）
      runCompact.ts                 无 UI 会话压缩（mica compact，复用 CompactionService）
      runCommit.ts                  无 UI 一次性 git 提交（mica commit，复用 commitRunner）
      runAppServer.ts               常驻 `mica app-server`：Codex v2 app-server 协议，每会话持有 AgentRuntime/MCP/队列
    agent/
      AgentRuntime.ts               provider client 生命周期、run/abort/snapshot/config reload
      AgentRuntimeConfig.ts         从 mica-config 读取并夹紧 provider/model/effort
    agents/
      terminalAgentSessions.ts      同一终端内多 agent session 与 per-agent UI snapshot
      subagentDefinitions.ts        子 agent 定义资料
      SubagentTaskManager.ts        后台 subagent 生命周期、owner 隔离、结果与取消
    app/
      Application.ts                应用生命周期、插件装配、runtime/UI/session 组合
      ApplicationContext.ts         应用上下文类型
      activeContext.ts              当前 ApplicationContext 的安全访问入口
      createApplication.ts          Application 创建入口
      builtinPlugins.ts             内置插件注册顺序
      adapters/
        LocalRuntimeController.ts   turn loop、命令分发、queue、retry、abort、rewind
        MicaUiRuntimeBridge.ts      AgentRuntime/runtime/session 状态到 mica-ui store 的同步
    plugins/
      commands/                     内置命令 host adapter 和 active proxy
    runtime/
      RewindCheckpointManager.ts    turn 前对话和文件状态 checkpoint
      ToolLogController.ts          thinking/tool-call/tool-result 日志聚合
      CodexProjector.ts             AgentRuntime 事件到 Codex v2 通知流投影（app-server）
      CodexExecProjector.ts         AgentRuntime 事件到 Codex exec ThreadEvent JSONL 投影（mica exec --json）
      HeadlessTurnExecutor.ts       无 UI turn 执行核心：单槽队列 + after_iteration 迭代注入，app-server 与 daemon 共用
      uiBridge.ts                   provider/model/status 同步辅助
    session/
      SessionController.ts          session 保存、恢复、重命名和 UI restore 编排
    features/sync-daemon/           原 src/daemon/：mica-sync 机器端 daemon
      index.ts                      `mica daemon` 入口：注册/心跳/长轮询/命令分发
      config.ts                     sync.json（serverUrl/machineId/name）读写
      SessionWatcher.ts             sessions 目录监听 + 周期 rescan 兜底推送
      SyncClient.ts                 与 sync server 的 HTTP 客户端
      CommandExecutor.ts            远程续聊 turn 执行（复用 HeadlessTurnExecutor + 每会话常驻 host）
    tools/
      ToolAgent.ts                  启动/查询/停止 subagent，并解析角色、effort 与工具权限

  desktop/                          Electron 桌面应用（原 mica-code-app/）
  config-web/                       本地配置 Web（原 packages/mica-config-web/；server + 内嵌静态资源）
  sync/server/                      中心聚合服务（原 packages/mica-sync-server/；零依赖 Node 单文件，REST/SSE/长轮询/JSON 存储）
  sync/web/                         Sync Web 控制台（原 packages/mica-sync-web/；React + Vite，查看会话 + 远程续聊）
  website/                          官网源码（Astro 静态站：首页 + 文档站，内容从 README/命令文档取材）

packages/
  mica-agent                       agent 抽象、provider adapter、prompt 构建
  mica-tools                       内置工具、工具 registry、MCP 工具接入
  mica-mcp                         MCP 配置读取、server 连接管理、远端工具适配
  mica-ui                          Ink 终端 UI 组件和状态 store
  mica-runtime                     runtime 协议、事件、状态、输入和消息队列原语
  mica-session                     会话快照本地保存、读取和列表
  mica-config                      本地配置、storage、模型列表、on-demand Models.dev 查找、runtime env
  mica-commands                    通用斜杠命令注册与分发
  mica-builtin-commands            Mica Code 内置产品命令
  mica-context                     上下文管理，当前主要是 compact
  mica-skills                      用户 skills 扫描、解析和缓存
  mica-plugin                      插件生命周期、hooks、service container
  mica-common                      跨包共享底层工具
  mica-pty                         PTY 测试驱动 + 内置 PTY 工具的 Node helper（node-pty 只在 Node 子进程加载）
  mica-sync-protocol               mica-sync 三端（daemon/server/web）共享的 wire 协议类型，无运行时代码
  mica-web-shared                 sync web 与 desktop renderer 共用的展示纯函数（时间/状态/token 格式化、工具图标/标签、usage/context 摘要计算）
  @anthropic/ink                   本仓库维护的 Ink fork

plugins/builtin/                   官方内置产品插件与启动扩展（原 buildin-plugins/）；Todo、MCP、message queue、文件 mention 和命令
scripts/                           构建、安装、release installer 脚本
docs/                              设计草案和长期能力规划
blogs/                             开发过程记录
skills/                            仓库内 skill 资料
tests/                             跨应用集成测试与测试辅助
temp/                              临时代码和外部实验，默认不参与搜索/测试/格式化
.backups/                          临时备份痕迹，默认不作为实现或验证输入
```

## 应用启动链路

`Application` 是唯一应用入口，当前启动顺序大致为：

1. `plugins/builtin/config-web-worker.mjs` 先判断当前进程是否为 Config Web worker；worker 模式只启动对应服务，不加载终端应用。
2. `apps/cli/src/index.ts` 在加载 config/runtime 模块前分派 `--version`、`models`、headless `exec` / `commit` / `compact` 和交互模式；headless 的 `--dir` 也在动态加载运行模块前生效。
3. 非 version/help 模式调用 `plugins/builtin/validate-config.mjs` 补齐向后兼容的配置默认值；交互模式再加载应用和 UI 模块，由 `plugins/builtin/process-diagnostics.mjs` 设置进程标题、注册全局错误桥。
4. `Application.start()` 使用 `wrappedRender(React.createElement(micaUi.App), { exitOnCtrlC: false })` 启动 Ink UI，然后通过 validate-config 单文件插件执行完整配置校验，确保错误能进入现有启动失败提示。
5. `ensureInitialModelSelection()` 在当前 provider 配置了 `get_model_url` 且顶层 model 为空时，先尝试拉取模型列表。
6. 创建 `AgentRuntime`、`SessionController`、`CommandRegistry`、`HookRegistry`、`ServiceContainer`、`PluginManager`、`TerminalAgentSessionManager`、`LocalRuntimeController`、`MicaUiRuntimeBridge` 和 `SubagentTaskManager`。
7. 将当前 agent 注册到 `TerminalAgentSessionManager`，并通过 `micaTools.registerRuntime(new ToolAgent(agent, subagentTasks))` 注册运行时工具上下文。
8. 构造 `ApplicationContext`，通过 `setActiveContext` 暴露给命令、插件和 runtime 辅助代码。
9. `useBuiltinPlugins()` 按顺序注册 command host，以及 `plugins/builtin` 中的命令、message queue、MCP、Todo 和文件 mention 插件。MCP 插件随 runtime start/stop 建立和关闭连接，并在 dispose 时兜底清理。
10. `plugins/builtin/file-plugins.mjs` 扫描并注册 `$MICA_HOME/plugins` 中的用户插件，`plugins.setupAll(...)` 初始化全部运行期插件，再写入 `plugin-status.json` 供 Config Web 诊断。
11. `uiBridge.start()` 开始监听 agent/runtime/session 事件，`runtime.start()` 触发 runtime hooks。
12. 后台调用 `micaConfig.loadMissingProviderModels()` 加载动态 provider 模型列表。加载成功且 agent 空闲时，`agent.reloadConfig(false)` 并同步模型显示。
13. 文件 mention 插件通过 `ctx.ui.input` 注入当前 cwd 的 `@` 文件候选 provider；应用最后设置 placeholder 和退出回调。

启动失败时，UI 会显示修复配置后重启的提示，`micaTools.unregisterRuntime('Agent')`、插件和 agent session 会被清理，并设置 `process.exitCode = 1`。

插件 setup 期间通过 `ctx.onDispose()` 登记的资源会在 setup 失败时立即逆序回滚；新增 capability 注册必须同步登记 disposer，不能依赖应用最终退出兜底。

## Active Context 约定

- `apps/cli/src/app/activeContext.ts` 是应用上下文的唯一全局访问入口。插件、命令和 runtime 辅助代码可以通过它读取当前 `ApplicationContext`。
- 不要从 package 或底层工具反向 import `Application.ts` 获取状态。需要上层能力时，用 service、hook、adapter、回调或显式参数注入。
- 多 agent 场景下，命令不能假定构造时传入的 `agent` 永远是当前 agent。命令插件使用 `createActiveAgentProxy` 和 `createActiveSessionControllerProxy` 解决这个问题。
- provider/model/effort 切换前，要先同步当前 agent 的 config，再打开选择器；切换后要 `agent.reloadConfig(false)`、保存 session、同步 UI。role 切换同样需要 busy guard 和保存 session，但只重建 client 并保留当前历史。
- 跨协议切换（`openai_chat_completions` ↔ `openai_responses`）在 `applyConfigSwitchUpdate` 中被阻止并提示：新协议 client 无法携带旧会话历史，行为与 `configureForRun` 的跨协议 resume 检查一致；空会话允许自由切换。不要绕过该检查去 `reloadConfig(false)` 静默丢历史。
- **恢复旧会话的协议降级**：`agentRuntimeConfigFromSnapshot` 遇到 `provider.protocol !== snapshot.protocol`（例如 krill 从 chat_completions 升级到 responses 后恢复旧协议会话）时，同 provider 或默认 provider 都**降级恢复**（保持 model/effort、用当前 provider 协议），而不是 throw——否则迁移前的旧会话每次 resume 都会崩溃，app-server 直接 exit(1) 显示"mica 进程已退出（code 1）"无原因。

## Runtime Turn Loop

`LocalRuntimeController` 是当前 turn loop 的中心，负责命令分发、普通输入提交、busy 状态、queue、retry、abort、rewind checkpoint、session 保存和 hooks。

普通用户输入的关键路径：

1. `runtime.submit(rawText, options)` trim 输入，先尝试 `commands.resolve(text)`。
2. 命令输入走 command registry。exclusive task 或运行中 agent 会阻止不允许并发的命令。
3. 非命令输入根据 `SubmitOptions` 找到目标 agent，构造 `RuntimeInput`。
4. 如果目标 agent 正在执行 exclusive task，拒绝输入并发出 notification。
5. 触发 `input:received` guard hook。`plugins/builtin/message-queue.ts` 会通过公开的 `ctx.runtime.queue` 能力在 agent busy 时尝试排队输入。
6. 如果没有被 hook 处理，进入 `runTurn(input, agent, sessionController)`。
7. turn 开始时捕获 rewind checkpoint，解析图片引用，写入 UI conversation message，清空当前 response buffer。
8. 触发 `turn:before` 和 `prompt:build` hooks，然后调用 `agent.run(content, { onIterationComplete })`。
9. `queueMode: 'after_iteration'` 的排队输入会先跨过当前迭代边界；agent 再完整完成一轮工具调用迭代后，`takeQueuedIterationInput` 才会取出它并追加到同一次 provider loop。若 agent 已直接结束，则按 turn 完成队列发送。
10. turn 开始先以 `running` 状态保存；每次工具 iteration 完成后继续保存可恢复 checkpoint；整个 turn 成功后再把 response buffer 或 final text 写入 assistant message，触发 `turn:beforePersist`，并以 `completed` 保存最终快照。abort 和最终错误分别保存为 `aborted`、`error`，非 `completed` 会话在 `/resume` 中标记为 `（uncompleted）`。
11. 失败时按 retry 策略处理；不可重试或重试耗尽后写入 error UI 状态。
12. abort 时保留已经展示的部分回复，裁剪 aborted run 的 usage，并保存可用的中止后会话状态。
13. finally 中释放 running 状态，触发携带 `outcome`（`completed`/`aborted`/`error`，由 `wasAborted`/`hasError` 推导）的 `turn:after`，然后 message queue 插件可以提交 `after_turn` 排队输入。内置 Todo 插件据此收尾：`completed` 把仍 `in_progress` 的项标为 `completed`（全部完成后列表自动收起），`aborted`/`error` 才降级为 `pending`（保守，不声称完成）。

### Queue 语义

- 当前 `packages/mica-runtime/MessageQueueService.ts` 是单槽队列：每个 agent 同时最多保留一条 pending input。
- `RuntimeQueueMode` 只有 `after_turn` 和 `after_iteration`。
- 内置 message queue 插件在 `input:received` 阶段处理 busy agent 的输入。如果已有排队消息，会提示“已有一条排队消息，等待发送或重新编辑”。
- 排队成功时插件只发布 `queue:changed`（驱动 conversation 底部的 waiting queue 行），不再重复发 info notification——waiting queue 行已包含发送时机（after turn / after a complete tool-call iteration）与重新编辑提示（`shift + ← to re-edit`）。
- queue 操作必须带 owner/agent 语义。后台 agent 或非当前 agent 的输入不能落到当前 active agent 上。
- UI 展示使用 `RuntimeInput.displayText` 或 `displayContent` 时，只影响展示摘要；`text` 或 `content` 仍保留完整上下文给 agent。
- pending input 在 conversation 底部使用临时 notice 样式展示，标题包含发送时机和重新编辑快捷键；它仍属于 `pendingInputs` UI 状态，不追加到 `conversationMessages` 或 agent history。

### Retry 语义

- `LocalRuntimeController` 对 turn 级错误最多重试 5 次，每次间隔 10 秒。
- 每次重试前会恢复 pre-turn client snapshot，清空本次 response buffer 和 committed buffer，避免 partial message 或 partial tool result 污染下一次请求。
- 只有 `micaAgent.isRetryableError(error)` 且本 turn 尚未出现非只读工具调用时才自动重试。
- 只读工具由 `micaTools.isReadOnly(toolName)` 判定。非只读工具调用之后不能盲目重放请求，否则可能重复修改文件、执行命令或触发外部副作用。
- retry notice 以 conversation notice 形式展示，并在倒计时期间更新文案。
- 不要把 provider SDK 内建重试和 runtime turn 级重试混为一谈。新增 retry 逻辑前要确认边界：stream 创建前、stream 中、工具调用前后、副作用是否可重放。
- `ResponsesClient` / `ChatCompletionsClient` 的 `withRetry` 包住"建流 + 流消费"整体，但只在一次尝试**还没有文本/工具输出**时重发整个请求；一旦收到文本、tool-call 增量、usage 或正常完成，错误原样抛出交给 turn 级处理。thinking/reasoning 事件**不计入"有输出"**——它是 turn 内暂存的过程数据，重试丢弃无害，而且工具迭代后模型往往先输出 thinking 再被过载中断，计入会把本可安全重试的请求跳过。原因：krill 等上游过载时返回 HTTP 200 + `{"error":{...,"type":"error"}}` JSON，openai-node SDK 不会在 `create()` 抛错，而是在流迭代首帧反序列化成 `service_unavailable_error` / `server_is_overloaded` 异常抛出——只包 `create()` 的重试永远命中不到；而无输出时重发不产生副作用，收到文本/工具增量后重发会重复 `onText`、污染 `usageHistory` 或重放 tool-call 增量。`core/retry.ts` 的 `isRetryableError` 已覆盖 `service_unavailable_error` type 与 `server_is_overloaded`/`slow_down` code；`withRetry` 支持 `shouldRetry` 覆盖默认判定，也支持 `backoffFactor`/`maxDelayMs` 指数退避和 `onRetry` 诊断回调（两个 client 用 2s 起、翻倍至 16s、最多 4 次重试，每次重试写 `[mica] provider request retry N: ...` 到 stderr）。

### Abort 语义

- `AgentRuntime.abort()` 会递增 `runId`、abort 当前 controller、清空 active controller，并把 status 置为 idle。
- `AgentRuntime.run()` 在 abort 或 runId 过期时抛 `AgentAbortError`，并记录可裁剪 usage 的起止位置。
- `LocalRuntimeController` abort 后使用 `committedResponseBuffers` 区分已经写入历史的文本和 live suffix，避免 retry/continue 后重复或丢失助手输出。
- 如果不是 `/clear` 导致的中止，`agent.preserveAbortedTurn(content, partialAnswer)` 会决定是否把部分回复写回 provider history。
- provider client 的流迭代结束后必须再检查一次 abort：OpenAI SDK 在等待下一个 chunk/event 时收到 AbortError 会静默结束流而不抛错，若不检查，被中止的请求会被提交成空 assistant 消息（`content: null` 且无 tool_calls），下一次请求直接 400 `Invalid assistant message: content or tool_calls must be set`。`ChatCompletionsClient` 和 `ResponsesClient` 都在 `for await` 结束后调用 `throwIfQueryStopped(options)`，并在 content 为空时跳过提交空 assistant 消息；修改这两个 client 的流循环时不要把该检查点删掉。
- UI 展示的真相优先来自 `TerminalAgentSession.uiState.conversationMessages`，而不是重新从 provider history 推断。这个边界很重要，避免 abort/continue 后消息重复、错序或丢失。

## Provider、Prompt 与模型协议

`packages/mica-agent` 只做 provider-neutral agent 抽象、模型协议适配和 prompt 构建，不依赖 UI、session、commands 或应用入口。

- `createModelClient` 根据 `provider.protocol` 显式分流：
  - `openai_chat_completions` -> `ChatCompletionsClient`
  - `openai_responses` -> `ResponsesClient`
- 不要根据 `api_base` 猜测协议。第三方 provider 是否支持 Responses、Chat Completions、reasoning effort 或特定参数，必须通过配置、官方资料或最小探针确认。
- provider adapter 负责协议消息结构、history normalizer、usage 归一化、tool-call 格式、请求参数转换和 abort signal。
- 工具结果可以是纯文本，也可以是文本/图片内容块。Chat Completions 必须先追加全部 `tool` 文本结果，再用一条 `user` 多模态消息承载工具图片；Responses 则使用原生多模态 `function_call_output`。UI、日志和 run JSON 只接收文本投影，不得输出 Base64。
- runtime 不直接拼 provider 请求参数。Chat Completions effort 参数通过 `resolveChatCompletionsEffortParams` 生成，Responses reasoning 参数通过 `resolveResponsesReasoningParams` 生成。
- `createSubAgent` 会复用当前 provider client options，但默认 `effort: 'none'`，并根据传入 options 决定是否启用 tools。
- `buildSystemPrompt()` 默认读取 `packages/mica-agent/prompt/system.md`，当前 agent 选择自定义 role 时只替换 `<system>` 段；当前 cwd 下的 `AGENT.md` 和 `AGENTS.md` 会合并，skills 索引和环境信息继续独立注入。读取路径必须在 prompt 构建时按 live cwd 解析，不能在模块加载时冻结。
- system prompt 中的 skills 只是索引；完整 skill 内容只能通过 `Skill` 工具按需读取。
- role 默认从 `~/.mica/role` 扫描，设置 `MICA_HOME` 时使用 `$MICA_HOME/role`。只加载 `.md` 文件，文件名去掉扩展名后作为 role 名；内置 `default` 只展示、不可由目录中的同名文件覆盖。

## 配置、本地数据与 MICA_HOME

`packages/mica-config` 是配置和本地状态的唯一入口。不要让 UI、commands、runtime 和 provider adapter 自己读写配置文件路径。

### 配置文件

- 默认配置路径是 `~/.mica/config.json`。如果设置 `MICA_HOME`，则配置路径解析到 `$MICA_HOME/config.json`。
- 配置文件不存在时，`persistence.ts` 会创建 `packages/mica-config/default.json` 的副本。
- JSON 解析失败时，旧文件会被重命名为 `config.json.invalid-<timestamp>`，然后写入默认配置。
- 持久化配置类型是 `PersistedMicaConfig`，主要保存 `providers`、`serperApiKey`、`mcpServers` 等静态配置。
- 顶层 `provider`、`model`、`effort`、`contextWindowSize` 是运行时合成字段，不应写回 `config.json`。`updateConfig` 会通过 `stripRuntimeFields` 去掉它们。
- `ProviderDefinition.protocol` 只支持 `openai_chat_completions` 或 `openai_responses`；旧配置缺失该字段时，`plugins/builtin/validate-config.mjs` 会在配置模块首次读取前补为 `openai_chat_completions`。
- config 的启动迁移和语义校验统一放在 `plugins/builtin/validate-config.mjs`。配置 Web 保存也复用该文件，不要在应用或 package 中另建一套校验规则。
- 当前 provider 缺少 `api_key` 是 warning，可以启动 UI，但首次发送消息前仍需要可用 key。

### Storage

- 默认 storage 路径是 `~/.mica/storage.json`。如果设置 `MICA_HOME`，则解析到 `$MICA_HOME/storage.json`。
- storage 版本为 1，记录 `lastUsedByDirectory`、`inputHistory`、`preferences`、`usage`。
- 最后使用的 provider/model/effort 按精确当前目录保存到 `lastUsedByDirectory`。
- provider 级偏好保存在 `lastUsedByDirectory[dir].providerPreferences[providerId]`，用于切回 provider 时恢复该 provider 的 model/effort。
- 输入历史是共享的，最多保留 200 条。mica-code-app 的 Chat 输入框通过 `apps/desktop/src/main/input-history.js`（IPC `chat:input-history:read/append`）读写同一份 `storage.json`，与 CLI 的 `micaConfig.inputHistory` 互通；append 去重并保持最新条目在尾部。改动两端时保持 200 条上限与去重语义一致。
- 涉及 config/storage 的测试和临时 repro，优先用临时 `MICA_HOME`，不要污染真实 `~/.mica`。

### Session

- `packages/mica-session/sessionStore.ts` 默认使用 `~/.mica/sessions`，设置 `MICA_HOME` 时跟随 `$MICA_HOME/sessions`。
- session 文件是 version 1 JSON，保存 `id`、`title`、`createdAt`、`updatedAt`、`cwd` 和 `snapshot`。
- `snapshot` 包含 providerId、model、effort、role、provider history messages、UI conversationMessages、usageHistory、lastUsage。旧 snapshot 缺少 role 时按 `default` 读取，自定义 role 文件缺失时恢复也回退到 `default`。
- `snapshot.subagentUsageHistory`（可选）记录该 agent 发起的每个 subagent 任务完整 usage：`taskId`、`parentTaskId`（嵌套调用树）、`initiatedByCallId`（父 agent 的 provider tool-call id）、`subagentType`、`description`、`status`、`startedAt`/`finishedAt`、逐条 `requests`（`AgentUsageRecord[]`，含 `occurredAt`/`usageId`）和聚合 `summary`。由 `ToolAgent` 在任务结束时调用 `AgentRuntime.recordSubagentUsage` 写入，随会话快照落盘，rewind 的 checkpoint clone 会原样携带；subagent 的 `turnId`/`messageCount` 相对子 agent 自身消息数组，必须独立存放，不能混入主 `usageHistory`（否则破坏 rewind 的 `messageCount` 裁剪语义）。旧 snapshot 缺少该字段时按空数组处理。
- `SessionController` 负责把 `AgentRuntime` snapshot 转为 persisted snapshot，恢复时先 apply config，再 reload agent，再 load snapshot，最后 restore UI。
- `SessionController.saveCurrent` 用持久化签名（`sessionSignature`）检测"另一个进程写盘"：签名不匹配时**降级写盘**（revision+1，以当前内存快照为准）而不是永久跳过——headless host（app-server/exec）不调用 `refreshFromStore`，永久跳过会让该 host 后续所有 turn 都不落盘（会话重启后"丢失最近对话"）。多 host 竞争同一会话（页面刷新/节点重建的第二个 app-server、CLI resume、sync daemon）时，后写者覆盖先写者属可接受的最坏情况；`refreshFromStore` 会让签名在下一次刷新时收敛。
- 新增 session 字段必须有明确版本策略、默认值和 sanitize/parse 逻辑。

## 模型、Effort 与 Context 规则

- 全局 effort 枚举是 `none/low/medium/high/xhigh`，直接映射到 OpenAI 请求参数。
- 默认 effort map 是 `none -> null`、`low -> low`、`medium -> medium`、`high -> high`。未加载数据的模型默认提供 `none/low/medium/high`。
- Provider 可通过 `get_model_url` 拉取模型列表；所有模型使用 `getModelRule` 返回的固定 context window 和 reasoning effort 映射。
- 交互和 headless 模式都必须先注册 `plugins/builtin/model-effort-context` resolver，再调用 `ensureModelRule`；headless 获取不到 metadata 时只写 stderr 并使用通用 rule，不能污染协议 stdout。
- Headless `exec` 默认输出人类可读文本；显式 `--json` 时输出 Codex exec ThreadEvent JSONL（`thread.started`/`turn.started`/`item.started`/`item.updated`/`item.completed`/`turn.completed`/`error`，item 类型为 `agent_message`/`reasoning`/`command_execution`），形状与 `codex exec --json` 对齐。`--thinking` 控制是否投影 reasoning item；不要把 reasoning 混入 `text` 或最终任务输出。
- Headless run 的 prompt 会像交互输入一样先经 `micaUi.parseImageRefs` 解析 `[Image](路径)` 引用（从 `@packages/mica-ui/utils/imagePaste.js` 直接导入，避免把 React/Ink 拖进 headless 路径），生成多模态 content block 后再调用 `agent.run`，因此 Web Chat 等一次性消费方可以通过 `~/.mica/images/` 引用附加剪贴板图片。不依赖 React/Ink 的约束仍然成立。
- Headless `run --no-save` 会在整个 turn 期间跳过 session 落盘（包括 running/completed/aborted/error 各阶段），用于 mica-code-app 右键 Commit 等一次性后台任务：与主对话完全隔离、不创建垃圾 session 文件。它不改变 prompt、工具、MCP 或事件输出行为。
- Responses 请求只要包含 reasoning 参数，就应保留显式 summary 配置；未配置时补 `summary: 'auto'`，否则 provider 可能只有隐藏 reasoning tokens 而不会产生 `response.reasoning_summary_text.delta`，终端和 Chat 都没有可展示的思考内容。
- 只有明确配置了 `get_model_url` 的动态 provider 才会触发 provider 模型列表查找；模型 context/effort metadata 则来自 Models.dev resolver。
- context size 默认 256K，实际值由 Models.dev canonical 模型记录的 `limit.context` 决定。
- 未在 Models.dev 中找到的模型使用默认值：256K context、`none/low/medium/high` effort。
- provider 可设置 `supportsEffort: false`，这时状态显示为 `none`，请求不发送 reasoning effort。
- Anthropic Messages 协议当前 effort 选项固定为 `none/low/medium/high`。
- provider/model/effort 切换时必须 clamp effort，并同步 context window size。不要把无效 effort 持久化进 storage 或 session。
- 动态模型列表只缓存到内存配置和 storage 相关运行态，不回填静态 `config.json`。
- `get_model_url` 拉取模型列表时解析 OpenAI 风格 `{ data: [{ id }] }`。返回空列表或非预期结构会报错。

## Headless turn 执行核心与 app-server

- `apps/cli/src/runtime/HeadlessTurnExecutor.ts` 是无 UI turn 执行核心：持有单槽 `MessageQueueService`（`after_iteration` 输入在完整工具迭代边界注入、`after_turn` 输入在当前 turn 结束后自动排空），并对外发布 `turn:start`/`turn:finish`/`queued`/`dequeue`/`queue:changed` 生命周期事件。它不拥有输出协议（文本/工具/usage 流仍由消费方经 `CodexProjector`、`CodexExecProjector` 或 sync 事件映射转发），不触碰 Ink/UI。它是交互 runtime（`LocalRuntimeController`）队列语义的 headless 版，与 CLI Shift+Tab 的 after_iteration 行为一致。**每个 turn 必须发出 `turn:finish`（completed/aborted/error 三态之一）**：abort 落在 `reserveRunId` 与 `agent.run` 检查之间时由 `agent.run` 抛 `AgentAbortError` 走 aborted 分支，不要在 `runTurn` 里静默 return，否则客户端永远收不到 `turn/completed`，app 停在 running 状态。**每个 turn 开始前先调用 `sessionController.refreshFromStore()` 再 `reserveRunId()`**：refresh 可能触发 `loadSnapshot`（runId++），顺序颠倒会把本轮误判为 abort；refresh 让持久化签名保持新鲜，避免 `saveCurrent` 的"另一进程写盘"检查跳过本 host 的保存。
- `mica app-server`（`apps/cli/src/cli/runAppServer.ts`）是**每会话常驻进程**：从 stdin 读 Codex v2 app-server 协议请求（`initialize`/`thread/start`/`turn/start`/`turn/steer`/`turn/interrupt`，JSON-RPC 风格、每行一个 JSON、无 `jsonrpc` 字段），向 stdout 写 v2 通知；持有 `AgentRuntime` + `SessionController` + MCP 连接 + `HeadlessTurnExecutor` 直到会话关闭/进程退出，因此连续对话跳过进程启动、session 重载和 MCP 重复 init。**不要把它改成全局单 daemon**：每会话进程隔离干净、退出即回收，多会话不互相阻塞。**MCP 初始化与 host ready 解耦**：`micaMcp.init()` 在后台发起（`.catch` 消化错误），host 先发首帧快照（`mica/backgroundTasks/updated`）即可服务，首个 `turn/start` 开始前 `await ctx.mcpReady`——用户从 host 就绪到按下发送之间的间隔通常已覆盖 MCP 初始化，慢 MCP 不再卡住 host 就绪（首轮感知延迟接近零，与交互模式"UI 先渲染、MCP 后台连接"一致）。MCP init 失败降级：stderr 记录 + Codex `error` 通知，host 继续服务（无 MCP 工具），不 `exit(1)`（与 `plugins/builtin/mcp.mjs` 的"初始化失败只报错不崩溃"一致）。
- 协议实现位于 `packages/mica-runtime/codexProtocol.ts`（framing/编解码）与 `apps/cli/src/runtime/CodexProjector.ts`（AgentRuntime 事件 → `turn/started`/`turn/completed`/`item/agentMessage/delta`/`item/reasoning/textDelta`/`item/commandExecution/outputDelta`/`item/started`/`item/completed`/`thread/tokenUsage/updated` 通知）。`turn/start` 立即返回 `{turn:{id,status:"inProgress"}}` 后异步执行；`turn/steer`（带 `expectedTurnId`）把输入注入活跃 turn 的 after_iteration 队列；`turn/interrupt` 中止。这是 Codex App Server 协议子集，未来任何理解该协议的客户端（IDE 插件等）可直接驱动 mica。`commandExecution` item 携带 `displayText`（工具 `onToolUseDisplayText` 的文案），让客户端与 CLI 展示同一工具摘要，而不是自己重拼；`item/started` 与 `item/completed` 都带。思考流默认关闭，`app-server --thinking`（或 projector context 的 `thinking: true`）才发 `item/reasoning/textDelta`。
- **Mica 增量扩展**：Codex 协议没有队列事件，`app-server` 会额外发 `mica/queue/queued`/`mica/queue/dequeue`/`mica/queue/changed` 通知（`MICA_QUEUE_NOTIFICATIONS`），让客户端能展示 host 侧 after_iteration（Shift+Tab）排队态；未知通知方法对 Codex 客户端无害，属纯增量。`turn/steer` 的 params 可带可选 `clientMessageId`（Mica 扩展），host 把它作为 `RuntimeInput.id`，使 queue 通知能关联 app 的乐观消息；`createRuntimeInput` 支持 `id` option。mica-code-app 用 `allQueuedItems` 合并本地 after_turn 队列与 host after_iteration 队列（单槽互斥），queue 通知同步消息排队标记。
- 同样的增量扩展用于**跨 turn 常驻状态**：后台 shell 任务（`run_shell` background / `background_tasks`）和 subagent（含 `run_in_background` 在父 turn 结束后仍运行的）没有 Codex 事件，`app-server` 用 `mica/backgroundTasks/updated`/`mica/subagentTasks/updated` 快照通知（`MICA_TASK_NOTIFICATIONS`）推送。快照是**整体替换语义**：`apps/cli/src/cli/runAppServer.ts` 每 1s 轮询 `listBackgroundTasks` + `SubagentTaskManager.list`，与上次 JSON 序列化结果对比，有变化才推送（启动时立即推一次初始快照）；只投影活跃项（后台任务 starting/running、subagent running），投影逻辑是导出纯函数 `projectBackgroundTasks`/`projectSubagentTasks`（`apps/cli/src/cli/runAppServer.ts`），便于单测。mica-code-app 的 `chat.js` 对这两个 method **直接送渲染层、不进 turn 事件缓冲**（`appendBufferedEvent` 会被高频快照撑爆 500 条上限、restore 重放过期列表），`ChatView.jsx` 的 `SubagentStatusDock`（树形摘要，含嵌套 `parentTaskId` 与 `⎿` 活动行）和 `BackgroundTasksDock`（`$ (shell)` 行）常驻 composer 上方、跨 turn 保留、空闲时每秒刷新耗时——与 CLI `TaskStatusBar` 对齐；不再从消息流推导 active subagent。
- `mica exec`（`apps/cli/src/cli/runExec.ts`）是一次性 headless 执行，对齐 `codex exec`：默认人类可读文本，`--json` 输出 ThreadEvent JSONL（`packages/mica-runtime/codexExecEvents.ts` 定义类型，`apps/cli/src/runtime/CodexExecProjector.ts` 投影）。生命周期与 `mica app-server` 一致（MCP init、session 落盘、subagent 清理）。
- `mica-code-app` 的 chat 主进程（`apps/desktop/src/main/chat.js`）每 chat 节点维护一个常驻 `app-server` 子进程：`chat:start` 在空闲时发 `turn/start`、忙时 Shift+Tab 发 `turn/steer`（after_iteration 注入）、忙时 Tab 在本地 `queuedRuns` 排队等 `turn/completed` 后重放；`chat-events.js` 的 `codexNotificationToEvent` 把 v2 通知映射回 app 内部事件形状。abort 改为 `turn/interrupt` 请求而非杀进程。host 意外退出时 app 清理该节点、下条消息重建。页面刷新后 `chat:start`/`chat:is-running` 会刷新 `run.sender`，避免事件发给已销毁的 webContents。
- **app 与 CLI 交互/展示对齐约定**（改任何一侧都要同步检查另一侧）：
  - 排队语义单槽：`apps/desktop/src/main/chat-queue.js` 的 `resolveBusyDispatch({running, queueMode, queuedCount})` 是 busy 分派唯一判定——空闲→start、busy 无排队→Tab/Enter enqueue（after_turn）或 Shift+Tab steer（after_iteration）、**busy 已有任意排队→一律 reject**（文案与 CLI 一致「已有一条排队消息，等待发送或重新编辑」）。本地队列与 host after_iteration 队列互斥，禁止恢复多槽堆叠。
  - 输入框文案对齐 CLI：composer queue 提示精确复用 `TerminalInput.tsx` 的 `QUEUE_SHORTCUT_TIP`（「Enter/Tab 等 agent 执行完成后发送，shift + tab 本轮工具调用迭代后发送」）；空闲 placeholder 用 `mica-ui/input/state.ts` 的「Type something and press Enter...」；`QueueDock` 标题按 queueMode 用 CLI `formatPendingStatus` 文案（after_iteration → "waiting to send after a complete tool-call iteration"）。
  - 输入历史对齐 CLI：Chat 输入框的 ArrowUp/ArrowDown 历史导航与 CLI 共享 `storage.json` 的 `inputHistory`（见 Storage 章节），挂载时经 `chat:input-history:read` 加载、发送时经 `chat:input-history:append` 回写（失败静默）；触发条件放宽为**光标在第一行按上、最后一行按下**（`isCaretOnFirstLine`/`isCaretOnLastLine`，`Alt+Up/Alt+Down` 仍无条件触发），避免多行输入时光标必须停在行首/行尾才生效的"上下切换无效"观感。
  - 状态栏耗时对齐 CLI `WorkingStatus`：主区状态文本后跟当前阶段/工具的实时 elapsed（working 阶段取最早 running 工具 `startedAt` 起算，其余阶段从 phase 切换起算，250ms 刷新）；meta 区保留总任务 elapsed（`runStartedAt` 起算）与模型/ctx 占用。**运行结束后主区继续展示上次 turn 结果**：`step_finish` 时按 `turn/completed` 的 reason 把 `{ state: 'completed'|'error', durationMs }` 写入 `lastRun`（`durationMs` 由 `turnStartedAtRef` 记录的 turn 开始时间戳与事件时间戳差值得到），空闲时主区显示绿色 `completed <整轮耗时>`（对齐 CLI 的 `statusSuccess` + `elapsedMs`）或红色 `error`；aborted 对齐 CLI abort 后 idle 不展示，`step_start` 清空 `lastRun`。
  - token 统计用累计值：`chat-events.js` 的 `tokensFromCodexUsage` 读 `tokenUsage.total`（CodexProjector 维护的累计），不要改回 `last`（单条记录），否则上下文/cached 数字偏小。
  - run_shell 日志阈值 env 化：preload 注入 `window.mica.runShellLogConfig`（来自 `MICA_RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS`/`MICA_RUN_SHELL_LOG_MAX_LINES`，默认 10000/10 与 CLI 一致），`visibleShellOutput` 不要再硬编码。
  - 思考流：app 的 `buildAppServerArgs` 必须带 `--thinking`，否则 `CodexProjector` 默认不发 `item/reasoning/textDelta`，思考日志与 thinking 状态消失。
- 容错约定：`--session` resume 失败（含 `resumeLoaded` 抛错，不只是 `{ok:false}`）或 `--dir` chdir 失败时**降级继续**（发 Codex `error` 通知携带真实原因，resume 失败回退为空会话，chdir 失败保持当前目录），不退出进程——避免 mica-code-app 显示"mica 进程已退出（code 1）"却没有原因。MCP 初始化失败同样降级（见上条：后台 init 失败只发 `error` 通知，不再让整个 host 启动失败退出）。`apps/cli/src/index.ts` 的 app-server 启动失败兜底同样输出 Codex `error` 通知（不要改回旧 run-JSON error 格式）。进程注册 `unhandledRejection`（记录 + 通知，不退出）和 `uncaughtException`（通知后退出）兜底；`exit(code)` 退出前先 flush stdout/stderr，避免 process.exit 丢弃缓冲的真实原因。

## 命令系统

- 通用命令机制放在 `packages/mica-commands`。
- Mica Code 产品命令放在 `packages/mica-builtin-commands`。
- `packages/mica-builtin-commands` 目录按职责拆分：`commands/` 放命令实现，`shared/` 放命令间共享辅助，`git/` 放变更追踪与提交辅助，`tests/` 放全部测试，公共入口仍是 `index.ts` 与 `services.ts`。
- `apps/cli/src/plugins/commands/index.ts` 把内置命令注册到 `CommandRegistry`，并同步给 `mica-ui` quick commands。
- 命令实现不要直接依赖应用层单例。需要 runtime、session、agent、UI、MCP、日志等能力时，通过 `CommandRuntimeServices` 或 active proxy 注入。
- 耗时且会修改上下文、文件、配置或 git 状态的命令应通过 runtime exclusive task 执行，防止用户并发发送对话或切换配置。
- `/model`、`/effort` 必须在打开 selector 前检查 target agent busy 状态，并在选择时保留二次 guard。
- `ALLOW_DURING_TURN_COMMANDS` 当前允许运行中执行：`status`、`context`、`agents`、`new`、`fork`、`exit`、`rename`、`task`。
- exclusive task 期间额外允许的命令在 `ALLOW_DURING_EXCLUSIVE_TASK_COMMANDS`，当前是 `status`、`task`、`agents`、`new`。
- 命令的交互反馈（busy 拒绝、切换成功、缓存失效警告、失败错误等）统一通过 `services.showNotice` 以对话区 notice 形式展示，不要用 `services.showMessage`；`showMessage` 只保留给运行日志性质的系统消息（启动提示、运行错误等）。`MicaUiRuntimeBridge` 会把 runtime `notification` 事件（运行中拒绝输入/命令、命令失败等）转成 conversation notice，不再写 MessageBar。

当前内置命令：

- `/clear`：终止并移除当前 owner 的 subagent、丢弃待注入的 system queue，然后新开一个空 session；不清除原 session 文件内容。
- `/resume`：恢复历史会话。
- `/model`：从包含 provider 信息的模型列表中切换 provider 和模型。
- `/effort`：切换推理强度。
- `/role`：切换当前 agent 的系统提示词；自定义文件来自 `~/.mica/role` 或 `$MICA_HOME/role`。输入框中也可使用 `Shift+Tab` 按列表顺序循环切换 role（agent busy 时拒绝，与 `/role` 一致）；当 agent 运行中且输入已进入 queue 快捷提示时，`Shift+Tab` 仍表示 after_iteration 排队发送。
- `/status`：显示当前 provider/model/effort/role 状态。
- `/context`：显示当前上下文占用总览。
- `/compact`：压缩当前会话上下文为 checkpoint。Web Chat 通过 `mica compact --session <id>` 调用同一套 `CompactionService`（见 `apps/cli/src/cli/runCompact.ts`）；该 headless 命令会写回压缩后的 checkpoint 并输出单行 JSON，会话内容过少时返回 `code: "not_needed"`。
- `mica compact --prune-only`（mica-code-app 右键「快速压缩（本地）」）只做本地清理、不调用模型：先修剪单条消息内的大块内容——**所有**工具调用结果（tool result / `function_call_output` / `toolUseResult`）与**所有**工具调用参数（`arguments`）都无条件替换为占位符（arguments 必须替换为合法 JSON `TOOL_ARGUMENTS_PLACEHOLDER`，否则 provider 400），图片/base64/超长字符串按尺寸修剪；若没有可修剪内容且会话存在可丢弃的旧轮次（本地丢弃的节省量达到 `MIN_LOCAL_ROUND_DROP_SAVED_TOKENS`/`MIN_LOCAL_ROUND_DROP_SAVED_RATIO` 下限），则沿轮次边界丢弃最早轮次、保留最近轮次（复用最近 token 预算，且不拆散 tool call/result 配对）；两种情况都不满足时才返回 `not_needed`「暂无可快速清理内容」。不要改变"prune-only 永不调用模型"的约定；`mode: 'kept'`（模型压缩保留的最近轮次）仍只截断超长参数，保持工具调用可读。
- `mica commit`（headless，`apps/cli/src/cli/runCommit.ts`）：与 `/commit` 复用 `packages/mica-builtin-commands/git/commitRunner.ts` 的确定性分析/提交函数，程序收集 git 变化摘要后**只发一次模型请求**生成 commit message（不启用工具、无多轮循环），再程序化 add/commit/push，输出单行 JSON（`ok`/`commitHash`/`subject`/`commitMessage`/`pushed`）。`mica-code-app` 右键 commit 通过 `mica commit --dir <cwd>` 调用它，代替原先的 `mica exec` 多轮工具循环。
- `/new`：新开一个 agent；`/new <text>` 后台运行新 agent。
- `/fork`：从当前 agent 历史分叉一个新 agent；`/fork <text>` 后台运行。
- `/task`：按 terminal session 展示当前终端中的 session、全部 retained subagent 和 active background shell。列表中 `Enter` 切换 session，或打开 subagent/shell 详情；`/task clear` 清除空闲 session。
- `/rewind`：选择一轮对话，保留该用户输入及该轮回复并删除之后的内容；对话节点可从当前 provider/UI history 动态恢复，有对应文件 checkpoint 时还可选择恢复文件。
- `/mcp`：列出 MCP 服务器和工具；`/mcp reconnect <server>` 重连指定服务。
- `/skills`：列出已安装的 skills。
- `/rename`：重命名当前会话。
- `/commit`：分析当前 git 变化，生成提交信息，提交并推送。
- `/exit`：退出程序。

新增或删除命令时，至少检查：

```text
apps/cli/src/plugins/commands/index.ts
packages/mica-builtin-commands/index.ts
packages/mica-builtin-commands/README.md
README.md
AGENT.md
```

## Tools、MCP 与 Skills

### Tools

- `packages/mica-tools` 是唯一工具 registry。内置工具和 MCP 工具都必须通过它暴露给模型和 runtime。
- 运行期产品工具优先由内置插件通过 `ctx.tools.register()` 注册；工具可声明 icon 和 `primaryAgentOnly` 元数据，核心和 subagent 策略不要硬编码具体插件工具名。
- 新增工具优先继承 `MicaTool`，提供参数 schema、执行逻辑、展示文案、错误格式化和只读属性。
- 文件、shell、网络类工具必须保留边界检查、输出限制和清晰错误。
- `read_image` 读取本地路径或 HTTP(S) URL，经过 `mica-common` 的格式识别后将原图作为图片内容块返回；它是只读工具，也应加入只读 subagent 的允许列表。
- `run_shell` 的前后台执行、cwd 校验、输出截断、后台任务读取和终止逻辑应保留在 `packages/mica-tools` 内相邻模块，不分散到应用层。
- 判断 retry 是否可重放依赖 `micaTools.isReadOnly(toolName)`；新增工具要认真设置 read-only 语义。
- 内置工具只读语义有全集测试锁死（`packages/mica-tools/tests/MicaTool.test.ts` 的 builtin read-only semantics）：纯查询类（`read_file`/`read_image`/`list_files`/`grep_search`/`web_fetch`/`web_search`/`Skill`/`background_tasks`/`read_task_output`）必须标 `readOnly: true`，写/执行类（`write_file`/`apply_patch`/`run_shell`/`kill_task`/`pty_*`）不得标。给工具改 read-only 标记时同步更新该测试。
- PTY 工具（`pty_spawn`/`pty_send`/`pty_read`/`pty_wait`/`pty_kill`）用于驱动交互式 TUI 程序做端到端验证，工具实现位于 `packages/mica-tools/pty/`。node-pty 的 native binding 在 Bun 进程内不工作，因此 PTY 会话由懒启动的 **Node 子进程**（`packages/mica-pty/src/server.mjs`，经 JSONL over stdio 通信）承载；Bun 主进程只做 IPC 和输出缓冲。node-pty 缺失或 Node 不可用时工具降级报错，不影响其他功能。
- PTY 工具在首次调用时动态 import `@packages/mica-pty/src/manager.js`（独立模块，不经过 `mica-pty/index.js`），避免 Bun 进程顶层加载 node-pty；`node-pty` 入口通过 `import.meta.resolve`（排除 Bun 虚拟 `$bunfs` 路径）或向上遍历 `node_modules`（含 `.bun` 缓存布局）解析，由 Node helper 从真实磁盘加载。node-pty 必须保持 external，禁止从生产代码静态 import `node-pty` 或 `mica-pty/index.js`（编译二进制的 Bun 运行时无法解析 node-pty）。
- `packages/mica-pty/src/ptyServerSource.ts` 是 `server.mjs` 的 JSON 转义内嵌（兼容 `bun build --compile`，打包器不支持 `?raw`）；改动 `server.mjs` 后必须运行 `bun run scripts/generate-pty-server-source.mjs`，`packages/mica-pty/tests/serverSource.test.ts` 会校验两者同步。

当前内置工具包括：

- `read_file`、`read_image`、`write_file`、`apply_patch`
- `list_files`、`grep_search`
- `run_shell`、`background_tasks`、`read_task_output`、`kill_task`
- `pty_spawn`、`pty_send`、`pty_read`、`pty_wait`、`pty_kill`
- `web_fetch`、`web_search`
- `Skill`

交互模式的 `TodoWrite` 由 Todo 插件注册；headless run 也会从不依赖 React/Ink 的 `plugins/builtin/todo/TodoTool.ts` 注册独立实例，使一次性 JSON 消费方能看到并展示结构化计划。Todo 状态仍只属于当前进程/turn，不写入 session；不要据此假设跨进程可恢复。turn 正常结束时插件会把遗留的 `in_progress` 项标为 `completed`（运行完不残留 pending 项、列表不再一直展示），只有 abort/error 才转 `pending`。

### MCP

- `packages/mica-mcp` 管理 MCP server 生命周期：读取配置、连接 server、注册远端 tools、重连、关闭和清理工具。
- MCP 配置来自 `~/.mica/config.json` 或 `$MICA_HOME/config.json` 的 `mcpServers`。
- Headless run 会显式初始化/关闭 MCP，并发连接各个独立 server 后按配置顺序合并工具；`--mcp-config <path>` 可加载额外配置，`--strict-mcp-config` 禁止混入本地配置，`--mcp-init-timeout-ms <ms>` 可限制单个 server 完成 connect + tools/list 的总时间。`mica-code-app` 的一次性 turn 会通过 `MICA_MCP_INIT_TIMEOUT_MS=2000` 传入上限，避免失效 MCP 在每轮冷启动时反复阻塞默认的 15 秒阶段超时，同时不让新版 App 对旧版外部 CLI 传入未知参数；交互模式和未显式传参/环境变量的 CLI 保持原默认值。
- 远端工具必须通过 `micaTools.registerMcp()` 接入；server 断开、重连失败或关闭时要同步清理对应工具。
- `/mcp reconnect <server>` 失败后也要刷新注册工具列表，避免 registry 中残留 stale tools。

### Web

- `web_search` 使用 `serperApiKey` 或 `SERPER_API_KEY`。
- `web_fetch` 负责 URL 抓取和 HTML 转 Markdown。
- 当用户询问当前、最新、官方、模型能力、provider 行为、API 行为、价格、法规等可变事实时，agent 应先联网或读官方资料查证；无法查证时要明确说明。

### Skills

- `packages/mica-skills` 只负责扫描、解析和缓存 skills，不执行 skill 内容。
- 用户级默认扫描 `~/.mica/skills`；设置 `MICA_HOME` 时扫描 `$MICA_HOME/skills`。项目级还扫描 `.mica/skills`、`.agents/skills`、`.deveco/skills` 和 `.agent_context/skills`，用于 Multica 等运行时注入。未设置 `MICA_HOME` 时兼容扫描 `~/.config/deveco/skills`。
- 每个 skill 是一个目录，目录内必须包含 `SKILL.md`。
- frontmatter 支持简单 key/value、boolean 和列表；列表值会被规范化为分号连接的字符串。
- `Skill` 工具会把 skill baseDir 和完整内容包在 `<skill-instructions>` 中返回，并支持简单 `$var` 参数替换。
- skill 内容是用户数据和任务说明，不能覆盖安全规则、系统指令或当前用户请求。

## UI 状态与 Ink 约定

- `packages/mica-ui` 只负责终端 UI 组件和状态 store，不直接调用 provider，不持有 agent 运行逻辑。
- 输入框在光标前出现 `@query` 时通过 `plugins/builtin/file-mention.ts` 注入的 provider 异步获取当前 cwd 文件；候选复用底部 dropdown，支持方向键、Enter/Tab 和 Esc。`mica-ui` 不直接扫描文件系统。
- Runtime 到 UI 的映射由 `MicaUiRuntimeBridge` 和 `runtime/uiBridge.ts` 完成。
- 主要状态入口包括 `conversation`、`terminalInput`、`dropdown`、`bottom`、`panels`。
- 对话消息可以携带 `displayContent`。它只改变 UI 展示，不改变发给 agent 的真实 `content`。
- `parseImageRefs` 把 `[Image](...)` 等引用转为 agent 可消费的多模态 content block。不要只发送纯文本图片占位符给模型。
- `TerminalAgentSessionManager` 为每个 agent 保存独立 UI snapshot，包括 conversationMessages、responseText、pendingInputs、messageBarMessages、agentTurnLogItems、thinkingText、pluginUIs、workingStatus、contextSize、cachedTokenRate。
- 多 agent 切换时，UI 要从对应 session.uiState 恢复，不要从当前 active agent 或 provider history 临时拼装。
- UI hot path 有明确上限：conversation messages、response text、pending inputs、message bar、agent turn log、thinking text 和 message text 都会截断或只保留尾部。
- 普通终端主界面使用 `rows - 1` 作为最小高度而不是固定高度：短内容保留终端最后一行，长 conversation 必须按自然高度扩展到原生 scrollback，避免 Yoga 收缩后文本越界覆盖后续消息和输入区。
- Ink stdin 在 `parse-keypress.ts` 解析前必须保持原始 `Buffer`；该层负责增量 UTF-8 解码，并把 DEC 8-bit C1 控制字节规范化为 7-bit ESC 序列。不要在 `App.tsx` 提前调用 `stdin.setEncoding('utf8')`，否则 S8C1T 模式下的终端查询响应会损坏并泄漏为输入。
- 长会话性能问题优先检查 retained buffers、rewind snapshots、Markdown 渲染输入、图片 payload、MCP 输出和 agent turn log，不要直接做大重构。
- `mica-code-app` 是终端风格的 Web 渲染，而不是常规网页聊天 UI。Chat 区要保持等宽字体、紧凑行高和一致字号；用户输入、用户消息、助手 Markdown、代码块、表格、队列和任务 dock 等主文本应共享同一个字号来源（当前为 `--chat-text-size`），不要在局部硬编码更小/更大的主文字字号导致视觉跳变。
- `mica-code-app` 的 session 侧栏/Stats 扫描使用 `src/main/stats-scanner.js` 按 dev/ino/size/mtime/ctime 做文件级增量缓存；metadata 与完整 stats 投影分别懒加载，单文件变化只能重读对应文件，稳定结果需缓存排序/去重输出。不要退回“目录任一指纹变化就同步解析全部 session”的模式。
- 打包桌面进程不经过 shell：GUI 应用由 launchd 直接拉起，不会自动执行登录 shell/profile。`apps/desktop/src/main/desktop-process-env.js` 在主进程启动时保留现有 PATH 顺序，并追加存在且可执行的用户工具目录、当前/最高可用 NVM/FNM Node bin 和常见系统目录，使 `npx` MCP、`rg`、Bun/Node 工具可被子进程找到。新增路径发现不能输出环境内容或把候选目录插到用户现有 PATH 前面。
- 为了让 GUI 启动的 mica 子进程也能拿到 `~/.zshrc` / `~/.bash_profile` 等 profile 里 export 的变量（如 `SERPER_API_KEY`），`apps/desktop/src/main/shell-env.js` 会在主进程启动时用 `<zsh|bash> -i -l -c env` 一次性采集 login/interactive shell 环境并缓存：`apps/desktop/src/main/index.js` 顶层 `warmShellEnv()` 预热，`apps/desktop/src/main/chat.js` 的 `buildSpawnEnv`（chat/commit 子进程，另加 `MICA_MCP_INIT_TIMEOUT_MS`）与 `mergeShellEnv`（models/compact 子进程）在 spawn 时合并。采集失败、超时（3s）或 Windows 上静默跳过并回退到继承环境；运行态键 `PWD`/`OLDPWD`/`SHLVL`/`_` 会被过滤。该机制只补充环境变量，不执行 alias/函数，也不替代 `desktop-process-env.js` 的 PATH 兜底。

## 多 Agent、Session、Rewind、Compact 与 Recap

- `TerminalAgentSessionManager` 管理同一终端内多个 agent session。`/new` 创建独立 agent，`/fork` 基于当前历史创建分叉 agent。
- 主 runtime 维护 per-agent queue、response buffer、committed buffer、session controller 和运行状态。
- `switchSession(agent, sessionController)` 必须同步 runtime 当前 agent、session controller、queue UI 和 UI bridge 当前 agent。
- `/fork` 和后台 agent 相关命令要注意 provider/model/effort/role 与 UI snapshot 的一致性。
- `Agent` 工具的后台 subagent 由 `SubagentTaskManager` 管理：按 parent agent 隔离 task，使用独立 abort signal，并通过 runtime system queue 把完成元数据回注 owner。原始结果需用 `Agent operation=read` 显式读取，也可用 `operation=await` 等待完成；system queue 不与单槽用户输入队列争用，也不会自行唤醒空闲 parent 执行工具。
- foreground 和 background subagent 的任务记录都会留在 `SubagentTaskManager` 中供 `/task` 查看；每个 parent 最多保留 100 条，结果只在当前进程内存在。`/task` 的列表只保存轻量 summary，完整 prompt、context、usage、error 和 result 在打开详情时按 ID 获取。
- subagent 的逐条模型请求由 `ToolAgent` 在任务结束时（completed/failed/killed/partial）深拷贝 `child.usageHistory` 写入 `AgentRuntime.recordSubagentUsage`，随 session snapshot 持久化到 `subagentUsageHistory`；`providerHelpers.executeProviderToolCall` 会把当前 tool call id 以 `toolCallId` 注入工具执行 context，`ToolAgent` 据此记录 `initiatedByCallId`。headless exec 投影不输出 subagent 事件，统计由 `mica-code-app` stats 侧按 `occurredAt` 展平归档。
- Ctrl+C 中止 parent turn 时必须同步 abort 该 owner 的 running subagent，并保留 `killed` 记录供诊断；清理 session/owner 时则终止运行任务并移除其全部 retained subagent 记录。
- 输入框上方 `TaskStatusBar` 展示 active subagent 时使用树形摘要：主行保留 kind/status/时长/type/description；子行用 `⎿` 展示并行 in-flight tool 摘要；嵌套 subagent 通过 `parent_task_id` 挂到父任务下。activity 只保留进行中的摘要，并对短工具调用保留最短可见时长（约 900ms）以减少闪烁；任务结束即清空。
- subagent 默认允许父 agent 选择 effort；省略时继承 parent effort，definition 可用 `effort: false` 强制为 `none`。`maxTurns` 必须传到 provider query loop，未知 `subagent_type` 必须报错，不得静默降级。
- subagent 默认不继承完整对话历史，而是按 `context_mode`（`none|brief|recent|files`）注入 `<delegated-context>` 任务包；默认 `brief`。
- 可写 subagent 支持 `owned_paths` 路径租约；`Implementer` / `Tester` / `Proposal` 必填。写工具（`write_file` / `apply_patch`）和 `run_shell` cwd 会校验路径所有权，重叠租约会在启动时拒绝。
- `Agent` 支持 `operation=run_many`（`tasks` + `depends_on` + `max_parallel`）和 `operation=join` 汇总多个 task 结果。
- `Proposal` 为不落盘提案模式，只返回 patch 文本供 parent 审查后 apply。
- 当前内置 subagent 类型：`general-purpose`、`Explore`、`Implementer`、`Reviewer`、`Tester`、`Planner`、`Proposal`。
- `RewindCheckpointManager` 在 turn 前创建对话和文件 checkpoint，并始终保留“用户输入之前”的状态。内存 checkpoint 缺失（例如 `/resume` 后）时，runtime 从仍可对齐的 provider/UI history 动态生成仅对话节点；compact 后无法精确对齐的更早节点不伪造，历史文件状态也不推断。
- `packages/mica-context` 提供 `CompactionService`。compact 结果通过 runtime/session 层接入对话，不应让 provider adapter 直接感知 compact 策略。
- `/compact` 是上下文压缩 checkpoint，适合减少后续上下文压力。
- compact 可以裁剪 tool result、媒体和 base64，但绝不能把 tool-call `arguments` 截成自由文本；过长或损坏参数必须改写成合法 JSON 占位，否则后续 provider 请求会 400。
- compact 应用 checkpoint 时必须保留原 `usageHistory`/`lastUsage`，禁止清零：清零会丢掉 compact 之前的 token 统计，导致 mica-code-app Stats 与上游平台（krill 等）对账出现整段缺口。两处应用点（`apps/cli/src/plugins/commands/commandRuntimeServices.ts` 的 `/compact`、`apps/cli/src/cli/runCompact.ts`）已按此约定实现。
- compact、review、commit 等命令如果需要模型调用，应通过 subagent 或 exclusive task 隔离，不要污染当前正在运行的 turn。

## Package 依赖边界

所有 package 都通过 `index.ts` 暴露公共 API。应用层优先从 `@packages/<name>/index.js` 引用。

- `mica-common` 不依赖任何产品业务包。
- 共享图片格式与尺寸识别位于 `mica-common/image.ts`，由 UI 图片输入和 `read_image` 工具共同复用；图片原始字节直接传给 provider。
- `mica-agent` 不依赖 UI、session、commands 或应用入口。
- `mica-ui` 不直接调用模型 provider，不持有 agent 运行逻辑。
- `mica-runtime` 只定义协议和状态原语，不做具体 turn loop 编排；Codex exec ThreadEvent JSONL（`packages/mica-runtime/codexExecEvents.ts`，`mica exec --json` 用）与 Codex v2 app-server 协议（`packages/mica-runtime/codexProtocol.ts`，`mica app-server` 用）都属于协议层。它不是 Claude SDK stream-json。
- `mica-commands` 只放通用命令机制，产品命令放在 `mica-builtin-commands`。
- `mica-builtin-commands` 通过 services 注入外部能力，避免直接导入应用层单例。
- `mica-tools` 统一管理工具定义和执行，MCP 工具也必须通过它注册。
- `mica-mcp` 管理 MCP 生命周期，但远端工具注册仍走 `mica-tools`。
- `mica-session` 只负责持久化，不调用模型、不渲染 UI。
- `mica-context` 提供上下文处理能力，不直接操纵 provider adapter。
- `mica-skills` 只扫描、解析、缓存 skills，不执行 skill 内容。
- `mica-plugin` 只提供插件机制，不内置具体产品插件。
- `mica-pty` 提供 PTY 测试驱动（`PtyDriver`，Node ≥22 / vitest 下使用）和内置 PTY 工具运行时支持（`PtyManager` + Node helper server，Bun 主进程通过 IPC 使用）；`src/manager.ts` 不 import node-pty，`index.ts` 仍导出 `PtyDriver`（其顶层 import node-pty，因此生产代码不要静态 import `mica-pty/index.js`）。
- `plugins/builtin` 放官方产品策略和流程；运行期插件通过 `PluginContext` 的 commands、hooks、services、runtime queue、tools 和 UI capability 接入，不反向 import `src/**`。

如果新增代码会导致底层包依赖上层包，不要直接加 import。优先使用类型、回调、service、hook 或 adapter 注入能力。

## Import 与代码风格

- 根 tsconfig 配置了 `@packages/*` alias（映射 `./packages/*`）和 `@apps/*` alias（映射 `./apps/*`）。package 不得通过 `@apps/*` 反向依赖应用；应用能力和构建元数据通过 services、参数或抽象注入。
- `apps/cli/src/` 中引用 package 统一使用 `@packages/<name>/index.js`，除非需要访问该 package 明确公开的相邻模块或测试目标。
- 每个 package 的公共 API 通过 `index.ts` 聚合导出；新增公共能力时同步更新导出入口和 README。
- 默认不使用动态 import。启动入口为确保 `validate-config` 在 `mica-config` 创建模块级快照前运行，可以在明确的进程模式分派边界延迟加载应用或 Config Web server；PTY 工具首次调用时动态加载 `mica-pty` 的 manager 模块属于同样的显式延迟边界（避免 Bun 进程加载 node-pty）。
- import 路径风格保持与所在文件周边一致。
- 不把应用装配逻辑塞进 package；package 需要上层能力时，通过抽象注入。
- TypeScript 使用 strict、isolatedModules、verbatimModuleSyntax。类型导入应使用 `import type`。
- 代码注释保持克制，只在复杂流程、不明显不变量或 workaround 前写短注释。
- 默认不要做无关格式化、无关重命名或顺手重构。

## 测试与验证

- 单元/集成测试走 `bun run test`（vitest，Node 环境）；涉及交互式 TUI 的测试或验证优先使用 `packages/mica-pty`。
- vitest include 覆盖 `apps/**/*.test.{ts,tsx}`（sync web 的组件冒烟测试是 `.tsx`，用 react-dom/server 渲染验证终端风格结构）；`apps/desktop` 是独立 npm 项目，其测试用项目内 `bun test` 且依赖 `apps/desktop/node_modules`（未安装时测试不可运行，属环境问题而非代码问题）。
- `packages/mica-pty` 提供两类能力：`PtyDriver`（直接 import 的 PTY 测试驱动，Node ≥22 / vitest 下使用——node-pty 的 native binding 在 Bun 下不可用，因此**不要从 `bun run` 代码里 import `PtyDriver`**）和内置 PTY 工具运行时（`PtyManager` + Node helper 桥接，Bun 主进程可安全使用，见 Tools 章节）。
- 用 mica-pty 做冒烟验证（需要真实 provider API key，默认跳过）：

```bash
bun run build   # 生成 dist/mica
MICA_PTY_SMOKE=1 npx vitest run packages/mica-pty/tests/mica.smoke.test.ts
```

- 真实用户流冒烟套件（`packages/mica-pty/tests/user-flows.smoke.test.ts`）：通过 PTY 驱动 `dist/mica` 模拟真实用户，覆盖全新配置启动、全部内置命令面板（`/status` `/context` `/skills` `/mcp` `/rename` 等）、真实模型多轮对话与文件工具（create/append/read）、多 agent（`/new` `/fork` `/task`）、`/clear` 会话隔离、`--resume` 跨重启恢复、Shift+Tab role 切换、随机命令序列 + resize + 快速输入的压测。需要真实 provider API key，默认跳过：

```bash
bun run build   # 生成 dist/mica
MICA_PTY_FLOW_SMOKE=1 MICA_PTY_SOURCE_HOME="$HOME/.mica" npx vitest run packages/mica-pty/tests/user-flows.smoke.test.ts
```

- 协议级端到端套件（`apps/cli/src/cli/app-server.flows.test.ts`）：真实 spawn `mica app-server` 子进程（`bun apps/cli/src/index.ts`），用本地 mock OpenAI 兼容 provider（可编程返回正常 SSE 流 / 400 错误 / 延迟 / function_call 工具流），模拟 mica-code-app chat host 的完整调用链。覆盖的真实用户流：`turn/start` 带完整 `provider/model` ID + effort 切模型对话、`turn/interrupt` 运行中马上停止、provider 失败时 `turn/completed` 必须透传真实 error（否则 app 静默无提示）、忙时 `turn/steer` 排队后同 host 自动续跑、**工具任务完成（write_file 真实落盘 + 第二轮请求带 function_call_output）后继续对话并延续历史**、**`mica compact --session` 压缩成 checkpoint 后重开 host 恢复并继续对话（恢复的 provider 请求携带 compact summary）**、**工具轮中 Shift+Tab 在迭代边界注入（after_iteration 需要两次完整迭代边界才释放输入，mock 需连续两个 function_call 轮）**、**busy 时快速第二条消息被 host 拒绝（错误响应而非崩溃）**、**interrupt 后排队输入继续在同 host drain**。回归点：切模型后完整模型 ID 被直接发给 provider 导致 400（必须剥 provider 前缀）、interrupt 竞态。compact 测试要点：至少两轮对话且上下文超过 recent-token budget 才会真正摘要（否则返回 `not_needed` 是设计行为），resume host 必须复用同一 `MICA_HOME`。**不需要真实 API key，默认随 `bun run test` 运行**（无 bun 时自动 skip）。

vitest 会把 `HOME` 重定向到临时目录，因此必须显式传 `MICA_PTY_SOURCE_HOME`（真实 `~/.mica`，测试只复制 `config.json` 到隔离的 `MICA_HOME`，不触碰用户数据）。
套件的 `dist/mica` 路径按仓库根解析，可用 `MICA_PTY_BIN` 覆盖（自定义构建/其他路径）。

- mica-pty 常规测试：`bun run test -- packages/mica-pty/tests/driver.test.ts packages/mica-pty/tests/manager.test.ts packages/mica-pty/tests/serverSource.test.ts`。API 与用法见 `packages/mica-pty/README.md`；旧 python 驱动 `temp/mica_pty.py` 保留作为参考。
- 注意 node-pty 的 prebuild `spawn-helper` 通过 Bun 安装时可能缺执行位，`PtyDriver.spawn()` 会做幂等 chmod 兜底。

## 命令范围与临时目录

- `temp/` 是临时代码目录，已被 git 忽略，不属于默认源码、测试、格式化、构建或搜索范围。
- `.backups/` 是临时备份痕迹，不应作为默认实现、验证或文档输入。
- 递归搜索优先使用 `rg` 或 `rg --files`，并排除 `temp/`、`node_modules/`、`dist/` 等目录。
- 如果必须手写递归命令，使用白名单路径或排除规则，例如：

```bash
rg "pattern" src packages scripts docs blogs --glob '!temp/**'
rg --files src packages scripts docs blogs
```

- 只有用户明确要求检查 `temp/` 或某个备份目录时，才进入这些目录。

## Mica Sync 远程会话同步

`mica daemon`（`apps/cli/src/features/sync-daemon`）+ `apps/sync/server` + `apps/sync/web` 组成 Mica Sync：所有机器上的活跃/历史会话镜像到一台中心服务器，浏览器实时查看并回源续聊。三端共享的 wire 类型（`DaemonCommand`、`SyncEvent`、机器/会话 DTO）在 `packages/mica-sync-protocol`，改协议形状时同步检查该包与三端引用。部署与 Web 使用说明见 `apps/sync/server/README.md` 和 `apps/sync/web/README.md`。

### 架构与协议

- 机器端 `mica daemon` 常驻进程主动**出站**连接中心服务器（NAT 友好，不需要机器开放入站端口）：`/daemon/register` 注册换取 `machineId`（按 hostname 复用已有记录，丢失 sync.json 不会换身份），`/daemon/beat` 心跳（20s，上报活跃会话），`/daemon/poll` 长轮询指令（server 最多 hold 25s），`/daemon/session` 推送会话快照，`/daemon/events` 推送 turn 事件。
- 中心服务器 `mica-sync-server` 零第三方依赖（Node 内置模块），JSON 文件存储（`data/machines.json`、`data/sessions/<machineId>/<sessionId>.json`），每会话 500 条事件内存缓冲，SSE 订阅用 `since` 序号断线补拉。
- **无认证**：daemon 请求用 `x-machine-id` header 标识机器，Web API 完全开放；服务公开在公网时需自行用 Nginx 基本认证或防火墙保护。
- 指令（`create` / `run` / `update_cwd` / `abort`）通过 poll 长轮询下发；`create` 由服务器生成 `sessionId` 并携带 `prompt` 与可选 `cwd`，daemon 用本机配置创建全新会话并执行首条消息；`update_cwd` 由 Web 切换工作目录时下发，daemon 更新本地会话文件（bump revision/updatedAt）后推送新快照，不执行 turn，会话被 turn lease 占用时拒绝并回 `cwd_update ok:false` 事件；daemon 同一时刻只执行一个 turn（busy 时发 `run_rejected` 事件），不同 session 也不并发。poll 长轮询监听请求 `close` 事件清理断开连接的 waiter，避免死 waiter 抢占指令。
- 事件类型：`user_input`、`thinking`、`text_delta`、`tool_call`、`tool_result`、`usage`、`status`、`turn`（state: completed/aborted/error）、`run_rejected`、`session`、`session_removed`；队列相关：`queued`（携带 prompt/position/queueMode）、`dequeue`、`queue_state`（携带 queuedCount/queuedItems，供 Web 展示排队消息）。

### daemon 语义

- 配置存 `~/.mica/sync.json`（跟随 `MICA_HOME`），含 `serverUrl`、`machineId`、`name`。`--server` 覆盖 serverUrl；未注册时启动即自动注册（无需 secret）。
- **daemon 自启动**：交互模式启动 `mica` 时（`apps/cli/src/index.ts`）会 fire-and-forget 调 `ensureDaemonRunning()`（`apps/cli/src/features/sync-daemon/ensureDaemonRunning.ts`）：配置了 sync.json 且 `daemon.pid`（`MICA_HOME/daemon.pid`）记录的进程不存活时，后台 detached 拉起 `mica daemon`（日志追加到 `MICA_HOME/daemon.log`），否则复用。daemon 自身启动时写 pid 文件、退出时清理，并对"已有存活 daemon"做竞态兜底（直接退出，避免双 daemon 抢同一 machineId）。`MICA_NO_DAEMON=1` 可禁用（CI/headless）。改动 pid 文件、spawn 参数或自启动时机时同步检查 `apps/cli/src/features/sync-daemon/ensureDaemonRunning.ts` 及其测试、`apps/cli/src/features/sync-daemon/index.ts`。
- `CommandExecutor` 复用共享的 `HeadlessTurnExecutor` + **每会话常驻 host**（不再每 turn 新建 agent）：`hostFor(session)` 首次按 `resumeLoaded` 构造 `AgentRuntime` + `SessionController`（headless 式配置：`config.apply(){}` + `ui.restore(){}`）后缓存，后续 turn 直接复用内存上下文，MCP 保持 daemon 生命周期常开；turn 前 `chdir` 到会话记录的 `cwd`。同一会话在 busy 期间的输入经 host 队列排队并支持 after_iteration 注入；不同会话仍只执行一个 turn（其他会话 `run_rejected`），host 队列排空后通过 `onIdle` 释放全局 busy 和 turn lease。`create` 指令在本地会话不存在时，用 `new AgentRuntime()` 的当前 snapshot（provider/protocol/model/effort/role）与空历史构造 `PersistedSession`，`cwd` 缺省回退到 daemon 机器家目录，再走与 `run` 相同的 turn 流程；构造时必须先用非空标题（如 `Untitled session`）落盘，否则 `resumeLoaded` 记录的 persisted signature 会让 `saveCurrent` 因磁盘无文件而拒绝写入，且 `parsePersistedSession` 会拒绝空标题。
- abort 依赖 `AgentRuntime.abort()`（runId 失效 + signal）：正在等待 provider stream 时立即生效；**工具执行中或长 thinking 期间要等到当前迭代/工具结束的边界**才会抛出 `AgentAbortError`，属于 provider client 的既有语义，不要另造中断机制。同一 poll batch 中排在 run/create 前面的 abort 只按后续 command id 精确取消该命令；空闲 session 的孤立 abort 不得污染未来 turn。
- 会话文件变化由 `SessionWatcher` 监听并推送；`fs.watch` 在 macOS 上可能丢事件（rename 无 filename），因此还有 30s 周期 rescan 按 mtime/size 对比兜底。push 失败只记日志不重试队列。
- 本地 runtime 与 daemon 对同一 session 使用 `packages/mica-session` 的跨进程 turn lease，冲突时返回 busy，避免整份 session 快照相互覆盖；远程完成后，本地下一次提交前会重载最新磁盘快照。会话快照带单调 `revision`，中心服务器拒绝迟到的旧快照。
- Web 端切换会话时会真正中止旧 SSE，按事件 `seq` 去重；terminal turn 后主动重拉权威快照，并以低频轮询从丢失事件或代理断流中自愈。
- 会话详情接口默认返回精简快照（剔除 `snapshot.messages`/`usageHistory`，但保留 `lastUsage` 供 Web 渲染上下文占用，`?full=1` 取全量）；SSE 的 `session` 事件只含元数据（id/title/updatedAt/cwd/turnState/revision + providerId/model/effort/role），完整快照仍全量落盘。detail 响应携带 `snapshotSeq`（最近一次 session 快照事件的 seq），Web 在详情加载完成后再建 SSE（`since=snapshotSeq`），避免重放已反映在快照中的旧事件造成重复渲染。改动这两处协议时同步检查 `apps/sync/web/web/src/App.tsx` 的 `acceptEventSession`/`publishSession`/`sessionReady` 逻辑与 `useSse.ts` 的初始断点。
- `PersistedRuntimeSnapshot` 含可选 `contextWindowSize`（模型上下文窗口 token 数）：`SessionController.toPersistedSnapshot` 与 daemon `createTurn` 写入（`micaConfig.getModelRule(model).contextSize`），旧快照缺失时 Web 只显示 token 与 cached%，不显示 ctx%。Web 上下文摘要（`model_effort` + `N.NK (cached %, ctx %)`）由 `lastUsage` 计算，SSE `usage` 事件实时更新。
- daemon 推送快照前用 `withContextWindowSize` 补齐旧快照缺失的 `contextWindowSize`（`micaConfig.getModelRule(model).contextSize`），服务器 `lightSession`（SSE `session` 事件）也携带该字段；Web 端 `publishSession` 浅合并新旧快照避免轻量事件覆盖掉 detail 已加载的字段，并内嵌 `KNOWN_CONTEXT_WINDOW` 兜底（缺字段时按模型名估算，fallback 1M）保证 ctx% 始终可渲染。
- Web 新建会话：`POST /api/machines/:id/sessions`（body `{ text, cwd? }`）返回新 `sessionId`；创建成功后 Web 立即跳转该会话并加入 `pendingSessionsRef`（detail fetch 在 daemon 落盘前 404 时抑制报错，等第一条 SSE `session` 事件渲染）。SSE 首次收到的轻量 `session` 事件在 `sessionData` 为 null 时也会 `publishSession`（无消息 payload，仅渲染 header/输入框），消息列表由流式事件构建，turn 结束再拉权威快照合并。
- Web 切换工作目录：发送按钮左侧的 cwd 选择器（`CwdPicker.tsx`）展示当前 cwd，点击弹出最近使用目录（来自该机器会话列表去重）+ 自定义输入；提交后调 `POST .../cwd` 乐观更新本地 cwd，失败时显示 `cwd_update ok:false` 事件的错误信息。`update_cwd` 由 daemon 更新会话文件后经 SessionWatcher/onSessionSaved 推送，服务器按 revision 单调接受。
- Web 切换体验：`/api/machines/:id/sessions` 列表为每个 summary 附带 `snapshotSeq`，切换时立即开 SSE（`since=` 列表水位，detail 校正），不出现"连接断开"；切换瞬间显示"加载会话中…"而非 welcome 闪现。`useSse` 的 `lastSeqRef` 跨 effect 重启保留，绝不重放已见事件（`text_delta` 重复追加）。连接状态三态：实时连接 / 连接中… / 连接断开，自动重连中…。`serveStaticFile` 对 index.html 发 `no-cache`、对 `/assets/*` 发 `immutable` 一年缓存。

### 构建与部署

- `bun run build:sync-server` 产出 `dist/mica-sync-server.js`（Node 单文件 ESM bundle）；`bun run build:sync-web` 产出 `apps/sync/web/dist`（vite `base: './'`，可部署到任意子路径）。
- 生产部署在 `188.253.118.143`：`/opt/mica-sync/`（`mica-sync-server.mjs` + `web/` + `data/`），pm2 进程名 `mica-sync`，监听 5560；Nginx `location /mica/` 反代（必须 `proxy_buffering off` + 长 read timeout，否则 SSE 断开）。
- **pm2 必须用 `pm2 start node --name mica-sync -- mica-sync-server.mjs ...` 显式指定解释器**；直接 `pm2 start mica-sync-server.mjs` 不会执行 ESM bundle 的入口。
- **deploy-server 的 `/upload` 用法**：body 必须是原始 tar 二进制（`curl -X POST --data-binary @dist.tar.gz`，不支持 multipart）；`path` 是服务器端**临时存储路径**（extract 后或未 extract 时都会被删除，不能用作正式落盘路径，写普通文件用 `POST /file { path, content }`）；`extract=1` 会 **`rm -rf` 清空 `target`** 再解压。重新部署 web 前先 `mv /opt/mica-sync/data /tmp/mica-sync-data-backup`，上传解压（tar 只含 `dist/` 内容、不带顶层目录）后再把 data 移回并 `pm2 restart mica-sync`，否则机器注册和会话记录会丢失；只更新静态文件时解压到临时目录再 `mv` 覆盖 `/opt/mica-sync/web`，不要碰 server 和 data。
- sync web UI（`apps/sync/web`）与 mica-code-app（`apps/desktop` renderer）共用同一套展示词汇：等宽终端字体、`#0e0e0e` 暗色、`--chat-*` 变量、消息 `marker|body|time` 网格、`chat-markdown`（react-markdown + remark-gfm，根依赖与 desktop 同版本）、工具行 `icon + label + args + state + duration`、状态行 `model_effort · tokens (cached %, ctx %)`。展示数据计算（工具图标/标签、usage 归一化、context 摘要、耗时格式化）在 `packages/mica-web-shared`，改任何一侧的展示形态时同步检查另一侧。移动端（≤768px）隐藏消息时间列、侧栏抽屉全宽、触控目标 ≥36px、输入框 16px 防 iOS 缩放、safe-area-inset-bottom。
- 服务器信息与 remote-shell 使用方式见 `qirong-application/Agent.md`；该文件记录了同一台服务器上的所有服务，变更服务器配置后要同步更新。

### Config Web 的 Sync 页面

- Config Web（`mica config-web` 或 worker 模式）侧边栏有 `Sync` 菜单：配置中心服务器地址（写 `~/.mica/sync.json`）、机器名，并展示服务器可达性、本机 daemon 是否在线、服务器上全部机器的在线状态。
- 后端路由：`GET /api/details/sync`（`apps/config-web/src/server/syncDetails.ts` 读取 sync.json 并探测服务器）、`PUT /api/files/sync`（保存 serverUrl/name）。探测逻辑调用中心服务器无认证 API `/api/machines`，按 machineId（缺失时按 hostname）判断本机在线。
- 修改 sync 相关字段（serverUrl、name、machineId 语义、探测判定）时同步检查该文件与 shared/types.ts 的 `ConfigWebSyncDetails`。

## 构建、安装与发布

- `bun run build` 实际运行 `MICA_PREBUILD_DONE=1 bun scripts/build.mjs`。
- `prebuild` 是 `bunx tsc --noEmit`。
- `postbuild` 是 `bun scripts/install.mjs`。
- `scripts/build.mjs` 使用 `bun build --compile --compile-autoload-package-json` 构建无外部运行时依赖的本地二进制，默认输出 `dist/mica`。
- `packages/mica-common/image.ts` 校验 JPEG、PNG、GIF、WebP 文件签名，并尽可能读取尺寸；不缩放或重编码图片，原始字节由 provider 发送给上游模型 API。
- `scripts/install.mjs` 默认把二进制安装到 `$HOME/.local/lib/mica`，并在 `$HOME/.local/bin/mica` 写一个薄 launcher；可用 `MICA_INSTALL_DIR`、`MICA_INSTALL_PACKAGE_DIR`、`MICA_BIN_NAME` 覆盖。
- 产品名是 Mica Code / `mica-code`；release installer 模板是 `scripts/install.sh`，默认安装启动命令为 `mica`（可用 `MICA_BIN_NAME` 覆盖）。
- release 安装采用按平台下载：`install.sh` 自身很小，探测 os/arch 后只下载对应 `mica-code-<platform>-<cpu>.tar.gz`，并用 `sha256sums.txt` 校验；不再把全部平台二进制 base64 嵌入安装脚本。
- GitHub Actions 页面上的 `mica-code-release` artifact 是 4 个平台压缩包的 CI 汇总包，不是用户安装路径；用户只下载 `install.sh` + 当前平台 `.tar.gz`。可变 `latest` release 每次重建，避免残留旧 bare binary。
- `.github/workflows/build-binaries.yml` 在 push、PR 和手动触发时运行根 typecheck/test，并在独立 job 中运行 Desktop test/lint；在 `main` 或 `v*` tag 上构建 Linux/macOS x64/arm64 release 二进制，打包单平台 `tar.gz`（`GZIP=-9`）、薄 `install.sh` 与 `sha256sums.txt` 后上传 release asset。
- `.github/workflows/deploy-pages.yml` 在 `main` 分支变更 `website/**`（或手动触发）时构建 `website/` 并发布到 GitHub Pages（`https://qirong77.github.io/mica-code/`）：`actions/configure-pages` **只暴露 `base_url`/`base_path` 等 outputs，不会注入 `PAGES_BASE_PATH` 环境变量**；workflow 的 Build 步骤用 `env.PAGES_BASE_PATH: ${{ steps.pages.outputs.base_path }}` 显式传入，`website/astro.config.mjs` 把它归一化（补尾斜杠，缺省 `/`）后作 Astro `base`（本地 dev/preview 不设置该变量，base 为 `/`）。`base_path` output 不带尾斜杠（如 `/mica-code`，用户主页为空字符串），必须在 config 里补尾斜杠，否则模板 `${base}mica.svg` 直接拼接会生成 `/mica-codemica.svg` 这类错位路径。Astro 不会自动给模板中硬编码的绝对路径加 base 前缀，因此布局/页面里所有内部链接（`mica.svg`、`screenshots/`、`docs/`、锚点）都必须用 `import.meta.env.BASE_URL` 拼接，CSS 用 frontmatter `import` 而不是 `<link href="/src/...">`；新增页面或资源时保持这个约定。
- 如果用户报告启动、startup UI、build/install 行为与源码不一致，先确认实际运行的是哪个入口：`~/.local/bin/mica` launcher、`~/.local/lib/mica/mica`、`dist/mica` 可能不一致。

## Git 与工作区安全

- 工作区可能有用户未提交改动。开始修改前查看 `git status --short`。
- 不要回滚、覆盖、格式化或删除与任务无关的用户改动。
- 如果要修改一个已有未提交改动的文件，先读清楚当前内容并以当前内容为基础补丁合并。
- 不要使用 `git reset --hard`、`git checkout --`、强推、批量删除等破坏性命令，除非用户明确要求并确认。
- 不要为了通过检查使用 `--no-verify`。
- 不要自动 commit、push、创建分支或开 PR，除非用户明确要求。

## 变更前检查清单

改代码前，先判断本次任务是否触及这些边界：

- provider/model/effort/role 切换：忙碌检查、config/storage 分离、effort clamp、context size、role snapshot 继承与缺失回退。
- provider 协议：Chat Completions、Responses、Anthropic Messages 的请求参数和 history normalizer。
- turn loop：queue、retry、abort、partial response、session save、hooks。
- UI 状态：`TerminalAgentSession.uiState`、conversationMessages、responseText、thinkingText、workingStatus。
- 多 agent：active proxy、owner-aware queue、background agent、session switch。
- MCP/tools：registry 清理、read-only 标记、输出截断、shell 后台任务。
- skills：`MICA_HOME`、frontmatter、Skill 工具读取方式。
- session/rewind/compact：snapshot 版本、UI restore、provider history 与 display state 的边界。
- build/install：本地 `dist/mica` 和已安装 `mica` 是否一致。
- docs：本文件、README 和 package README 是否需要同步。

只要答案是“会影响”，就把文档同步作为本次交付的一部分。
