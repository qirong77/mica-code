# Mica Code Agent 手册

本文件是 Mica Code 仓库的长期工程说明，面向后续 agent 和开发者。它不是普通 README：`packages/mica-agent/prompt/index.ts` 会在当前工作目录读取根目录 `AGENT.md`，并把内容注入系统提示词的 `<project-instructions>` 段。因此这里的文字会直接影响 Mica Code 自身在本仓库里的工作方式。

本文件的优先级低于系统、开发者和当前用户指令，但高于普通实现偏好。源码、测试和 package README 是具体事实来源；如果本文件与当前代码不一致，以当前代码为准，并在同一次变更中修正本文件。

## 维护红线

- 如果本次变更涉及 `AGENT.md` 所描述的事实、约束、目录、命令、配置、运行链路或开发流程，必须在同一个变更中更新本文件。
- 新增、删除或重命名长期模块、核心服务、内置命令、公共 package、provider 协议、工具注册方式、session 存储格式、runtime 生命周期、UI 状态模型、本地数据格式或验证命令时，同步更新本文件对应章节。
- 修改用户可见命令时，同步检查根 `README.md` 常用命令列表和 `packages/mica-builtin-commands/README.md`。
- 新增 package、移动公共 API、改变依赖边界或修改导出入口时，同步检查 `packages/README.md` 和对应 package README。
- 修改 prompt 构建、skills 加载、工具描述、联网策略或 project instructions 读取方式时须特别谨慎：这些改动会改变 agent 行为和 prompt cache 前缀。
- 不要把本文件写成流水账。它只记录会影响未来修改方式的稳定约束、架构边界、运行链路和验证习惯。

## 项目定位

- Mica Code 是基于 Bun、TypeScript、React 和 Ink 的终端 code agent。
- 仓库结构是 `src/`（实际为 `apps/cli/src/`）应用装配层加 `packages/` 可复用包。新增稳定领域能力优先沉淀到对应 package，应用层负责 wiring、生命周期和跨包编排。
- 设计偏向 append-only 会话历史和稳定 prompt 前缀；只有上下文压力明显时才在明确阶段边界 compact。
- Mica Code 是终端原生工具。UI 保持信息密度、低噪音、键盘优先、状态明确，不引入营销式页面或装饰性 UI。

## 快速命令

项目使用 Bun 作为包管理器和运行时，Node 要求 `>=22`。

```bash
bun install               # 安装依赖（apps/desktop 是独立 npm 项目，用 cd apps/desktop && npm install）
bun run dev               # 开发运行：bun run apps/cli/src/index.ts
bun run typecheck         # bunx tsc --noEmit
bun run test              # Vitest：vitest run
bun run build             # 先 typecheck，再 compile 单二进制，postbuild 安装本地入口
bun run dev:config-web    # Config Web Vite 调试
npm run build:app         # 构建桌面应用（apps/desktop）
bun run build:sync-web    # Mica Sync Web 前端构建（apps/sync/web/dist）
bun run build:sync-server # Mica Sync 中心服务 Node bundle（dist/mica-sync-server.js）
bun run format            # 格式化 README、AGENT、apps、plugins、packages、scripts、docs、blogs
```

常用局部验证：

```bash
bunx tsc --noEmit
bunx prettier --check AGENT.md
bun run test -- <测试文件>      # 局部测试显式传路径
git diff --check
```

不要使用 Bun 自带的 `bun test` 运行项目测试；它不兼容测试中使用的部分 Vitest API。项目级测试入口是 `bun run test`。

## 源码版图

```text
apps/
  cli/src/                      Mica CLI 主应用
    index.ts                    CLI 入口：模式分派（--version/models/headless exec/commit/compact/交互/app-server）、错误钩子、Application 启停
    cli/                        argv 解析、modelCatalog、runExec/runCompact/runCommit、runAppServer（Codex v2 app-server 协议）
    agent/                      AgentRuntime：provider client 生命周期、run/abort/snapshot/config reload
    agents/                     terminalAgentSessions（多 agent 与 per-agent UI snapshot）、subagentDefinitions、SubagentTaskManager
    app/                        Application/ApplicationContext/createApplication、activeContext、builtinPlugins、LocalRuntimeController、MicaUiRuntimeBridge
    plugins/commands/           内置命令 host adapter 和 active proxy
    runtime/                    RewindCheckpointManager、ToolLogController、CodexProjector/CodexExecProjector、HeadlessTurnExecutor、uiBridge
    headless/                   HeadlessPluginHost（headless 插件装配层）+ headlessRuntimeServices（headless CommandRuntimeServices）
    session/                    SessionController：session 保存、恢复、重命名和 UI restore
    features/sync-daemon/       mica-sync 机器端 daemon（注册/心跳/长轮询/命令分发、SessionWatcher、SyncClient、CommandExecutor）
    tools/                      ToolAgent：启动/查询/停止 subagent
  desktop/                      Electron 桌面应用（mica-code-app）
  config-web/                   本地配置 Web（server + 内嵌静态资源）
  sync/server/                  中心聚合服务（零依赖 Node 单文件，REST/SSE/长轮询/JSON 存储）
  sync/web/                     Sync Web 控制台（React + Vite，查看会话 + 远程续聊）
  website/                      官网源码（Astro 静态站）

packages/
  mica-agent         agent 抽象、provider adapter、prompt 构建
  mica-tools         内置工具、工具 registry、MCP 工具接入
  mica-mcp           MCP 配置读取、server 连接管理、远端工具适配
  mica-ui            Ink 终端 UI 组件和状态 store
  mica-runtime       runtime 协议、事件、状态、输入和消息队列原语（含 codexProtocol、codexExecEvents）
  mica-session       会话快照本地保存、读取和列表
  mica-config        本地配置、storage、模型列表、Models.dev 查找、runtime env
  mica-commands      通用斜杠命令注册与分发
  mica-builtin-commands   Mica Code 内置产品命令
  mica-context       上下文管理，当前主要是 compact
  mica-skills        用户 skills 扫描、解析和缓存
  mica-plugin        插件生命周期、hooks、service container
  mica-common        跨包共享底层工具（含 image.ts 图片格式识别）
  mica-pty           PTY 测试驱动 + 内置 PTY 工具的 Node helper（node-pty 只在 Node 子进程加载）
  mica-sync-protocol mica-sync 三端共享的 wire 协议类型，无运行时代码
  mica-web-shared    sync web 与 desktop renderer 共用的展示纯函数
  @anthropic/ink     本仓库维护的 Ink fork

plugins/builtin/    官方内置产品插件与启动扩展（Todo、MCP、message queue、文件 mention、命令、validate-config、session-autonomy、context-pressure）
scripts/            构建、安装、release installer 脚本
tests/              跨应用集成测试与测试辅助
temp/               临时代码和外部实验，默认不参与搜索/测试/格式化
.backups/           临时备份痕迹，默认不作为实现或验证输入
```

## 应用启动链路

1. `plugins/builtin/config-web-worker.mjs` 先判断当前进程是否为 Config Web worker；worker 模式只启动对应服务。
2. `apps/cli/src/index.ts` 在加载 config/runtime 模块前分派 `--version`、`models`、headless `exec`/`commit`/`compact` 和交互模式；headless 的 `--dir` 也在动态加载前生效。
3. 非 version/help 模式调用 `plugins/builtin/validate-config.mjs` 补齐向后兼容的配置默认值；交互模式由 `plugins/builtin/process-diagnostics.mjs` 设置进程标题、注册全局错误桥。
4. `Application.start()` 启动 Ink UI，再执行完整配置校验。
5. `ensureInitialModelSelection()` 在 provider 配置了 `get_model_url` 且顶层 model 为空时拉取模型列表。
6. 创建 `AgentRuntime`、`SessionController`、`CommandRegistry`、`HookRegistry`、`ServiceContainer`、`PluginManager`、`TerminalAgentSessionManager`、`LocalRuntimeController`、`MicaUiRuntimeBridge`、`SubagentTaskManager`。
7. 当前 agent 注册到 `TerminalAgentSessionManager`，经 `micaTools.registerRuntime(new ToolAgent(agent, subagentTasks))` 注册运行时工具上下文。
8. 构造 `ApplicationContext` 经 `setActiveContext` 暴露；`useBuiltinPlugins()` 注册 command host 和 plugins/builtin 各插件（MCP 随 runtime start/stop 建连、dispose 兜底清理）。
9. `plugins/builtin/file-plugins.mjs` 扫描注册 `$MICA_HOME/plugins` 用户插件，`plugins.setupAll(...)` 初始化并写入 `plugin-status.json`。
10. `uiBridge.start()`、`runtime.start()`；后台 `micaConfig.loadMissingProviderModels()` 成功后空闲时 `agent.reloadConfig(false)` 并同步模型显示。
11. 文件 mention 插件注入当前 cwd 的 `@` 候选 provider；最后设置 placeholder 和退出回调。

启动失败时 UI 提示修复配置后重启，`micaTools.unregisterRuntime('Agent')`、插件和 agent session 被清理，`process.exitCode = 1`。插件 setup 期间 `ctx.onDispose()` 登记的资源在 setup 失败时立即逆序回滚；新增 capability 必须同步登记 disposer。

## Active Context 约定

- `apps/cli/src/app/activeContext.ts` 是应用上下文的唯一全局访问入口。插件、命令和 runtime 辅助代码通过它读取当前 `ApplicationContext`。
- 不要从 package 或底层工具反向 import `Application.ts` 获取状态；需要上层能力时用 service、hook、adapter、回调或显式参数注入。
- 多 agent 场景下命令不能假定构造时传入的 `agent` 永远是当前 agent；命令插件使用 `createActiveAgentProxy` 和 `createActiveSessionControllerProxy`。
- provider/model/effort 切换前先同步当前 agent 的 config 再打开选择器，切换后 `agent.reloadConfig(false)`、保存 session、同步 UI。role 切换同样需要 busy guard 和保存 session，但只重建 client 并保留历史。
- 跨协议切换（`openai_chat_completions` ↔ `openai_responses`）在 `applyConfigSwitchUpdate` 中被阻止（新协议 client 无法携带旧会话历史）；空会话允许自由切换。不要绕过该检查静默丢历史。
- 恢复旧会话遇到 `provider.protocol !== snapshot.protocol` 时**降级恢复**（保持 model/effort、用当前 provider 协议）而不是 throw，否则迁移前的旧会话 resume 会崩溃。

## Runtime Turn Loop

`LocalRuntimeController` 是 turn loop 中心，负责命令分发、输入提交、busy、queue、retry、abort、rewind checkpoint、session 保存和 hooks。

- `runtime.submit()` trim 后先尝试 `commands.resolve(text)`；命令走 registry（exclusive task 或运行中 agent 会阻止不允许并发的命令），普通输入构造 `RuntimeInput`，触发 `input:received` guard hook（message-queue 插件在 busy 时排队），未处理则进入 `runTurn`。
- turn 开始时捕获 rewind checkpoint、解析图片引用、写入 UI message、清空 response buffer；触发 `turn:before`/`prompt:build` hooks 后 `agent.run(...)`。
- `after_iteration` 排队输入在完整工具迭代边界注入同一次 provider loop；`after_turn` 在当前 turn 结束后发送。
- turn 先以 `running` 保存，工具迭代后保存可恢复 checkpoint，成功后写 assistant message（触发 `turn:beforePersist`）并以 `completed` 保存；abort/error 分别保存为 `aborted`/`error`，非 `completed` 会话在 `/resume` 标记 `（uncompleted）`。
- finally 触发携带 `outcome`（`completed`/`aborted`/`error`）的 `turn:after`。内置 Todo 插件据此收尾：`completed` 把 `in_progress` 项标为 `completed`，`aborted`/`error` 降级为 `pending`。**turn lease 必须在 `turn:after` 之前释放**（`runTurn` finally 内 `lease.release()`），否则 message-queue 插件在 `turn:after` 里 `runtime.submit()` 排队输入时会被自己的旧 lease 卡住，误报「该会话正在另一个终端或远程页面运行」并丢弃消息；`runTurnWithLease` 的 finally 保留幂等兜底释放。

### Queue 语义

- `packages/mica-runtime/MessageQueueService.ts` 是单槽队列：每个 agent 最多一条 pending input。`RuntimeQueueMode` 只有 `after_turn` 和 `after_iteration`。
- 已有排队消息时提示「已有一条排队消息，等待发送或重新编辑」；排队成功只发布 `queue:changed`，不重复发 notification（waiting queue 行已含发送时机与 `shift + ← to re-edit` 提示）。
- queue 操作必须带 owner/agent 语义，后台或非当前 agent 的输入不能落到当前 active agent 上。
- pending input 属于 `pendingInputs` UI 状态，不追加到 `conversationMessages` 或 agent history；UI 展示用 `displayText`/`displayContent` 时不影响发给 agent 的 `text`/`content`。

### Retry 语义

- turn 级错误最多重试 5 次，每次间隔 10 秒；重试前恢复 pre-turn client snapshot，清空 response buffer 和 committed buffer。
- 只有 `micaAgent.isRetryableError(error)` 且本 turn 尚未出现非只读工具调用（`micaTools.isReadOnly` 判定）时才自动重试；非只读工具调用后不能盲目重放请求，否则可能重复修改文件、执行命令或触发副作用。
- 不要把 provider SDK 内建重试和 runtime turn 级重试混为一谈；新增 retry 逻辑前确认边界：stream 创建前、stream 中、工具调用前后、副作用是否可重放。
- `ResponsesClient`/`ChatCompletionsClient` 的 `withRetry` 只在一次尝试**还没有文本/工具输出**时重发整个请求（thinking/reasoning 事件不计入"有输出"）；收到文本、tool-call 增量、usage 或正常完成后错误原样抛出交给 turn 级处理。

### Abort 语义

- `AgentRuntime.abort()` 递增 `runId`、abort 当前 controller、清空 active controller、status 置 idle；`run()` 在 abort 或 runId 过期时抛 `AgentAbortError`。
- `LocalRuntimeController` abort 后用 `committedResponseBuffers` 区分已写入历史的文本和 live suffix，避免 retry/continue 后重复或丢失助手输出；非 `/clear` 中止时 `agent.preserveAbortedTurn` 决定是否把部分回复写回 provider history。
- provider client 的流迭代结束后必须再检查一次 abort（OpenAI SDK 在等待 chunk 时收到 AbortError 会静默结束流而不抛错），否则被中止的请求会被提交成空 assistant 消息导致下一次请求 400。`ChatCompletionsClient`/`ResponsesClient` 都在 `for await` 后调用 `throwIfQueryStopped(options)`；修改流循环时不要删掉该检查点。
- UI 展示的真相优先来自 `TerminalAgentSession.uiState.conversationMessages`，不要重新从 provider history 推断。

## Provider、Prompt 与模型协议

`packages/mica-agent` 只做 provider-neutral agent 抽象、模型协议适配和 prompt 构建，不依赖 UI、session、commands 或应用入口。

- `createModelClient` 根据 `provider.protocol` 显式分流：`openai_chat_completions` -> `ChatCompletionsClient`、`openai_responses` -> `ResponsesClient`。不要根据 `api_base` 猜测协议。
- provider adapter 负责协议消息结构、history normalizer、usage 归一化、tool-call 格式、请求参数转换和 abort signal。runtime 不直接拼 provider 请求参数；Chat Completions effort 参数经 `resolveChatCompletionsEffortParams` 生成，Responses reasoning 参数经 `resolveResponsesReasoningParams` 生成。
- 工具结果可以是纯文本或文本/图片内容块。Chat Completions 先追加全部 `tool` 文本结果，再用一条 `user` 多模态消息承载图片；Responses 用原生多模态 `function_call_output`。UI、日志和 run JSON 只接收文本投影，不得输出 Base64。
- `buildSystemPrompt()` 默认读取 `packages/mica-agent/prompt/system.md`，自定义 role 只替换 `<system>` 段；cwd 下 `AGENT.md`/`AGENTS.md` 合并注入。读取路径必须在 prompt 构建时按 live cwd 解析，不能模块加载时冻结。
- system prompt 中的 skills 只是索引；完整 skill 内容只能通过 `Skill` 工具按需读取。
- role 默认从 `~/.mica/role` 扫描（`MICA_HOME` 时用 `$MICA_HOME/role`），只加载 `.md` 文件，文件名去扩展名作为 role 名；内置 `default` 只展示、不可被同名文件覆盖。

## 配置、本地数据与 MICA_HOME

`packages/mica-config` 是配置和本地状态的唯一入口。UI、commands、runtime 和 provider adapter 不要自己读写配置文件路径。

- 默认配置 `~/.mica/config.json`、storage `~/.mica/storage.json`、sessions `~/.mica/sessions`；设置 `MICA_HOME` 时全部跟随 `$MICA_HOME`。测试和临时 repro 优先用临时 `MICA_HOME`，不要污染真实 `~/.mica`。
- 配置文件不存在时复制 `packages/mica-config/default.json`；JSON 解析失败时旧文件重命名为 `config.json.invalid-<timestamp>` 后写默认配置。
- `PersistedMicaConfig` 只保存 `providers`、`serperApiKey`、`mcpServers` 等静态配置。顶层 `provider`/`model`/`effort`/`contextWindowSize` 是运行时合成字段，`updateConfig` 通过 `stripRuntimeFields` 去掉，不应写回 `config.json`。
- `ProviderDefinition.protocol` 只支持 `openai_chat_completions`/`openai_responses`；config 的启动迁移和语义校验统一放在 `plugins/builtin/validate-config.mjs`（配置 Web 保存也复用），不要在别处另建校验规则。
- storage 版本 1，记录 `lastUsedByDirectory`（按精确 cwd 保存 provider/model/effort，含 provider 级 `providerPreferences`）、`inputHistory`（共享，最多 200 条，去重且最新在尾部；desktop 与 CLI 读写同一份）、`preferences`、`usage`。
- session 文件是 version 1 JSON：`id`/`title`/`createdAt`/`updatedAt`/`cwd`/`snapshot`。`snapshot` 含 providerId、model、effort、role、provider history、UI conversationMessages、usageHistory、lastUsage，可选 `subagentUsageHistory`（subagent 的 turnId/messageCount 相对子 agent 自身消息数组，必须独立存放，不能混入主 `usageHistory`，否则破坏 rewind 裁剪语义）。旧快照缺失 role 按 `default` 回退；新增 session 字段必须有明确版本策略、默认值和 sanitize/parse 逻辑。
- `SessionController.saveCurrent` 用持久化签名检测"另一进程写盘"：签名不匹配时**降级写盘**（revision+1，以当前内存快照为准）而不是永久跳过，否则 headless host 后续 turn 都不落盘。多 host 竞争时后写者覆盖先写者属可接受最坏情况，`refreshFromStore` 会在下次刷新收敛。

## 模型、Effort 与 Context 规则

- 全局 effort 枚举是 `none/low/medium/high/xhigh`，直接映射到 OpenAI 请求参数。未加载数据的模型默认提供 `none/low/medium/high`。
- context size 默认 256K，实际值由 Models.dev resolver 决定；缓存/内置种子都未命中且在线刷新失败的模型使用通用规则（context 1M、默认 effort `medium`、全部 effort 枚举），fallback 在 `packages/mica-config/getModelRule.ts`，与 `plugins/builtin/model-effort-context/getModelRule.js` 的 resolver 同名但职责不同。provider 可设 `supportsEffort: false`（状态显示 `none`，不发送 reasoning effort）。Anthropic Messages 协议 effort 固定 `none/low/medium/high`。
- provider/model/effort 切换时必须 clamp effort 并同步 context window size，不要把无效 effort 持久化进 storage 或 session。
- 只有配置了 `get_model_url` 的动态 provider 才触发模型列表查找（解析 OpenAI 风格 `{ data: [{ id }] }`，空列表或非预期结构报错）；动态模型只缓存到内存配置和 storage 运行态，不回填静态 `config.json`。
- 交互和 headless 模式都必须先注册 `plugins/builtin/model-effort-context` resolver 再调用 `ensureModelRule`；headless 获取不到 metadata 时只写 stderr 并使用通用 rule，不能污染协议 stdout。
- `plugins/builtin/model-effort-context/getModelRule.js` 的模型数据来源优先级：磁盘缓存（`$MICA_HOME/cache/models-dev.json`）→ 内置种子（`plugins/builtin/model-effort-context/seed/models-dev.seed.ts` 的 `modelsDevSeedBase64`，gzip→base64 内嵌、模块加载时 `gunzipSync` 解压一次，随二进制打包）→ 在线下载 `https://models.dev/api.json`。缓存 TTL 24h，过期后后台异步刷新（fire-and-forget，不阻塞调用）；请求的模型不在磁盘缓存中时**先查种子兜底**（种子始终参与匹配，即使磁盘缓存存在且过期），只有缓存+种子都未命中才同步等待在线刷新（最多 15s）。下载/刷新失败或模型缺失而降级时写 stderr 告警（进程内去重），不静默。后台刷新也必须透传调用方的 `signal`（`refreshModels(signal)`），否则 await 同一 `refreshPromise` 时 abort 不生效、只能干等超时。
- Headless `exec` 默认输出人类可读文本；`--json` 时输出 Codex exec ThreadEvent JSONL（形状与 `codex exec --json` 对齐，`--thinking` 控制 reasoning item，不要把 reasoning 混入 `text` 或最终输出）。
- Headless run 的 prompt 会先经 `micaUi.parseImageRefs` 解析 `[Image](路径)` 引用生成多模态 content block（直接导入 `@packages/mica-ui/utils/imagePaste.js`，避免把 React/Ink 拖进 headless 路径）。
- Headless `run --no-save` 在整个 turn 期间跳过 session 落盘，用于 mica-code-app 右键 Commit 等一次性后台任务；不改变 prompt、工具、MCP 或事件输出行为。
- Responses 请求只要包含 reasoning 参数就应保留显式 summary 配置，未配置时补 `summary: 'auto'`，否则终端和 Chat 没有可展示的思考内容。

## Headless turn 执行核心、插件装配与 app-server

- `apps/cli/src/runtime/HeadlessTurnExecutor.ts` 是无 UI turn 执行核心：单槽队列（after_iteration 在完整工具迭代边界注入、after_turn 在 turn 结束后排空），发布 `turn:start`/`turn:finish`/`queued`/`dequeue`/`queue:changed` 事件，不拥有输出协议、不触碰 Ink/UI。**每个 turn 必须发出 `turn:finish`（completed/aborted/error 三态之一）**，不要在 `runTurn` 里静默 return，否则客户端永远收不到 `turn/completed`。**每个 turn 开始前先 `sessionController.refreshFromStore()` 再 `reserveRunId()`**，顺序颠倒会把本轮误判为 abort。
- **headless 也跑内置插件**：`apps/cli/src/headless/HeadlessPluginHost.ts` 是 headless 版插件装配层，`runExec`/`runAppServer`/sync `CommandExecutor` 三个入口统一用它，保证 headless 与 TUI 的 agent 能力一致。装配流程：创建 `HookRegistry`（**必须传入 `AgentRuntime` 构造**，`system-prompt:build` 依赖它）→ 注册 headless command host（`commandHostToken` + `headlessRuntimeServices`）→ 注册内置插件（message-queue、command-memory、session-autonomy、context-pressure、Todo、mica-code-app-notify）→ `plugins.setupAll` → `attachPluginLayer` 把 hooks/host/queue/conversationMessages 绑定到 executor → `emitRuntimeStart()`。
- **HeadlessPluginHost 与 TUI 的刻意差异**（只在确实无等价物的功能上）：MCP 不注册插件（headless 手工参数化 `micaMcp.init`，支持 `--mcp-config`/`--strict-mcp-config`/`--mcp-init-timeout-ms`）；file-mention、命令插件（`/model` 等）、用户文件插件（`$MICA_HOME/plugins`）不注册（无输入框/UI）。**新增插件时若 headless 也应具备，必须同步注册到 HeadlessPluginHost，否则 headless 与 TUI 能力再次分叉**。
- `HeadlessTurnExecutor.attachPluginLayer()` 必须同时替换内部 `queue`（插件 enqueue 到 host.queue，loop 从 executor.queue dequeue，两个实例会卡死排队输入）；无插件层时 executor 行为与旧版完全一致（hooks 为 undefined 时不产生额外微任务）。
- headless 的会话 UI 消息 = provider 历史 + 插件 notice（`headlessRuntimeServices.showNotice` 写入 `conversationMessages` 并随 `saveCurrent` 落盘），`getConversationMessages` 空列表返回 undefined（空消息会让 `saveCurrent` 删除会话文件）。
- `context-pressure` 插件是**事件驱动**的：订阅 `ctx.events` 的 `context:changed`（TUI 由 `MicaUiRuntimeBridge.onUsage` 发布、headless 由 HeadlessPluginHost 的 usage 监听发布），不再直接读 `micaUi.panels.contextSize`。改动 context 占用来源时同步检查这两处发布点与 `ContextPressurePlugin.ts`。
- `mica app-server` 是**每会话常驻进程**：从 stdin 读 Codex v2 app-server 协议请求（`initialize`/`thread/start`/`turn/start`/`turn/steer`/`turn/interrupt`，每行一个 JSON），向 stdout 写 v2 通知；持有 `AgentRuntime` + `SessionController` + MCP + `HeadlessTurnExecutor` 直到会话关闭。**不要改成全局单 daemon**。MCP 初始化在后台发起（`.catch` 消化错误），host 先发首帧快照即可服务，首个 `turn/start` 前 `await ctx.mcpReady`；MCP init 失败降级：stderr 记录 + Codex `error` 通知，host 继续服务，不 `exit(1)`。
- 协议实现位于 `packages/mica-runtime/codexProtocol.ts`（framing/编解码）与 `apps/cli/src/runtime/CodexProjector.ts`（AgentRuntime 事件 → v2 通知投影）。`commandExecution` item 携带 `displayText`（工具 `onToolUseDisplayText` 文案）；思考流默认关闭，`app-server --thinking` 才发 `item/reasoning/textDelta`。
- **Mica 增量扩展**（Codex 协议没有的，属纯增量、对 Codex 客户端无害）：`mica/queue/queued`/`dequeue`/`changed` 队列通知（`MICA_QUEUE_NOTIFICATIONS`，`turn/steer` 可带 `clientMessageId` 作 `RuntimeInput.id`）；`mica/backgroundTasks/updated`/`mica/subagentTasks/updated` 跨 turn 常驻状态快照（`MICA_TASK_NOTIFICATIONS`，整体替换语义，1s 轮询对比 JSON 序列化结果，有变化才推送，只投影活跃项；投影逻辑是导出纯函数 `projectBackgroundTasks`/`projectSubagentTasks` 便于单测）；`mica/sessionHistory/replaced`（`MICA_SESSION_NOTIFICATIONS`）在 session_* 工具替换持久化历史后推送（不带 payload，客户端重读会话文件）。mica-code-app 对这三个 method 直接送渲染层、不进 turn 事件缓冲；`sessionHistory/replaced` 由主进程 `chat.js` 重读磁盘 `conversationMessages` 附上 `history` 后送渲染层，渲染层整体替换消息列表。
- `mica exec` 是一次性 headless 执行，对齐 `codex exec`，生命周期与 app-server 一致。
- 容错约定：`--session` resume 失败、`--dir` chdir 失败、MCP 初始化失败时都**降级继续**（发 Codex `error` 通知携带真实原因），不退出进程。进程注册 `unhandledRejection`（记录+通知，不退出）和 `uncaughtException`（通知后退出）兜底；`exit(code)` 前先 flush stdout/stderr，避免 process.exit 丢弃缓冲的真实原因。

## 命令系统

- 通用命令机制在 `packages/mica-commands`，产品命令在 `packages/mica-builtin-commands`（`commands/` 命令实现、`shared/` 共享辅助、`git/` 变更追踪与提交辅助、`tests/` 测试，公共入口 `index.ts`/`services.ts`）。
- `apps/cli/src/plugins/commands/index.ts` 把内置命令注册到 `CommandRegistry` 并同步 `mica-ui` quick commands。
- 命令实现不直接依赖应用层单例，通过 `CommandRuntimeServices` 或 active proxy 注入；耗时且会修改上下文/文件/配置/git 状态的命令通过 runtime exclusive task 执行。
- `ALLOW_DURING_TURN_COMMANDS`：`status`、`context`、`agents`、`new`、`fork`、`exit`、`rename`、`task`。exclusive task 期间额外允许 `status`、`task`、`agents`、`new`。
- `/model`、`/effort` 必须在打开 selector 前检查 busy 并在选择时保留二次 guard。
- 命令的交互反馈统一用 `services.showNotice`（对话区 notice），不用 `services.showMessage`（只给运行日志性质系统消息）。

当前内置命令：

- `/clear`：终止并移除当前 owner 的 subagent、丢弃待注入 system queue，新开空 session；不清除原 session 文件。
- `/resume`：恢复历史会话。
- `/model`：切换 provider 和模型。`/effort`：切换推理强度。
- `/role`：切换系统提示词（自定义文件来自 `~/.mica/role` 或 `$MICA_HOME/role`）；输入框 Shift+Tab 循环切换（busy 时拒绝；已进入 queue 快捷提示时 Shift+Tab 仍是 after_iteration 排队发送）。
- `/status`：当前 provider/model/effort/role。`/context`：上下文占用总览。
- `/compact`：压缩会话为 checkpoint；headless `mica compact --session <id>` 走同一 `CompactionService`（`apps/cli/src/cli/runCompact.ts`），内容过少返回 `code: "not_needed"`。
- `mica compact --prune-only`：只做本地清理、不调用模型——工具结果与工具参数（`arguments`）无条件替换为合法 JSON 占位符（`TOOL_ARGUMENTS_PLACEHOLDER`，否则 provider 400），图片/base64/超长字符串按尺寸修剪；无可修剪内容时可沿轮次边界丢弃最早轮次（不拆散 tool call/result 配对）；`mode: 'kept'` 仍只截断超长参数。
- `mica commit`（headless，`apps/cli/src/cli/runCommit.ts`）：与 `/commit` 复用 `commitRunner.ts`，只发一次模型请求生成 commit message（无工具、无多轮），再 add/commit/push，输出单行 JSON。
- `/new`：新开 agent；`/new <text>` 后台运行。`/fork`：从当前历史分叉 agent；`/fork <text>` 后台运行。
- `/task`：展示当前终端 session、retained subagent 和 active background shell；`/task clear` 清除空闲 session。
- `/rewind`：选择一轮对话保留其用户输入及回复、删除之后内容；有文件 checkpoint 时可恢复文件。
- `/mcp`：列出 MCP 服务器和工具；`/mcp reconnect <server>` 重连。
- `/skills`：列出已安装 skills。`/rename`：重命名会话。`/commit`：分析 git 变化、生成提交信息、提交并推送。`/exit`：退出。

新增或删除命令时至少检查：`apps/cli/src/plugins/commands/index.ts`、`packages/mica-builtin-commands/index.ts`、`packages/mica-builtin-commands/README.md`、`README.md`、`AGENT.md`。

## Tools、MCP 与 Skills

### Tools

- `packages/mica-tools` 是唯一工具 registry。内置工具和 MCP 工具都必须通过它暴露给模型和 runtime。
- 运行期产品工具优先由内置插件通过 `ctx.tools.register()` 注册；工具可声明 icon 和 `primaryAgentOnly` 元数据，核心和 subagent 策略不要硬编码具体插件工具名。
- 新增工具优先继承 `MicaTool`，提供参数 schema、执行逻辑、展示文案、错误格式化和只读属性。文件、shell、网络类工具必须保留边界检查、输出限制和清晰错误。
- 判断 retry 是否可重放依赖 `micaTools.isReadOnly(toolName)`。内置工具只读语义有全集测试锁死（`packages/mica-tools/tests/MicaTool.test.ts`）：纯查询类（`read_file`/`read_image`/`list_files`/`grep_search`/`web_fetch`/`web_search`/`Skill`/`background_tasks`/`read_task_output`）必须标 `readOnly: true`，写/执行类（`write_file`/`apply_patch`/`run_shell`/`kill_task`/`pty_*`）不得标。改标记时同步更新该测试。
- `run_shell` 的前后台执行、cwd 校验、输出截断、后台任务读取和终止逻辑保留在 `packages/mica-tools` 内相邻模块，不分散到应用层。
- PTY 工具（`pty_spawn`/`pty_send`/`pty_read`/`pty_wait`/`pty_kill`）驱动交互式 TUI 验证。node-pty 的 native binding 在 Bun 进程内不工作，因此 PTY 会话由懒启动的 **Node 子进程**（`packages/mica-pty/src/server.mjs`，JSONL over stdio）承载；首次调用时动态 import `@packages/mica-pty/src/manager.js`（不经过 `mica-pty/index.js`）。**node-pty 必须保持 external，禁止从生产代码静态 import `node-pty` 或 `mica-pty/index.js`**（编译二进制的 Bun 运行时无法解析）。
- `packages/mica-pty/src/ptyServerSource.ts` 是 `server.mjs` 的 JSON 转义内嵌（打包器不支持 `?raw`）；改动 `server.mjs` 后必须运行 `bun run scripts/generate-pty-server-source.mjs`，`packages/mica-pty/tests/serverSource.test.ts` 校验同步。

当前内置工具：`read_file`、`read_image`、`write_file`、`apply_patch`、`list_files`、`grep_search`、`run_shell`、`background_tasks`、`read_task_output`、`kill_task`、`pty_spawn`/`pty_send`/`pty_read`/`pty_wait`/`pty_kill`、`web_fetch`、`web_search`、`Skill`。

交互模式的 `TodoWrite` 由 Todo 插件注册；headless run 也注册独立实例（`plugins/builtin/todo/TodoTool.ts`，不依赖 React/Ink）。Todo 状态只属于当前进程/turn，不写入 session；turn 正常结束时把遗留 `in_progress` 项标为 `completed`，只有 abort/error 才转 `pending`。

`session_*` 会话自治工具族由 `plugins/builtin/session-autonomy/` 插件注册（`primaryAgentOnly: true`，subagent 的 tool context 还会被显式拒绝；**交互与 headless 都注册**，HeadlessPluginHost 与 useBuiltinPlugins 各注册一次）：`session_info`/`session_history` 只读（必须保持 `readOnly: true`），`session_compact`/`session_set_prompt`/`session_rewrite` 是延迟写操作——工具执行时只登记，**turn 正常完成后（`turn:after` 且 outcome 为 `completed`）立即应用**：此刻 agent 空闲、本轮已落盘，经 `services.applySessionHistory` 替换 history 并 `saveCurrent`，UI（交互模式 micaUi / 落盘 conversationMessages）马上反映，不等下一轮用户输入；该 turn:after handler 的 priority 是 50，必须保持在 message-queue 的 turn:after（100，会启动下一轮）之前，否则应用会与下一轮请求构建竞态；`turn:before`（priority 10）保留为兜底（单轮 headless 等没有 turn:after 的路径，`runExec` 会在队列排空后手动触发一次）。**TUI 的状态行在 agent.run 返回时就显示 completed（turn:after 之前），用户可能立即发下一条消息：`applyPendingOps` 按 owner 记录 in-flight promise，turn:before 会先 await 在途应用再检查 pending，保证下一轮请求基于替换后的历史构建**（否则 compact/rewrite 应用会与下一轮请求构建并发，见 `SessionAutonomyPlugin.ts` 的 `applyingByOwner`）。不能在工具执行时改 snapshot（agent 正 busy，会破坏在途请求）。应用成功后调用 `services.onSessionHistoryApplied?.()`（headless 侧接到 `HeadlessPluginHostOptions.onHistoryApplied`，`runAppServer` 用它发 `mica/sessionHistory/replaced` 通知；交互模式 UI 已直接更新，无需回调）。`session_rewrite` 只做"整段历史替换为单条总结"（含跨协议格式归一），不提供任意增删改。`session-autonomy` 插件通过 `system-prompt:build` hook 注入**固定**的会话自治引导文字（不能带动态数字，会打散 prompt cache）。新增或修改这些工具时同步检查 `SessionAutonomyTools.ts` 的 readOnly 标记与 `services.ts` 的 `applySessionHistory` 签名和 `onSessionHistoryApplied` 回调。

`plugins/builtin/context-pressure/` 是上下文压力提醒插件：订阅 `ctx.events` 的 `context:changed` 事件（TUI 与 headless 同源，发布点见 HeadlessPluginHost 与 `MicaUiRuntimeBridge.onUsage`），在占用进入红色区（判定复用 `packages/mica-ui/panels/contextThresholds.ts`，与 WorkingStatus 状态栏着色同源：ratio ≥ 0.7 或 tokens ≥ 300k）且窗口已知时，经 `services.submitAgentSessionInput` 注入一条固定模板的用户消息（`queueMode: 'after_turn'`，busy 时由 message-queue 排队），提醒模型调用 `session_compact`。防重复：提醒后进入 `warned` 闩锁，占用回落到 ratio < 0.5 才解除（另有 60s 冷却兜底）。改动阈值时必须同步 `contextThresholds.ts` 与 WorkingStatus 的着色，并保持 `submitAgentSessionInput` 的 options 透传（queueMode/displayText）。

### MCP

- `packages/mica-mcp` 管理 MCP server 生命周期：读取配置（`~/.mica/config.json` 的 `mcpServers`）、连接、注册远端 tools、重连、关闭和清理。
- 远端工具必须通过 `micaTools.registerMcp()` 接入；server 断开、重连失败或关闭时同步清理对应工具（`/mcp reconnect` 失败后也要刷新，避免残留 stale tools）。
- Headless run 显式初始化/关闭 MCP，并发连接后按配置顺序合并工具；`--mcp-config <path>` 加载额外配置、`--strict-mcp-config` 禁止混入本地配置、`--mcp-init-timeout-ms <ms>` 限制单个 server 的 connect + tools/list 总时间。mica-code-app 通过 `MICA_MCP_INIT_TIMEOUT_MS=2000` 传入上限。

### Web

- `web_search` 使用 `serperApiKey` 或 `SERPER_API_KEY`；`web_fetch` 负责 URL 抓取和 HTML 转 Markdown。
- 用户询问当前、最新、官方、模型能力、provider 行为、API 行为、价格、法规等可变事实时，先联网或读官方资料查证；无法查证时明确说明。

### Skills

- `packages/mica-skills` 只负责扫描、解析和缓存 skills，不执行 skill 内容。
- 用户级默认扫描 `~/.mica/skills`（跟随 `MICA_HOME`）；项目级扫描 `.mica/skills`、`.agents/skills`、`.deveco/skills`、`.agent_context/skills`；未设置 `MICA_HOME` 时兼容 `~/.config/deveco/skills`。
- 每个 skill 是一个含 `SKILL.md` 的目录；frontmatter 支持 key/value、boolean 和列表（列表规范化为分号连接字符串）。
- `Skill` 工具把 baseDir 和完整内容包在 `<skill-instructions>` 中返回，支持简单 `$var` 替换。skill 内容是用户数据和任务说明，不能覆盖安全规则、系统指令或当前用户请求。

## UI 状态与 Ink 约定

- `packages/mica-ui` 只负责终端 UI 组件和状态 store，不直接调用 provider，不持有 agent 运行逻辑。Runtime 到 UI 的映射由 `MicaUiRuntimeBridge` 和 `runtime/uiBridge.ts` 完成。
- 主要状态入口包括 `conversation`、`terminalInput`、`dropdown`、`bottom`、`panels`。对话消息可携带 `displayContent`（只改 UI 展示，不改发给 agent 的真实 `content`）。
- `parseImageRefs` 把 `[Image](...)` 引用转为多模态 content block；不要只发纯文本图片占位符给模型。
- `TerminalAgentSessionManager` 为每个 agent 保存独立 UI snapshot（conversationMessages、responseText、pendingInputs、messageBarMessages、agentTurnLogItems、thinkingText、pluginUIs、workingStatus、contextSize、cachedTokenRate）；多 agent 切换时从对应 session.uiState 恢复，不要从 active agent 或 provider history 临时拼装。
- UI hot path 有明确上限：conversation messages、response text、pending inputs、message bar、agent turn log、thinking text 和 message text 都截断或只保留尾部。
- 普通终端主界面使用 `rows - 1` 作为最小高度而不是固定高度，长 conversation 按自然高度扩展到原生 scrollback，避免 Yoga 收缩后文本越界覆盖后续消息和输入区。
- Ink stdin 在 `parse-keypress.ts` 解析前必须保持原始 `Buffer`（该层负责增量 UTF-8 解码和 DEC 8-bit C1 规范化）；不要在 `App.tsx` 提前调用 `stdin.setEncoding('utf8')`。
- 长会话性能问题优先检查 retained buffers、rewind snapshots、Markdown 渲染输入、图片 payload、MCP 输出和 agent turn log，不要直接做大重构。
- `mica-code-app` 是终端风格 Web 渲染：等宽字体、紧凑行高、一致字号（主文本共享 `--chat-text-size`），不在局部硬编码更小/更大主文字字号。
- 打包桌面进程不经过 shell（launchd 直接拉起）：`apps/desktop/src/main/desktop-process-env.js` 在主进程启动时保留现有 PATH 顺序并追加用户工具目录、NVM/FNM Node bin 和常见系统目录（不插到用户 PATH 前面、不输出环境内容）；`apps/desktop/src/main/shell-env.js` 用 `<zsh|bash> -i -l -c env` 一次性采集 profile 环境变量并缓存（超时 3s 或 Windows 静默跳过，过滤 `PWD`/`OLDPWD`/`SHLVL`/`_`），供 chat/commit/models/compact 子进程 spawn 时合并。

## 多 Agent、Session、Rewind、Compact

- `TerminalAgentSessionManager` 管理同一终端内多个 agent session；`switchSession` 必须同步 runtime 当前 agent、session controller、queue UI 和 UI bridge 当前 agent。
- `Agent` 工具的后台 subagent 由 `SubagentTaskManager` 管理：按 parent agent 隔离 task、独立 abort signal、经 runtime system queue 把完成元数据回注 owner；结果需 `Agent operation=read` 显式读取或 `operation=await` 等待。system queue 不与单槽用户输入队列争用，也不会自行唤醒空闲 parent。
- foreground/background subagent 记录都留在 `SubagentTaskManager` 供 `/task` 查看（每 parent 最多 100 条，只存轻量 summary，详情按 ID 获取，结果只在当前进程内存在）。
- Ctrl+C 中止 parent turn 时必须同步 abort 该 owner 的 running subagent 并保留 `killed` 记录；清理 session/owner 时终止运行任务并移除其 retained 记录。
- subagent 默认按 `context_mode`（`none|brief|recent|files`）注入 `<delegated-context>` 任务包，默认 `brief`，不继承完整历史。默认允许继承 parent effort（definition 可用 `effort: false` 强制 `none`）；`maxTurns` 必须传到 provider query loop，未知 `subagent_type` 必须报错，不得静默降级。
- 可写 subagent 支持 `owned_paths` 路径租约（`Implementer`/`Tester`/`Proposal` 必填），写工具和 `run_shell` cwd 校验所有权，重叠租约启动时拒绝。`Proposal` 为不落盘提案模式，只返回 patch 文本供 parent 审查后 apply。
- `Agent` 支持 `operation=run_many`（`tasks` + `depends_on` + `max_parallel`）和 `operation=join`。当前内置 subagent 类型：`general-purpose`、`Explore`、`Implementer`、`Reviewer`、`Tester`、`Planner`、`Proposal`。
- `RewindCheckpointManager` 在 turn 前创建对话和文件 checkpoint，始终保留"用户输入之前"的状态；内存 checkpoint 缺失时从 provider/UI history 动态生成仅对话节点，compact 后无法对齐的节点不伪造。
- `packages/mica-context` 提供 `CompactionService`，compact 结果通过 runtime/session 层接入对话，provider adapter 不直接感知 compact 策略。
- compact 可以裁剪 tool result、媒体和 base64，但绝不能把 tool-call `arguments` 截成自由文本；过长或损坏参数必须改写成合法 JSON 占位，否则后续 provider 请求 400。
- compact 应用 checkpoint 时必须保留原 `usageHistory`/`lastUsage`，禁止清零（否则 Stats 与上游平台对账出现缺口）。两处应用点：`apps/cli/src/plugins/commands/commandRuntimeServices.ts` 的 `/compact`、`apps/cli/src/cli/runCompact.ts`。
- compact、review、commit 等需要模型调用的命令应通过 subagent 或 exclusive task 隔离，不要污染当前正在运行的 turn。

## Package 依赖边界

所有 package 都通过 `index.ts` 暴露公共 API，应用层优先从 `@packages/<name>/index.js` 引用。

- `mica-common` 不依赖任何产品业务包；共享图片格式与尺寸识别在 `mica-common/image.ts`。
- `mica-agent` 不依赖 UI、session、commands 或应用入口。`mica-ui` 不直接调用模型 provider，不持有 agent 运行逻辑。
- `mica-runtime` 只定义协议和状态原语，不做具体 turn loop 编排（`codexExecEvents.ts` 与 `codexProtocol.ts` 都是协议层，不是 Claude SDK stream-json）。
- `mica-commands` 只放通用机制，产品命令在 `mica-builtin-commands`（经 services 注入外部能力，不导入应用层单例）。
- `mica-tools` 统一管理工具定义和执行；`mica-mcp` 管理 MCP 生命周期，但远端工具注册走 `mica-tools`。
- `mica-session` 只负责持久化；`mica-context` 提供上下文能力，不直接操纵 provider adapter；`mica-skills` 只扫描解析缓存；`mica-plugin` 只提供插件机制。
- `mica-pty`：`src/manager.ts` 不 import node-pty；`index.ts` 导出 `PtyDriver`（顶层 import node-pty，因此生产代码不要静态 import `mica-pty/index.js`）。
- `plugins/builtin` 通过 `PluginContext` 的 commands、hooks、services、runtime queue、tools 和 UI capability 接入，不反向 import `src/**`。
- 如果新增代码会导致底层包依赖上层包，优先用类型、回调、service、hook 或 adapter 注入能力，不要直接加 import。

## Import 与代码风格

- 根 tsconfig 配置 `@packages/*` alias（`./packages/*`）和 `@apps/*` alias（`./apps/*`）；package 不得通过 `@apps/*` 反向依赖应用。
- `apps/cli/src/` 中引用 package 统一用 `@packages/<name>/index.js`，除非需要访问明确公开的相邻模块或测试目标。
- 每个 package 的公共 API 通过 `index.ts` 聚合导出；新增公共能力时同步更新导出入口和 README。
- 默认不使用动态 import（唯一例外：进程模式分派边界延迟加载应用/Config Web server；PTY 工具首次调用加载 `mica-pty` manager）。
- import 路径风格与所在文件周边一致；不把应用装配逻辑塞进 package。
- TypeScript 使用 strict、isolatedModules、verbatimModuleSyntax；类型导入用 `import type`。
- 代码注释保持克制，只在复杂流程、不明显不变量或 workaround 前写短注释；默认不做无关格式化、重命名或顺手重构。

## 测试与验证

- **全量 `bun run test` 很慢（实测约 7~8 分钟）**：大头是真实 spawn 进程的端到端套件，包括 `apps/cli/src/cli/app-server.flows.test.ts`（~60s）、`apps/cli/src/cli/commit.flows.test.ts`（~63s）、`packages/mica-pty/tests/driver.test.ts`（~17s）以及 `models.flows.test.ts`。日常开发**默认只跑局部测试**：`bun run test -- <测试文件>`（可传多个路径），按改动范围选对应套件；**全量只在必要时跑**（发布前、改动影响面跨多个慢套件、或 CI 要求时），不要每次改动都全量。
- 单元/集成测试走 `bun run test`（vitest，Node 环境）；涉及交互式 TUI 的测试优先用 `packages/mica-pty`。
- vitest include 覆盖 `apps/**/*.test.{ts,tsx}`（sync web 组件冒烟测试是 `.tsx`，用 react-dom/server 渲染验证终端风格结构）；`apps/desktop` 是独立 npm 项目，用项目内 `bun test` 且依赖 `apps/desktop/node_modules`。
- `packages/mica-pty` 两类能力：`PtyDriver`（直接 import，Node ≥22 / vitest 下使用——node-pty 在 Bun 下不可用，**不要从 `bun run` 代码里 import `PtyDriver`**）和内置 PTY 工具运行时（`PtyManager` + Node helper 桥接，Bun 主进程可安全使用）。
- 冒烟验证（需要真实 provider API key，默认跳过）：

```bash
bun run build   # 生成 dist/mica
MICA_PTY_SMOKE=1 npx vitest run packages/mica-pty/tests/mica.smoke.test.ts
MICA_PTY_FLOW_SMOKE=1 MICA_PTY_SOURCE_HOME="$HOME/.mica" npx vitest run packages/mica-pty/tests/user-flows.smoke.test.ts
```

- 协议级端到端套件 `apps/cli/src/cli/app-server.flows.test.ts`：真实 spawn `mica app-server` + 本地 mock OpenAI provider，覆盖切模型、interrupt、provider 失败透传 error、turn/steer 排队续跑、工具轮后延续历史、compact 后恢复、after_iteration 迭代边界注入、busy 拒绝、interrupt 后 drain。**不需要真实 API key，默认随 `bun run test` 运行**（无 bun 时自动 skip）。compact 测试需至少两轮对话且上下文超过 recent-token budget 才会真正摘要；resume host 必须复用同一 `MICA_HOME`。
- vitest 会把 `HOME` 重定向到临时目录，因此必须显式传 `MICA_PTY_SOURCE_HOME`（测试只复制 `config.json` 到隔离的 `MICA_HOME`，不触碰用户数据）；`dist/mica` 路径按仓库根解析，可用 `MICA_PTY_BIN` 覆盖。
- mica-pty 常规测试：`bun run test -- packages/mica-pty/tests/driver.test.ts packages/mica-pty/tests/manager.test.ts packages/mica-pty/tests/serverSource.test.ts`。
- 注意 node-pty 的 prebuild `spawn-helper` 通过 Bun 安装时可能缺执行位，`PtyDriver.spawn()` 会做幂等 chmod 兜底。

## 命令范围与临时目录

- `temp/` 是临时代码目录（git 忽略），不属于默认源码、测试、格式化、构建或搜索范围；`.backups/` 是临时备份痕迹，不应作为默认实现或验证输入。
- 递归搜索优先用 `rg` 或 `rg --files` 并排除 `temp/`、`node_modules/`、`dist/`，例如 `rg "pattern" src packages scripts docs blogs --glob '!temp/**'`。只有用户明确要求时才进入这些目录。

## Mica Sync 远程会话同步

`mica daemon`（`apps/cli/src/features/sync-daemon`）+ `apps/sync/server` + `apps/sync/web` 组成 Mica Sync：所有机器上的活跃/历史会话镜像到一台中心服务器，浏览器实时查看并回源续聊。三端共享的 wire 类型在 `packages/mica-sync-protocol`，改协议形状时同步检查该包与三端引用。

- 机器端 daemon 主动**出站**连接（NAT 友好）：`/daemon/register`（按 hostname 复用 machineId）、`/daemon/beat`（20s）、`/daemon/poll` 长轮询指令（server 最多 hold 25s）、`/daemon/session`、`/daemon/events`。
- 中心服务器零第三方依赖、JSON 文件存储（`data/machines.json`、`data/sessions/<machineId>/<sessionId>.json`）、每会话 500 条事件缓冲、SSE 用 `since` 序号断线补拉。**无认证**：Web API 完全开放，公网部署需自行 Nginx 基本认证或防火墙。
- 指令：`create`/`run`/`update_cwd`/`abort`。daemon 同一时刻只执行一个 turn（busy 时发 `run_rejected`）；poll 监听请求 `close` 清理断开连接的 waiter。
- 事件类型：`user_input`、`thinking`、`text_delta`、`tool_call`、`tool_result`、`usage`、`status`、`turn`、`run_rejected`、`session`、`session_removed`；队列相关 `queued`/`dequeue`/`queue_state`。
- daemon 配置存 `~/.mica/sync.json`（跟随 `MICA_HOME`）；交互模式启动时 fire-and-forget `ensureDaemonRunning()`（`apps/cli/src/features/sync-daemon/ensureDaemonRunning.ts`）后台 detached 拉起 daemon（pid 文件 `$MICA_HOME/daemon.pid`，日志 `daemon.log`），`MICA_NO_DAEMON=1` 禁用；改动 pid/spawn/自启动时机时同步检查该文件及测试和 `index.ts`。
- `CommandExecutor` 复用 `HeadlessTurnExecutor` + **每会话常驻 host**（MCP 保持 daemon 生命周期常开），turn 前 `chdir` 到会话 cwd；每个 host 也经 `HeadlessPluginHost` 跑内置插件（host 移除时 `emitRuntimeStop` + `dispose`）；`create` 指令构造 `PersistedSession` 时必须先用非空标题落盘，否则 `saveCurrent` 会因磁盘无文件拒绝写入。
- abort 依赖 `AgentRuntime.abort()`（runId 失效 + signal）：等待 provider stream 时立即生效；工具执行中或长 thinking 期间要等当前迭代/工具结束的边界才抛 `AgentAbortError`，不要另造中断机制。
- 会话文件由 `SessionWatcher` 监听推送（`fs.watch` 在 macOS 可能丢事件，有 30s 周期 rescan 兜底）；本地 runtime 与 daemon 用 `packages/mica-session` 的跨进程 turn lease 避免快照相互覆盖，快照带单调 `revision`，服务器拒绝迟到旧快照。
- Web：会话详情默认精简快照（剔除 messages/usageHistory、保留 `lastUsage`，`?full=1` 取全量），detail 响应带 `snapshotSeq`，Web 在详情加载完成后再建 SSE（`since=snapshotSeq`）避免重放旧事件；`useSse` 的 `lastSeqRef` 跨 effect 重启保留，绝不重放已见事件。改动协议时同步检查 `apps/sync/web/web/src/App.tsx` 与 `useSse.ts`。
- 构建与部署：`bun run build:sync-server` 产出 `dist/mica-sync-server.js`；`bun run build:sync-web` 产出 `apps/sync/web/dist`（vite `base: './'`）。生产在 `188.253.118.143` 的 `/opt/mica-sync/`（pm2 进程名 `mica-sync`，监听 5560，Nginx `location /mica/` 反代必须 `proxy_buffering off` + 长 read timeout）。**pm2 必须用 `pm2 start node --name mica-sync -- mica-sync-server.mjs ...` 显式指定解释器**。deploy-server 的 `/upload` body 必须是原始 tar 二进制（不支持 multipart），`extract=1` 会 `rm -rf` 清空 `target`；重新部署 web 前先备份 `/opt/mica-sync/data`，解压后再移回并 `pm2 restart mica-sync`。
- sync web UI 与 mica-code-app renderer 共用同一套展示词汇（等宽终端字体、`#0e0e0e` 暗色、`--chat-*` 变量、消息 `marker|body|time` 网格、react-markdown + remark-gfm、工具行 `icon + label + args + state + duration`、状态行 `model_effort · tokens (cached %, ctx %)`）；展示数据计算在 `packages/mica-web-shared`，改任何一侧展示形态时同步检查另一侧。移动端（≤768px）隐藏时间列、侧栏抽屉全宽、触控目标 ≥36px、输入框 16px 防 iOS 缩放、safe-area-inset-bottom。
- Config Web 的 `Sync` 页面：后端路由 `GET /api/details/sync`（`apps/config-web/src/server/syncDetails.ts`）、`PUT /api/files/sync`；修改 sync 相关字段（serverUrl、name、machineId 语义、探测判定）时同步检查该文件与 shared/types.ts 的 `ConfigWebSyncDetails`。

## 构建、安装与发布

- `bun run build` 实际运行 `MICA_PREBUILD_DONE=1 bun scripts/build.mjs`；`prebuild` 是 `bunx tsc --noEmit`；`postbuild` 是 `bun scripts/install.mjs`。
- `scripts/build.mjs` 用 `bun build --compile --compile-autoload-package-json` 构建无外部运行时依赖的本地二进制，默认输出 `dist/mica`。
- 内置 models.dev 种子由 `scripts/update-models-dev-seed.mjs` 刷新（下载 `api.json` → 校验结构 → `gzipSync` 压缩 → base64 → 原子写入 `plugins/builtin/model-effort-context/seed/models-dev.seed.ts`，失败退出码 1）；手动运行 `bun scripts/update-models-dev-seed.mjs`。种子以 gzip 内嵌（约 350KB，未压缩 3.5MB）避免 `?raw` 不支持问题并控制仓库体积。CI 在 release 构建前 best-effort 刷新（失败仅打 warning、用仓库固定副本，绝不阻断构建）。
- `scripts/install.mjs` 默认安装到 `$HOME/.local/lib/mica`，并在 `$HOME/.local/bin/mica` 写薄 launcher；可用 `MICA_INSTALL_DIR`、`MICA_INSTALL_PACKAGE_DIR`、`MICA_BIN_NAME` 覆盖。
- 产品名是 Mica Code / `mica-code`；release 采用按平台下载：`scripts/install.sh` 探测 os/arch 后只下载对应 `mica-code-<platform>-<cpu>.tar.gz` 并用 `sha256sums.txt` 校验，不内嵌全部平台二进制。GitHub Actions 的 `mica-code-release` artifact 是 CI 汇总包，不是用户安装路径。
- `.github/workflows/build-binaries.yml` 在 push/PR/手动触发时跑根 typecheck/test + Desktop test/lint，在 `main` 或 `v*` tag 构建 Linux/macOS x64/arm64 release 二进制并上传 asset。
- `.github/workflows/deploy-pages.yml` 发布 `website/` 到 GitHub Pages：`actions/configure-pages` **只暴露 outputs，不会注入 `PAGES_BASE_PATH` 环境变量**，Build 步骤用 `env.PAGES_BASE_PATH` 显式传入；`website/astro.config.mjs` 归一化（补尾斜杠，缺省 `/`）后作 Astro `base`。`base_path` output 不带尾斜杠，必须补，否则模板 `${base}mica.svg` 拼接出错位路径。Astro 不会自动给硬编码绝对路径加 base 前缀，因此布局/页面里所有内部链接（`mica.svg`、`screenshots/`、`docs/`、锚点）都必须用 `import.meta.env.BASE_URL` 拼接，CSS 用 frontmatter `import`；新增页面或资源时保持这个约定。
- 如果用户报告启动、startup UI、build/install 行为与源码不一致，先确认实际运行的是哪个入口：`~/.local/bin/mica` launcher、`~/.local/lib/mica/mica`、`dist/mica` 可能不一致。

## Git 与工作区安全

- 工作区可能有用户未提交改动。开始修改前查看 `git status --short`。
- 不要回滚、覆盖、格式化或删除与任务无关的用户改动；修改已有未提交改动的文件时先读清当前内容再以当前内容为基础补丁合并。
- 不要使用 `git reset --hard`、`git checkout --`、强推、批量删除等破坏性命令，除非用户明确要求并确认。
- 不要为了通过检查使用 `--no-verify`；不要自动 commit、push、创建分支或开 PR，除非用户明确要求。

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

只要答案是"会影响"，就把文档同步作为本次交付的一部分。
