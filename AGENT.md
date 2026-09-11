# Mica Code Agent 手册

本文件会被 `packages/mica-agent/prompt/index.ts` 注入系统提示词的 `<project-instructions>` 段，直接影响 Mica Code 在本仓库的工作方式。优先级低于系统、开发者和当前用户指令，高于普通实现偏好；与当前代码不一致时以代码为准，并在同一次变更中修正本文件。

## 维护红线

- 变更涉及本文件描述的事实、约束、目录、命令、配置、运行链路或开发流程时，必须在同一个变更中更新本文件。
- 新增/删除/重命名长期模块、核心服务、内置命令、公共 package、provider 协议、工具注册方式、session 存储格式、runtime 生命周期、UI 状态模型或验证命令时，同步更新本文件对应章节。
- 修改用户可见命令时同步检查根 `README.md` 与 `packages/mica-builtin-commands/README.md`；新增/移动公共 API 时同步检查 `packages/README.md` 与对应 package README。
- 修改 prompt 构建、skills 加载、工具描述、联网策略或 project instructions 读取方式会改变 agent 行为与 prompt cache 前缀，须特别谨慎。
- 本文件只记录会影响未来修改方式的稳定约束、架构边界、运行链路和验证习惯，不写流水账。

## 项目定位与常用命令

Mica Code 是基于 Bun、TypeScript、React、Ink 的终端 code agent：`apps/cli/src` 是应用装配层，`packages/*` 是可复用包，新增稳定领域能力优先沉淀到 package。设计偏向 append-only 会话历史与稳定 prompt 前缀，只在明确阶段边界 compact。UI 保持信息密度、键盘优先。

Node 要求 `>=22`：

```bash
bun install               # 安装依赖（apps/desktop 是独立 npm 项目：cd apps/desktop && npm install）
bun run dev               # 开发运行
bun run typecheck         # bunx tsc --noEmit
bun run test              # Vitest（不要用 bun test，不兼容部分 Vitest API）
bun run build             # typecheck → compile 单二进制 → 安装本地入口
bun run format
```

局部验证：`bunx tsc --noEmit`、`bun run test -- <测试文件>`、`git diff --check`。

`apps/desktop` 用 npm（在 `apps/desktop/` 内执行）：`npm run dev`/`npm test`（bun test）/
`npm run build`（外壳 + 运行时）/ `npm run start:web`（只跑运行时供浏览器访问，见下文
「apps/desktop 的架构」）。改动 desktop 后至少跑 `npx eslint src/` 与 `npm test`。

## 源码结构

- `apps/`：`cli/`（主应用：装配、turn loop、headless）、`desktop/`（Web 运行时 + Electron 容器，见下文）、`config-web/`（本地配置 Web）、`website/`（官网 Astro）。
- `packages/`：
  - `mica-agent`：agent 抽象、provider adapter、prompt 构建
  - `mica-tools`：唯一工具 registry（内置工具 + MCP 工具接入）
  - `mica-mcp`：MCP server 生命周期；`mica-ui`：Ink 终端 UI 组件与状态 store
  - `mica-runtime`：runtime 协议/事件/状态/队列原语（含 codexProtocol、codexExecEvents）
  - `mica-session`：会话快照持久化；`mica-config`：配置/storage/模型规则；`mica-context`：compact
  - `mica-commands`：通用命令机制；`mica-builtin-commands`：产品命令
  - `mica-skills`：skills 扫描解析缓存；`mica-plugin`：插件机制；`mica-common`：跨包底层工具（图片识别）
  - `mica-pty`：PTY 测试驱动 + 内置 PTY 工具 Node helper（node-pty 只在 Node 子进程加载）
  - `mica-web-shared`：desktop renderer 与运行时共用的展示纯函数
- `packages/mica-builtin-commands/`：产品命令与全部内置插件——`commands/` 命令实现、`plugins/` 运行期插件装配（Todo、MCP、message queue、文件 mention、`command-*.ts`、session-autonomy、context-pressure、loop）、`startup/` 启动扩展（validate-config、process-diagnostics、file-plugins、model-effort-context）；运行期插件与启动扩展统一从 `index.ts` 导出。`config-web-worker` 因依赖 `apps/config-web` 保留在 `apps/cli/src/app/configWebWorker.ts`。
- `temp/`（git 忽略）与 `.backups/` 不属默认源码、测试、格式化、构建或搜索范围。

## 依赖边界与 Import 约定

- 所有 package 通过 `index.ts` 暴露公共 API，应用层优先 `@packages/<name>/index.js`；根 tsconfig 配 `@packages/*`、`@apps/*` alias，package 不得经 `@apps/*` 反向依赖应用。
- 底层包不得依赖上层包；需要上层能力时用类型、回调、service、hook 或 adapter 注入，不要直接加 import。
- 职责边界：`mica-agent` 不依赖 UI/session/commands/应用入口；`mica-ui` 不调用 provider；`mica-runtime` 只定义原语不做 turn loop 编排；`mica-commands` 只放通用机制；`mica-session` 只持久化；`mica-context` 不直接操纵 provider adapter；`mica-skills` 只扫描解析缓存；`mica-plugin` 只提供插件机制；`packages/mica-builtin-commands/plugins` 经 PluginContext 接入，不反向 import `src/**`。
- `mica-pty`：`src/manager.ts` 不 import node-pty；`index.ts` 顶层 import node-pty。**生产代码禁止静态 import `node-pty` 或 `mica-pty/index.js`**（Bun 编译二进制无法解析 native binding）。
- TypeScript：strict、isolatedModules、verbatimModuleSyntax，类型导入用 `import type`。默认不用动态 import（例外：进程模式分派边界延迟加载、PTY 工具首次调用加载 manager）。不写无关注释，不做无关格式化、重命名或顺手重构。

## 应用启动链路

1. `apps/cli/src/app/configWebWorker.ts` 先判断是否为 Config Web worker，worker 模式只启动对应服务。
2. `apps/cli/src/index.ts` 在加载 config/runtime 前分派 `--version`/`models`/headless `exec`/`commit`/`compact` 与交互模式；`packages/mica-builtin-commands/startup/validate-config.js` 补齐向后兼容的配置默认值。
3. `Application.start()` 启动 Ink UI → 完整配置校验 → `ensureInitialModelSelection()`（仅 `get_model_url` 动态 provider 且顶层 model 为空时）。
4. 创建 AgentRuntime、SessionController、CommandRegistry、HookRegistry、ServiceContainer、PluginManager、TerminalAgentSessionManager、LocalRuntimeController、MicaUiRuntimeBridge、SubagentTaskManager；当前 agent 经 `micaTools.registerRuntime(new ToolAgent(agent, subagentTasks))` 注册运行时工具上下文。
5. `setActiveContext` 暴露 ApplicationContext；`useBuiltinPlugins()` 注册 command host 与内置插件（MCP 随 runtime start/stop 建连）；`$MICA_HOME/plugins` 用户插件 `setupAll` 并写 `plugin-status.json`；最后 `uiBridge.start()`、`runtime.start()`。
6. 启动失败：UI 提示修复配置后重启，`unregisterRuntime('Agent')`、清理插件与 session、`process.exitCode = 1`。插件 setup 期间 `ctx.onDispose()` 登记的资源在失败时逆序回滚；新增 capability 必须同步登记 disposer。

## Active Context 约定

- `apps/cli/src/app/activeContext.ts` 是应用上下文的唯一全局访问入口；不要从 package 或底层工具反向 import `Application.ts` 获取状态。
- 多 agent 下命令不能假定构造时传入的 agent 永远是当前 agent，用 `createActiveAgentProxy`/`createActiveSessionControllerProxy`。
- provider/model/effort/role 切换：先 busy guard、同步当前 agent config 再开选择器；切换后 `reloadConfig(false)` + 保存 session + 同步 UI。role 切换只重建 client 并保留历史。
- 跨协议切换（chat_completions ↔ responses）被 `applyConfigSwitchUpdate` 阻止（新协议 client 无法携带旧会话历史），空会话允许；不要绕过该检查静默丢历史。恢复旧会话协议不匹配时**降级恢复**（保持 model/effort）而不是 throw。

## Runtime Turn Loop（LocalRuntimeController）

- `submit()` trim 后先走 `commands.resolve(text)`（命令走 registry；exclusive task 或运行中 agent 阻止不允许并发的命令），普通输入触发 `input:received` guard hook（message-queue 插件在 busy 时排队），未处理则进 `runTurn`。
- `after_iteration` 排队输入在完整工具迭代边界注入同一次 provider loop；`after_turn` 在 turn **成功完成（outcome 为 completed）后**发送——失败/中止的回合保留排队消息，让用户仍可用 shift+← 撤回，避免自动把消息发成下一个失败回合。message-queue 是单槽队列（`MessageQueueService`），queue 操作必须带 owner 语义；pending input 属 `pendingInputs` UI 状态，不追加到 conversationMessages 或 agent history。
- turn 先以 `running` 保存 → 工具迭代后存可恢复 checkpoint → 成功后写 assistant message（触发 `turn:beforePersist`）并以 `completed` 保存；abort/error 存 `aborted`/`error`，非 completed 会话在 `/resume` 标 `（uncompleted）`。
- **turn lease 必须在 `turn:after` 之前释放**（`runTurn` finally 内 `lease.release()`），否则 message-queue 插件在 `turn:after` 里 `submit()` 排队输入时会被自己的旧 lease 卡住，误报「该会话正在另一个终端或远程页面运行」并丢弃消息；`runTurnWithLease` finally 保留幂等兜底。
- Retry：turn 级最多 5 次、间隔 10s，重试前恢复 pre-turn snapshot；只有 `isRetryableError` 且本 turn 未出现非只读工具调用（`micaTools.isReadOnly`）时才自动重试，否则可能重复副作用。provider 内建 `withRetry`（两 client 均为 5 次、2/4/8/16/30s 指数退避、最长约 60s）只在一次尝试**还没有文本/工具输出**时重发整个请求（thinking/reasoning 事件不计入"有输出"）；收到输出后错误原样抛出交给 turn 级处理。provider 重试经 `AgentRunOptions.onRetry`（由 `AgentQueryOptions.onRetry` 透传）告知调用方，TUI 的 `LocalRuntimeController` 把它展示为与 turn 级重试同款的对话 notice（每 turn 单槽位原地更新，不刷屏）；`mica app-server` 只记 stderr。**turn 级 retry 对 headless 同样生效**（`HeadlessTurnExecutor.runTurn` 镜像同一策略：最多 `maxTurnRetries` 次、`retryDelayMs` 间隔，重试前恢复 snapshot、清 responseBuffer，abort 在重试等待期立即中断；失败尝试消费的 after_iteration 输入在下次尝试的迭代边界重放，不吞排队输入）。turn 级重试期间发 `turn:retrying` 事件（`attempt`/`delayMs`/`error`）；`mica app-server` 只把它记 stderr，**不能投影成 Codex `error` 通知**（desktop 收到 `codex/error` 会把 run 标记失败退出，不会等待重试）。
- Abort：`AgentRuntime.abort()` 递增 runId + abort controller；`LocalRuntimeController` 用 `committedResponseBuffers` 区分已写入历史的文本与 live suffix。**provider client 的流迭代结束后必须再检查一次 abort**（`throwIfQueryStopped`）：OpenAI SDK 在等待 chunk 时吞掉 AbortError 静默结束流，不检查会把被中止的请求提交成空 assistant 消息导致下一次请求 400。修改流循环时不要删掉该检查点。
- UI 展示的真相优先来自 `TerminalAgentSession.uiState.conversationMessages`，不要从 provider history 推断。

## Provider、Prompt 与模型协议

- `createModelClient` 按 `provider.protocol` 显式分流：chat_completions → ChatCompletionsClient、responses → ResponsesClient；不要按 `api_base` 猜协议。adapter 负责消息结构、history normalizer、usage 归一化、tool-call 格式与请求参数转换；runtime 不直接拼 provider 请求参数。
- 同一条 provider 消息里的工具调用由 `packages/mica-agent/providers/providerHelpers.ts` 的 `executeProviderToolCalls` 按「并行安全」分组执行：连续段的只读工具（`micaTools.isReadOnly`）与 `Agent` 调用并发（`Promise.all`），其余写/执行类工具各自作为串行屏障单独执行；结果按原始调用顺序回填，abort 检查点（`throwIfQueryStopped`）保留在每组前后。新增工具声明 `readOnly: true` 即意味着允许并发，必须保证无共享可变状态。
- 工具结果可为纯文本或文本/图片内容块。Chat Completions 先追加全部 `tool` 文本结果再用一条 `user` 多模态消息承载图片；Responses 用原生多模态 `function_call_output`。UI、日志和 run JSON 只接收文本投影，不得输出 Base64。
- 模型视觉能力由 `ModelRule.supportsVision` 表示：`packages/mica-builtin-commands/startup/model-effort-context/getModelRule.js` 从 models.dev `modalities.input` 解析（缺失或未命中默认 `true`，保守不误伤），经 `ModelClientOptions.supportsVision` 注入两个 client。**无视觉模型时**，发送层 `stripImagesForVision` 把 wire 数据里的 `input_image`/`image_url`（含用户输入、`read_image` 工具结果、恢复的历史）统一换成 `imageOmittedPlaceholder` 文本（`packages/mica-agent/providers/imagePlaceholder.ts`，要求模型如实告知用户图片被省略）。替换只作用于发送副本，`this.messages`/session 持久化保留原始图片，切回视觉模型不丢图；不要把替换做成对持久化历史的原地修改。
- Headless/交互模式的用户输入都会先经 `micaUi.parseImageRefs` 把 `[Image](路径)` 转为多模态 content block（headless 直接导入 `@packages/mica-ui/utils/imagePaste.js`，避免拖 React/Ink 进 headless 路径）。
- `buildSystemPrompt()` 默认读 `packages/mica-agent/prompt/system.md`，自定义 role 只替换 `<system>` 段；cwd 下 `AGENT.md`/`AGENTS.md` 合并注入，读取路径按 live cwd 解析（不能模块加载时冻结）。system prompt 中的 skills 只是索引。role 从 `~/.mica/role`（跟随 `MICA_HOME`）扫描 `.md` 文件，文件名去扩展名作 role 名；内置 `default` 只展示、不可被同名文件覆盖。`system.md` 及内置 default role 里的产品名用品牌占位符（`{{ MICA_APP_NAME }}` 等），加载时统一经 `packages/mica-agent/prompt/brandTemplate.ts` 的 `applyBrandTemplate` 展开为 `brand.ts` 的常量，避免模板内硬编码品牌名；未知占位符原样保留。

## 配置、本地数据与 MICA_HOME

- `packages/mica-config` 是配置与本地状态的唯一入口，UI/commands/runtime/adapter 不自己读写路径。默认 `~/.{config.json,storage.json,sessions}` 的目录名由构建期 `MICA_CONFIG_DIR_NAME`（默认 `.mica`，来自根 `mica.build.env`，经 `packages/mica-config/brand.ts` 暴露为 `CONFIG_DIR_NAME`）决定；`MICA_HOME` 显式设置时全部跟随 `MICA_HOME`，否则走品牌化默认目录（`brand.ts` 的 `resolveMicaHome`/`resolveMicaHomePath`）。测试和临时 repro 用临时 `MICA_HOME`，不污染真实目录。
- `PersistedMicaConfig` 只存静态字段（providers 等）；顶层 `provider`/`model`/`effort`/`contextWindowSize` 是运行时合成字段，经 `stripRuntimeFields` 去掉不写回 config.json。协议只支持 chat_completions/responses；启动迁移与语义校验统一在 `packages/mica-builtin-commands/startup/validate-config.js`（配置 Web 保存也复用），不要在别处另建校验规则。
- session 文件是 version 1 JSON（id/title/createdAt/updatedAt/cwd/snapshot）；snapshot 含 providerId/model/effort/role/history/conversationMessages/usage。`subagentUsageHistory` 必须独立存放（相对子 agent 自身消息数组，不能混入主 usageHistory，否则破坏 rewind 裁剪语义）。`displayUsage`（`{totalTokens, compactedAt}`，`SessionController.resolveDisplayUsage` 维护）是 compact 后的**展示用**上下文占用：compact 刻意保留 `lastUsage`/`usageHistory` 作为 Stats 对账口径，所以界面上的 ctx 必须读它，否则压缩后一切换/重载就回退成压缩前的值；下一次真实请求（`lastUsage.occurredAt` 更晚）时自动丢弃。新增字段必须有版本策略、默认值和 sanitize/parse。
- 派生标题（无 `/rename` 手动标题时）取**最后一条真实用户消息**（`SessionController.deriveTitle`，超长截断 60 字符）；compact 元数据按前缀跳过，插件注入消息（`submitAgentSessionInput` 带 `displayText`，如 context-pressure 提醒）按 `displayContent` 与 `content` 文本不一致跳过——它们不是用户输入，不得成为标题。`/agents` 列表标题（`apps/cli/src/agents/terminalAgentSessions.ts`）用同一规则，占位符是 `New session`。
- `SessionStore.list`/`listRecent` 通过 `$MICA_HOME/session-index.json`（session 元数据索引，放 MICA_HOME 根而非 `sessions/` 内，避免被 config-web 的 session 目录扫描误识别）快速列出，不再逐个 `JSON.parse` session；索引由 `save`/`delete` 同步维护。写入（save/delete）都以「磁盘最新索引」为 base **廉价合并**后落盘（只读索引文件、不重扫会话），避免多进程（交互/headless/桌面运行时）用陈旧内存缓存覆盖彼此 entry，也避免在大会话目录下每个 turn 的多次 save 反复全量读取所有 session 文件；读取时校验索引 id 集合与 `sessions/*.json` 一致，不一致（另一进程新增/删除，或索引被覆盖丢 entry）则**重建并立即持久化**拯救。重建结果始终落盘（不只在首次构建），使不完整索引自愈，后续读取不再重复重扫。它只是可随时重建的缓存，不作为事实来源；`/cd` 取最近 cwd 上限 100，`/resume` 仍可读全量索引。
- `SessionStore` 把「无 user/assistant 对话、无 usage、仅默认标题 `Untitled session`」的 session 视为垃圾（来自 `saveCurrent({ allowEmpty: true })` 的 turn 启动占位，进程异常退出后残留），`list`/`listRecent` 不展示；重建索引时删除 `turnState !== 'running'` 的垃圾文件。`turnState === 'running'` 的垃圾（可能有活跃 turn 正在写）**保留文件并被索引**（避免磁盘 id 集合与索引不一致导致每次读取都触发全量重扫），但 `list`/`listRecent` 仍通过 `isJunkSummary` 隐藏它，不占用 /resume 列表。
- `SessionController.saveCurrent` 用持久化签名检测"另一进程写盘"，签名不匹配时**降级写盘**（revision+1、以内存快照为准）而不是永久跳过，否则 headless host 后续 turn 不落盘；`refreshFromStore` 会在下次刷新收敛。
- turn lease 是 `sessions/.turn-locks/<id>.lock` 的 `wx` 文件锁，回收靠 owner pid 存活判定（`process.kill(pid, 0)`）。进程异常退出留下的孤儿锁会在下次 acquire 时随 pid 死亡回收；`SessionStore.delete` 会同步清理对应 turn-lock（session 文件已不存在也清孤儿锁），避免孤儿锁阻塞后续 continue/resume 并误报「正在另一个终端运行」。pid 被系统复用时无法只凭存活判定回收，属已知边界。

## 模型、Effort 与 Context

- effort 枚举 `none/low/medium/high/xhigh`，直接映射请求参数；未加载数据的模型默认提供 `none/low/medium/high`。provider 可设 `supportsEffort: false`（状态显示 none、不发送 reasoning effort）。缓存/种子/在线都未命中的模型用通用规则（context 1M、effort medium、全枚举、`supportsVision: true`），fallback 在 `packages/mica-config/getModelRule.ts`（与 `packages/mica-builtin-commands/startup/model-effort-context/getModelRule.js` 的 resolver 同名但职责不同）。切换 provider/model/effort 时必须 clamp effort 并同步 context window size，不要把无效 effort 持久化。
- 模型数据源优先级：磁盘缓存（`$MICA_HOME/cache/models-dev.json`，TTL 24h）→ 内置种子（`packages/mica-builtin-commands/startup/model-effort-context/seed/models-dev.seed.ts`，gzip→base64 内嵌，刷新用 `bun scripts/update-models-dev-seed.mjs`）→ 在线 `https://models.dev/api.json`。请求的模型不在缓存时**先查种子兜底**，缓存+种子都未命中才同步等在线刷新（≤15s）；降级写 stderr 告警（进程内去重）不静默；后台刷新必须透传调用方 signal。
- 只有配置了 `get_model_url` 的动态 provider 才触发模型列表查找；动态模型只缓存到内存配置和 storage 运行态，不回填 config.json。交互和 headless 都必须先注册 model-effort-context resolver 再调 `ensureModelRule`；headless 获取不到 metadata 只写 stderr 并用通用 rule，不能污染协议 stdout。
- Headless `exec` 默认输出人读文本，`--json` 输出 Codex exec ThreadEvent JSONL（`--thinking` 控制 reasoning item，不混入 text）；`--no-save` 跳过 session 落盘（一次性后台任务）。Responses 请求只要带 reasoning 参数就保留显式 `summary: 'auto'`，否则终端和 Chat 没有可展示的思考内容。

## Headless 执行与 app-server

- `apps/cli/src/runtime/HeadlessTurnExecutor.ts` 是无 UI turn 执行核心（单槽队列、发布 turn:start/finish/retrying/queued/dequeue 等事件、不触碰 Ink/UI）。**每个 turn 必须发 `turn:finish`（completed/aborted/error 三态之一）**，不要在 `runTurn` 里静默 return；**每个 turn 开始前先 `sessionController.refreshFromStore()` 再 `reserveRunId()`**，顺序颠倒会把本轮误判为 abort；重试策略与交互式 runtime 一致（见 Runtime Turn Loop 的 Retry 条目）。
- **headless 也跑内置插件**：`apps/cli/src/headless/HeadlessPluginHost.ts` 是 headless 版插件装配层，`runExec`/`runAppServer` 两个入口统一用它。**新增插件若 headless 也应具备，必须同步注册到 HeadlessPluginHost**，否则 headless 与 TUI 能力分叉。与 TUI 的刻意差异只在无等价物处：MCP 不注册插件（headless 手工参数化 `micaMcp.init`，支持 `--mcp-config`/`--strict-mcp-config`/`--mcp-init-timeout-ms`），file-mention、命令插件、用户文件插件不注册（无输入框/UI）。`attachPluginLayer()` 必须同时替换内部 queue（插件 enqueue 到 host.queue、loop 从 executor.queue dequeue，两个实例会卡死排队输入）。
- `mica app-server` 是**每会话常驻进程**：stdin 读 Codex v2 协议（`initialize`/`thread/start`/`turn/start`/`turn/steer`/`turn/interrupt`，每行一个 JSON），stdout 写 v2 通知；持有 AgentRuntime + SessionController + MCP + HeadlessTurnExecutor 直到会话关闭。**不要改成全局单 daemon**。协议实现在 `packages/mica-runtime/codexProtocol.ts`（framing/编解码）+ `apps/cli/src/runtime/CodexProjector.ts`（事件→v2 通知投影，`commandExecution` 带 `displayText`）。Mica 增量扩展（纯增量、对 Codex 客户端无害）：`mica/queue/*`、`mica/backgroundTasks/updated`、`mica/subagentTasks/updated`、`mica/sessionHistory/replaced` 三类通知，mica-code-app 直接送渲染层不进 turn 事件缓冲。
- **每个 executor turn 都必须有完整的 `turn/started` + `turn/completed`**（turnId 由 executor 的 `turn:start` 事件分配，`turn/start` 请求不再预分配；每轮 attach 新 projector 使 delta 归属本轮）。这覆盖 host 自己从队列 drain 出来的轮次（插件 `after_turn` 输入、abort 后的残留队列）——漏发会让客户端停在 idle、无法中断且下一条 `turn/start` 被 "A turn is already active" 拒绝。
- 容错约定：`--session` resume 失败、`--dir` chdir 失败、MCP 初始化失败都**降级继续**，不退出进程；但只有 resume 失败发 Codex `error`（客户端的 thread 假设已被破坏），`--dir`/MCP 初始化失败/游离 `unhandledRejection` 一律发 `warning`（非致命，客户端不得据此结束 run；mica-code-app 映射成 `notice` 事件）。进程注册 `unhandledRejection`（记录+warning、不退出）与 `uncaughtException`（error 通知后退出）兜底；`exit(code)` 前先 flush stdout/stderr。

## 命令系统

- 通用机制在 `packages/mica-commands`，产品命令在 `packages/mica-builtin-commands`；`apps/cli/src/plugins/commands/index.ts` 注册到 CommandRegistry 并同步 mica-ui quick commands。命令经 `CommandRuntimeServices`/active proxy 注入，不依赖应用层单例；耗时且改状态/文件/配置/git 的命令走 runtime exclusive task。
- 命令分层约定：**实现**（`createXxxCommand` + 逻辑/工具/UI，纯 .ts）统一在 `packages/mica-builtin-commands/commands/`，**装配**（`setupXxx(ctx)` 经 `CommandHostService` 注册，可传 `allowDuringTurn`）在 `packages/mica-builtin-commands/plugins/command-*.ts`，两者均由 `packages/mica-builtin-commands/index.ts` 统一导出；`apps/cli/src/plugins/commands/index.ts` 的 `BuiltInCommandsPlugin` 是另一条 quick-commands 注册路径。
- `ALLOW_DURING_TURN_COMMANDS`：`status`、`context`、`agents`、`new`、`fork`、`exit`、`rename`、`task`（exclusive task 期间额外 `status`/`task`/`agents`/`new`）。`/model`、`/effort` 打开 selector 前检查 busy 并二次 guard。交互反馈统一用 `services.showNotice`，不用 `showMessage`。
- 当前内置命令：`/clear`、`/resume`、`/model`、`/effort`、`/role`、`/status`、`/context`、`/compact`、`/commit`、`/new`、`/fork`、`/task`、`/rewind`、`/mcp`、`/skills`、`/rename`、`/exit`、`/loop`。要点：`/compact` 与 headless `mica compact --session` 走同一 `CompactionService`；`--prune-only` 只做本地清理、不调用模型，工具结果与工具参数无条件替换为合法 JSON 占位符（`TOOL_ARGUMENTS_PLACEHOLDER`，否则 provider 400）；headless `mica commit` 复用 `commitRunner.ts`，只发一次模型请求。`/loop <任务描述>`（间隔可省略，默认 30 分钟；也可 `/loop <间隔> <任务描述>` 指定间隔） 由 `packages/mica-builtin-commands/plugins/loop.ts` 注册（`LoopController` 进程内调度、定时器 unref），循环运行时经 `system-prompt:build`（priority 20）在 system prompt 末尾追加 loop 指引，每轮提交前先做一次 prune-only 本地压缩（`services.compact`，不调用模型；无可清理内容静默跳过，压缩失败只提示不中断循环），再经 `submitAgentSessionInput` 以 after_turn 提交任务、忙时由 message-queue 兜底排队；`/loop stop` 停止并移除指引。loop 运行期间同时注册 `loop_status`/`loop_set_interval`/`loop_set_task`/`loop_stop` 工具（`primaryAgentOnly`，实现位于 `packages/mica-builtin-commands/commands/loop.ts`，插件装配在 `packages/mica-builtin-commands/plugins/loop.ts`），供模型在对话中查看/修改间隔（`LoopController.updateInterval` 重新计时）与任务或停止循环；工具校验调用者是主 agent 且循环 owner 是当前会话。loop UI：`LoopController` 状态变更经 `onStateChange` 推送到 mica-ui 的 `panels.loopStatus`（`MicaUiLoopStatus`，仅 TUI 注册 loop 插件），运行中输入框显示常驻徽标（`PromptFrame` `loop` 模式，`buildLoopBadge` 拼装：间隔/下次触发倒计时/已执行次数，秒级刷新；`/loop stop` 后徽标消失）。
- 新增/删除命令时检查：`apps/cli/src/plugins/commands/index.ts`、`packages/mica-builtin-commands/index.ts` + README、`packages/mica-builtin-commands/index.ts`、根 `README.md`、`AGENT.md`。

## Tools、MCP 与 Skills

- `packages/mica-tools` 是唯一工具 registry；运行期产品工具优先由插件 `ctx.tools.register()` 注册。新增工具继承 `MicaTool`（参数 schema、展示文案、错误格式化、只读属性）。retry 可重放依赖 `micaTools.isReadOnly`，内置只读语义有全集测试锁死（`packages/mica-tools/tests/MicaTool.test.ts`）：纯查询类（read_file/read_image/list_files/grep_search/web_fetch/web_search/Skill/background_tasks/read_task_output）必须 `readOnly: true`，写/执行类（write_file/apply_patch/run_shell/kill_task 及 pty 系列）不得标；改标记同步更新该测试。
- PTY 工具（pty_spawn/send/read/wait/kill）驱动交互式 TUI 验证：node-pty 在 Bun 进程内不工作，PTY 会话由懒启动的 Node 子进程（`packages/mica-pty/src/server.mjs`，JSONL over stdio）承载，首次调用动态 import `@packages/mica-pty/src/manager.js`。**node-pty 必须保持 external，禁止静态 import `node-pty` 或 `mica-pty/index.js`**。`ptyServerSource.ts` 是 `server.mjs` 的 JSON 转义内嵌；改 `server.mjs` 后必须跑 `bun run scripts/generate-pty-server-source.mjs`（`serverSource.test.ts` 校验同步）。
- 当前内置工具：read_file、read_image、write_file、apply_patch、list_files、grep_search、run_shell、background_tasks、read_task_output、kill_task、pty_spawn/pty_send/pty_read/pty_wait/pty_kill、web_fetch、web_search、Skill。交互模式 `TodoWrite` 由 Todo 插件注册（headless 也有独立实例，不依赖 React/Ink）；Todo 状态只属当前进程/turn、不写 session，turn 正常结束把所有未完成项（in_progress 与 pending）标 completed（否则残留的 pending 项会让列表永远显示 remaining），abort/error 把 in_progress 转 pending。
- `session_*` 会话自治工具族由 `packages/mica-builtin-commands/plugins/session-autonomy/` 注册（`primaryAgentOnly: true`，交互与 headless 都注册）：`session_info` 保持 `readOnly: true`；`session_compact` 是延迟写——工具执行只登记，**turn 正常完成后（`turn:after` 且 outcome 为 completed）立即应用**，该 handler 的 priority 是 50，必须保持在 message-queue 的 turn:after（100，会启动下一轮）之前，否则应用与下一轮请求构建竞态；`turn:before`（10）兜底并 await 在途应用（`applyingByOwner`）。不能在工具执行时改 snapshot（agent 正 busy）。引导文字必须固定（动态数字会打散 prompt cache）。
- `packages/mica-builtin-commands/plugins/context-pressure/` 订阅 `ctx.events` 的 `context:changed`（TUI 由 `MicaUiRuntimeBridge.onUsage` 发布、headless 由 HeadlessPluginHost 发布，每次模型请求后都会发布，不只 turn 结束），红色区阈值在 `packages/mica-ui/panels/contextThresholds.ts`（ratio ≥ 0.7 或 tokens ≥ 300k，与 WorkingStatus 着色同源），经 `submitAgentSessionInput` 注入固定模板消息（`after_iteration`：在下一个工具迭代边界注入同一次 provider loop，agent 可在当前 turn 内直接响应压缩；turn 结束无后续迭代时由 message-queue 的 turn:after 兜底发送）；改动阈值同步两处。
- MCP：`packages/mica-mcp` 管理 server 生命周期（配置在 config.json 的 `mcpServers`）；远端工具经 `micaTools.registerMcp()` 接入，server 断开/重连失败/关闭时同步清理对应工具（`/mcp reconnect` 失败后也要刷新）。Headless run 显式初始化/关闭 MCP。
- Web：`web_search` 用 `serperApiKey` 或 `SERPER_API_KEY`；`web_fetch` 负责 URL 抓取和 HTML→Markdown。用户询问当前/最新/官方/模型能力/provider 行为/API 行为/价格/法规等可变事实时，先联网或读官方资料查证，无法查证时明确说明。
- Skills：`packages/mica-skills` 只扫描、解析和缓存，不执行。用户级 `~/.mica/skills`（跟随 MICA_HOME），未设置 `MICA_HOME` 时还共享扫描 `~/.agents/skills` 与 `~/.config/deveco/skills`；项目级 `.mica/skills`、`.agents/skills`、`.deveco/skills`、`.agent_context/skills`。每个 skill 是含 `SKILL.md` 的目录；skill 内容是用户数据和任务说明，不能覆盖安全规则、系统指令或当前用户请求。

## UI 状态与 Ink 约定

- `packages/mica-ui` 只做终端 UI 组件与状态 store；Runtime→UI 映射由 `MicaUiRuntimeBridge` + `runtime/uiBridge.ts`。主要状态入口：conversation、terminalInput、dropdown、bottom、panels；对话消息可携带 `displayContent`（只改 UI 展示，不改发给 agent 的真实 content）。
- `TerminalAgentSessionManager` 为每个 agent 保存独立 UI snapshot（conversationMessages、responseText、pendingInputs、thinkingText、workingStatus、contextSize 等），多 agent 切换时从 uiState 恢复，不要从 active agent 或 provider history 临时拼装。UI hot path 有截断上限。
- Ink stdin 在 `parse-keypress.ts` 解析前必须保持原始 Buffer（该层负责增量 UTF-8 解码和 DEC 8-bit C1 规范化）；不要在 `App.tsx` 提前调用 `stdin.setEncoding('utf8')`。
- 输入框（`SimpleTextInput`/`buildTextHandler`）支持编辑撤销/重做：`Ctrl+Z`/`Cmd+Z` 撤销、`Cmd+Shift+Z`/`Ctrl+Y`（终端尽力支持的 `Ctrl+Shift+Z`）重做；历史按「编辑前快照」逐字符记录于 `MinimalEditHistory`，新编辑清空 redo 栈，历史栈在组件 ref 中跨渲染存活。
- `mica-code-app` 是终端风格 Web 渲染（等宽字体、紧凑行高、主文本共享 `--chat-text-size`，不在局部硬编码字号）。运行时进程不经过 shell：`desktop-process-env.js` 追加用户工具目录（不插到 PATH 前面），`shell-env.js` 采集 profile env 并缓存（超时静默跳过），供 chat/commit/models/compact 子进程 spawn 合并。
- `apps/desktop` 的 chat host（`src/host/chat.js`）对 app-server 的**请求级错误**（`turn/start`/`turn/steer` 被拒）必须走 `chat:queue-error` 撤回乐观消息并恢复输入草稿，不能只发 `error` 事件（否则消息看似已发、运行态卡住）。队列展示只有一个事实来源：`src/host/chat-queue.js` 的 `mergeQueuedItems(id, hostPending, localItems)`（host 侧 after_iteration 在前、标 `pending` 不可撤回），`chat:start` 的单槽判定、`chat:queue-state`、`chat:exit`、`chat:recall-queued`、`chat:is-running` 都必须用它——漏掉 host 侧 `hostPending` 会让第二次输入被 host 以「已有一条排队消息」拒绝，或切走再切回后等待中的消息消失。`src/host/chat-events.js` 解析 `commandExecution.command` 必须按**第一个空格**切分（host 侧格式是 `name + ' ' + JSON.stringify(args)`）；`split(/\s+/)` + `join(' ')` 会压掉 JSON 字符串里的连续空格、静默改坏工具入参。常驻 host 的恢复重放缓冲 `run.events` 与 `run.prompt` 必须在每次 `sendTurnStart` 时按轮重置（只描述本轮）；`ChatView` 恢复时先用 `historyBeforeRunReplay` 裁到本轮用户消息边界再重放——磁盘中间 checkpoint 与完成保存已把本轮回答写进 `conversationMessages`，不裁就重放会把同一条消息渲染两遍。`thread/tokenUsage/updated` 必须**每次模型请求后立即转发**给渲染层（不能只攒到 `turn/completed` 的 `step_finish`），否则长 turn（大量工具迭代/长流式输出）期间输入框状态栏的 tokens/cached/ctx 不刷新；状态栏的 tokens/cached/ctx 必须取 `tokenUsage.last`（最近一次请求=当前上下文占用，与 TUI `uiState.contextSize` 同源），不能用 projector 的 turn 级累加 `total`（多迭代 turn 会显示成累加值、严重偏大）。`usage` 实时事件只更新 `lastUsage`/`cachedRate`，**不得**改动 `turnState`/`updatedAt`（它们参与 `isPersistedRunComplete` 判定，运行中改写会让恢复流程误判本轮已结束）。

### apps/desktop 的架构：Web 运行时 + Electron 容器

应用的本体是一个 Web 页面，由 `src/server/` 的运行时托管；Electron 只是它的容器，**不含业务逻辑**。这套边界不能倒过来：

- `src/host/`：业务核心（terminals / chat / files / git / stats / workspace / settings / notifyServer / chat-\* 等），只跑在运行时进程里。
- `src/server/index.js`：运行时本体。零依赖 Node HTTP 服务，托管 renderer 产物、把 host 能力暴露为 `POST /api/invoke`，推送走 `GET /api/events`（SSE），并**广播给所有客户端**（手机与桌面窗口共享同一状态）。`vite.server.config.mjs` 把 `electron` 别名到 `src/server/electron-shim.js`（`ipcMain.handle` → channel 注册表、进程内单例 `event.sender`、`app.getPath`/`shell`/`clipboard`/`dialog` 的纯 Node 实现）。
- `src/main/index.js`：Electron 外壳。只做三件事——拉起运行时（`spawn(process.execPath, [out/server/index.mjs], { ELECTRON_RUN_AS_NODE: '1' })`，用 stdin 管道保证父进程退出时运行时跟着退）、把窗口 `loadURL` 到运行时地址、订阅 SSE 把未读数映射成 dock 徽标 / 任务栏闪烁。**不要在外壳里注册业务 IPC，也不要加回 preload**：页面里的 `window.mica` 始终由 renderer 的 transport 经 HTTP + SSE 建立，加回 preload 会让页面走 IPC 而运行时里没有对应 handler。
- `src/renderer/`：页面。`transport.js` 是 `window.mica` 的实现（`main.jsx` 挂载前经 `ensureMicaApi()` 安装），`window.mica.isWeb` 用来分支那些只有本机窗口才成立的行为；**不要在业务组件里直接判断运行环境**，平台差异收敛在 transport 层。连不上运行时时 `main.jsx` 渲染可读提示而不是白屏。

- 命令（在 `apps/desktop/` 内）：`npm run dev`（先构建运行时，再 `electron-vite dev`；页面走 Vite dev server，`electron.vite.config.mjs` 把 `/api` 代理到运行时）、`npm run build`（= `build:app` + `build:server`）、`npm start`（跑构建产物）、`npm run start:web`/`serve:web`（只跑运行时供浏览器访问）。因没有 preload 段，electron-vite 命令都带 `--ignoreConfigWarning`。
- 运行时参数：`--host/--port/--renderer/--allow-missing-renderer` 或 `MICA_DESKTOP_{HOST,PORT,RENDERER}`，默认 `0.0.0.0:8787`；端口被占用时回退随机端口并在 stdout 打印 `[mica-desktop] ready {json}`（外壳据此拿实际地址）。`GET /api/health` 用于探活与「这个端口上是不是本应用」。`MICA_DESKTOP_EXIT_ON_STDIN_CLOSE=1` 让运行时在 stdin 关闭时退出，避免孤儿进程占着端口与 PTY。
- 降级点（改动时勿回退）：目录选择器改应用内 `DirectoryPicker`；`files.copyPath/copyRelativePath` 在浏览器本地写剪贴板（http 局域网非 secure context，需 `execCommand` 兜底）；外链在浏览器打开；终端文件链接派发 `mica:open-file` 交 `App.jsx` 打开应用内编辑器；`settings:open` 的 URL 主机重写为 `location.hostname`，运行时以 `MICA_CONFIG_WEB_HOST=0.0.0.0` 拉起 config-web 并放宽 `frame-src`（配置页 iframe 里的 127.0.0.1 会指向客户端自己）；窗口聚焦/可见由 `document.visibilityState` + focus/blur 推导。
- `MICA_DESKTOP_USER_DATA`（外壳传 `app.getPath('userData')`）与 shim 的默认值必须解析到同一个 `mica-code-app` 目录，否则 workspace/file-order/session-pins 在两套运行方式之间不共享。
- 容器注入的 `ELECTRON_RUN_AS_NODE` 只对运行时进程自身有意义，**绝不能外泄**：`startDesktopServer()` 一进来就调 `stripContainerEnv()`（`src/host/desktop-process-env.js`）把它从 `process.env` 摘掉，之后派生的 PTY 终端、`mica` chat/commit 子进程、shell env 采样、config-web worker 才不会继承它。泄漏后果是用户在自己的终端里跑 `electron`（例如 `electron-vite dev`）会被当成纯 Node 启动——`require('electron')` 只拿到可执行文件路径，`electron.app.isPackaged` 直接抛 `Cannot read properties of undefined`。改动启动顺序或新增 spawn 点时，保持 `stripContainerEnv()` 在所有派生之前。
- 移动端：< 768px 时 shell 由三栏网格切为单栏 + 抽屉（会话列表、右侧面板），Files 面板在目录树与编辑器之间切换（带返回按钮），右键菜单配 `longPressHandlers` 触屏长按等价（该 helper 对鼠标指针直接跳过，不影响桌面）。`?layout=mobile` / `?layout=desktop` 可强制布局用于预览。`index.html` 的 viewport 带 `viewport-fit=cover`（页面铺满整屏），手机圆角/刘海/home indicator 由 `assets/app.css` 安全区块的 `.safe-top`/`.safe-bottom` 让开——这些元素用 `box-sizing: content-box`，内边距加在 `h-10`/`h-7` 之外（原高度留给内容、不被挤扁），元素自身背景色铺满内边距才与相邻区域无缝；目前标在顶栏、底部状态栏与两个抽屉上，**新增贴边（顶/底）元素时要一并标上**，否则内容会被压在安全区下面。对话状态行（`.chat-status-line`）在移动端拆成两行（状态 / 模型与用量），不要恢复成 `grid-template-columns: minmax(0, 1fr) auto` 的一行。`assets/app.css` 的移动端块把表单控件字号下限锁在 `16px`（选择器写成 `#root input, #root select, #root textarea:not(.inputarea)` 才能压过组件上的 Tailwind 字号工具类）——iOS Safari 聚焦字号更小的输入框会放大整页且失焦不还原，而 monaco 的隐藏 `inputarea` 参与编辑器测量与 IME 定位，必须排除，**不要把它当成冗余样式删掉**。输入框附件入口（聊天 composer 的上传图片按钮 + 隐藏 file input）与粘贴共用 `[Image](...)` 引用链路。
- 会话行的终端标记：右侧面板终端不在 `nodes` 里，创建时把当前会话 id 记进 `rightTerms` 条目（`App.jsx` 的 `createRightTerm`），`sessionsWithRunningTerminal` 再用 notify 状态里的 `processRunning`（`serializeStates` 必须同时透出 `agentRunning`/`processRunning`，`running` 是二者合并值、分不出终端）映射回左侧会话行，行首显示高亮终端图标。`processRunning` 由 `terminals.js` 的前台进程轮询（≥1.2s 才算，仅 macOS/Linux）经 notify server 上报。该标记与 Mica turn 的呼吸绿点、未读圆点共用 `SessionTree.jsx` 行首那个固定 `w-4` 的状态位（`RowLeading`）：终端图标 > running 绿点（`chat-dot-running`，只做透明度呼吸，不缩放也不给整行标题变色）> 未读圆点；显示终端图标且同时未读时把圆点绝对定位叠在图标右上角，**不要另起一个 flex 兄弟节点**，否则这一行会比相邻行多占「图标宽 + gap」（22px）、标题缩进对不齐。
- 滚动条：应用内一律不显示滚动条样式（内容照常可用滚轮/触控板/键盘滚动）——`assets/app.css` 的 `* { scrollbar-width: none }` + `*::-webkit-scrollbar { display: none }` 统一隐藏；新增滚动容器不要再写滚动条样式，也不要用 `scrollbar-gutter`，历史标记类 `.thin-scrollbar`/`.hidden-scrollbar` 已移除。两个自绘滚动条必须单独关：monaco 走 `monaco.js` 的 `scrollbar: { vertical: 'hidden', horizontal: 'hidden' }`；xterm 6 的滚动条是 VS Code ScrollableElement 渲染的 DOM 节点（`::-webkit-scrollbar` 覆盖不到），由 `.terminal-pane .xterm-scrollable-element > .scrollbar { visibility: hidden }` 隐藏。
- 底部状态栏（`App.jsx` 的 `<footer>`）：左侧分支名 `max-w-[45%] shrink-0`，右侧路径 `min-w-0 truncate` 按内容取宽、只在空间不足时截断——**不要给路径加成比例 `max-w-*`**，否则空白很多也会提前省略。
- 对话行的行首符号：`.chat-message` 是 `marker | body | actions` 三列网格（第三列 22px 只给复制按钮留位），行首 `▌`（user）/`●`（assistant）贴首行顶部（marker `padding-top: 1px`）。user 的 `▌` 必须与 Notice 的 `▌` 完全同款——同一列（**不要 `margin-left`**）、同字号（`11.5px`，取自 `.chat-notice`）、同色（`--color-fg`），否则同一屏里两个 `▌` 的大小/亮度/缩进对不上。user 消息块的 `padding-block: 5px` 也必须与 Notice 相同，否则文字会贴住高亮区的上下边缘、看起来比 Notice 扁。**不要给 `.chat-message-user` 加 `align-items: center`**——它会把 marker 挪到多行消息的垂直正中，看起来像悬在半空。复制按钮**必须绝对定位**（`position: absolute; right: 0`，user 再加 `top: 5px`）：一旦作为网格项参与布局，它 23px 的高度会把**单行**消息的网格行撑到 23px（块高 33px 而非 26.6px），正文首行下方多出一截空白、上下留白不对称——多行消息内容更高所以看不出来，也正是这个 bug 只出现在单行的原因。
- 运行时**无认证**：能连上端口就等于拿到宿主 shell。默认绑定 `127.0.0.1` 之外必须在文档中显式提示风险（当前默认 `0.0.0.0` 是产品决定，改动时同步 README）。
- 主题：`apps/desktop` 与 `apps/config-web/web` 共用一套 Darcula（JetBrains Darcula）调色板，两处是唯一色彩来源且值一一对应——`apps/desktop/src/renderer/assets/app.css` 的 `@theme` 块（Tailwind 令牌，同时供 `bg-*/text-*/border-*` 工具类使用）与 `apps/config-web/web/src/styles.css` 的 `:root` 块，**改一处必须同步另一处**，规则里只允许引用 token、不要再写字面色值。前景色是一条连续梯级，每一档都取自主题自身的条目（最亮到最暗：`#ffffff` activityBar.foreground、`#d4d4d4` tokenColors 默认文本、`#cccccc` terminal.foreground、`#a1a1a1` tab.inactiveForeground、`#999999` editorLineNumber.activeForeground、`#888888` panelTitle.inactiveForeground、`#707070` scrollbarSlider.activeBackground、`#606366` editorLineNumber.foreground）；不要为省 token 把多档亮色并进同一档，那会把阅读面整体压暗且难以后期发现。该主题基于 `vs-dark` 却未定义 `terminal.foreground`，所以 `#cccccc` 就是 VS Code 的回退值，也是对话阅读面正文色（`.chat-markdown`、`.chat-message-user` 等，桌面映射到 `--color-fg`，config-web 映射到 `--text`）——**不要**把它改回 `editor.foreground`（`#a9b7c6`）或任何更暗的值。表面色同样只取主题自身的条目，按「内容 → 外框」分层：`#2b2b2b` editor/terminal.background（内容区——主区、聊天、编辑器、终端）、`#3c3f41` 是 activityBar/sideBar/panel/statusBar/input/menu 共用的外框色（侧栏、右侧面板、活动栏、标签栏、页眉、卡片、弹窗、下拉（底部状态栏除外——它是相对叠加色 `bg-black/10`，不属外框层）；聊天输入条 `.chat-composer` 属内容面、用 `--color-canvas`，靠上下各一条 1px `--color-line-strong` 与相邻区域分隔；其拖动手柄 `.chat-composer-resizer` 用 `top: -(height / 2 + 1px)` 让中心压在顶边框线上，并靠 `place-content: center` 允许图标高于内容盒仍精确居中——改按钮尺寸时两者都要同步）、`#46484a`（派生，外框内嵌套面）、`#515658` tab.activeBackground（选中）；desktop 映射到 `--color-canvas/--color-panel/--color-panel-hi/--color-active`，config-web 映射到 `--bg/--panel/--panel-muted/--panel-hover`。**不要拿 `#323232` 铺外框**——它在主题里是 `editor.lineHighlightBackground`（当前行高亮），与 `#2b2b2b` 内容区只差 7 级，铺侧栏/面板会让整屏糊成一片、区分不出区域；外框必须用 `#3c3f41`（与内容区相差 17 级）才是 VS Code 的观感。边框只有 `--color-line` `#4b4b4b` 一个值（主题里 9 个 `*.border` 全是它），区域分界一律用它而不是半透明白，并且外框面与内容面之间必须留这条发丝线。monaco（`src/renderer/src/monaco.js`、`config-web/web/src/components/MonacoJsonEditor.tsx`）与 xterm（`TerminalHost.jsx` 的 `terminalTheme`）在 canvas 上绘制、读不到 CSS 变量，必须手工同步同一组十六进制值；`src/renderer/index.html` 的 `theme-color` 与 `public/manifest.webmanifest` 同理。半透明白/黑叠加（`rgb(255 255 255 / x%)`、`bg-white/10`）是相对色、跟随底色，保留即可；由 token 派生的半透明色写 `color-mix(in srgb, var(--x) n%, transparent)`（CSS）或 `bg-x/10`（Tailwind）。
- 输入条动作区（`.chat-composer-actions`）的运行态/排队态配色必须按按钮定位：只有「停止生成」用 `--color-danger`（`ChatView.jsx` 的 `chat-composer-stop`）、「加入发送队列」用 `--color-warn`（`chat-composer-queue-send`），上传按钮与运行态无关、始终中性——**不要**用 `.chat-composer-actions button` 或 `button:first-child` 这类整体选择器，上传按钮排在动作区最前，会被一起染成危险色/警告色。

## 多 Agent、Session、Rewind、Compact

- `Agent` 工具的后台 subagent 由 `SubagentTaskManager` 管理：按 parent agent 隔离 task、独立 abort signal、经 runtime system queue 把完成元数据回注 owner（结果需 `operation=read`/`await` 显式读取）；Ctrl+C 中止 parent turn 时同步 abort 该 owner 的 running subagent。记录留在 manager 供 `/task` 查看（每 parent 100 条轻量 summary，结果只在当前进程内存在）。
- 前台 `Agent` 调用（默认 `run_in_background: false`）阻塞本轮直到子代理返回；同一条消息里的多个前台调用会并行执行（各自独立 child agent 与路径租约）。并发上限 4 由 `SubagentTaskManager` 按 owner 统计（前台 + 后台合计），并行前台调用也会占用该额度。需要主流程继续推进时必须用 `run_in_background: true`。
- subagent 默认按 `context_mode`（none|brief|recent|files）注入 `<delegated-context>`，默认 `brief` 不继承完整历史；可写 subagent 用 `owned_paths` 路径租约（Implementer/Tester/Proposal 必填），写工具与 run_shell cwd 校验所有权；`maxTurns` 必须传到 provider query loop；未知 subagent_type 报错不得静默降级。内置类型：general-purpose、Explore、Implementer、Reviewer、Tester、Planner、Proposal。
- `RewindCheckpointManager` turn 前创建对话和文件 checkpoint，保留"用户输入之前"的状态。`packages/mica-context` 提供 `CompactionService`，compact 结果经 runtime/session 层接入，provider adapter 不直接感知 compact 策略。
- compact 可裁剪 tool result、媒体和 base64，**绝不能把 tool-call `arguments` 截成自由文本**（过长或损坏参数必须改写成合法 JSON 占位，否则 provider 400）；应用 checkpoint 时必须保留原 `usageHistory`/`lastUsage`（禁止清零，否则 Stats 对账缺口）。compact/review/commit 等需模型调用的命令走 subagent 或 exclusive task，不污染当前正在运行的 turn。

## 构建、安装与发布

- `bun run build` = `MICA_PREBUILD_DONE=1 bun scripts/build.mjs`（prebuild 是 `bunx tsc --noEmit`，postbuild 是 `bun scripts/install.mjs`），`bun build --compile` 输出无外部运行时依赖的 `dist/mica`。install.mjs 默认装到 `$HOME/.local/lib/mica` + `$HOME/.local/bin/mica` 薄 launcher（`MICA_INSTALL_DIR`/`MICA_INSTALL_PACKAGE_DIR`/`MICA_BIN_NAME` 可覆盖）。
- build.mjs 读取根 `mica.build.env`（键 `MICA_RUNTIME_NAME`/`MICA_VERSION_LABEL`/`MICA_APP_NAME`/`MICA_CONFIG_DIR_NAME`，构建期同名 `MICA_*` 环境变量优先于文件）经 `bun build --define` 注入 `__MICA_*__` 常量，由 `packages/mica-config/brand.ts` 统一暴露为 `RUNTIME_NAME`/`VERSION_LABEL`/`APP_NAME`/`CONFIG_DIR_NAME` 与 `resolveMicaHome`/`resolveMicaHomePath`。它们驱动 `--version` 标签、CLI 用法命令名、默认配置目录与 UI/插件产品名；未定义时全部回落为上游默认值（源码运行与未改构建行为不变）。install.mjs 的 `MICA_BIN_NAME` 默认也取 `MICA_RUNTIME_NAME`。被 `bun build --define` 注入的常量同样驱动文本模板中的 `{{ MICA_APP_NAME }}` 等占位符展开（`packages/mica-agent/prompt/brandTemplate.ts`），默认构建下展开结果与硬编码一致，re-brand 时模板无需改动。**改动品牌键必须同步根 `mica.build.env` 与本文件**。
- 内置 models.dev 种子由 `scripts/update-models-dev-seed.mjs` 刷新（下载→校验→gzip→base64 原子写入 `packages/mica-builtin-commands/startup/model-effort-context/seed/models-dev.seed.ts`）；CI 在 release 构建前 best-effort 刷新，失败仅 warning、用仓库固定副本，绝不阻断构建。
- 品牌标志**全仓库只有一份**：`apps/desktop/resources/icon.svg`，任何地方都直接引用它，不要再复制/派生副本（website/config-web/README 曾经各存过一份扁平色块版 M，已删）。它是**满幅**形态（瓦片铺满 viewBox）：网页图标必须满幅，否则浏览器标签与 iOS「添加到主屏幕」里的图标会缩一圈；macOS 原生图标要的 824/1024 经典网格外边距由 `apps/desktop/scripts/generate-icons.py`（`npm run icons:generate`，agent 环境无 Pillow 时跑不了，只影响重新生成位图）渲染时**外扩 viewBox** 补上，不写在 svg 里，`apps/desktop/build/icon.svg` 那份旧副本已删（electron-builder 只读 build/icon.icns|ico|png）。引用方式：官网 `apps/website/src/{layouts/BaseLayout,pages/index}.astro` 用 `import markUrl from '../../../desktop/resources/icon.svg?url&no-inline'`（`?no-inline` 必须保留，否则 Vite 会把它内联成 data URI、同一份标记在页面里重复多份；资源地址由构建自动加 base 前缀，不要手拼 `${base}`）；config-web 在 `web/index.html` 里用相对路径 `../../desktop/resources/icon.svg`（Vite 会改写并产出到 `dist/assets/`）、`web/src/layout/Sidebar.tsx` 同样 `?url&no-inline` 导入。桌面端自家的 favicon/PWA 位图仍由 generate-icons.py 生成到 `src/renderer/public`（PWA 图标必须是 PNG）。
- 用户报告启动、startup UI、build/install 行为与源码不一致时，先确认实际运行的是哪个入口：`~/.local/bin/mica` launcher、`~/.local/lib/mica/mica`、`dist/mica` 可能不一致。
- deploy-pages：`actions/configure-pages` **只暴露 outputs，不会注入 `PAGES_BASE_PATH` 环境变量**，Build 步骤用 `env.PAGES_BASE_PATH` 显式传入；Astro 不会自动给硬编码绝对路径加 base 前缀，布局/页面里所有内部链接必须用 `import.meta.env.BASE_URL` 拼接。

## 测试与验证

- **全量 `bun run test` 约 7~8 分钟**（大头是真实 spawn 的端到端套件：app-server.flows ~60s、commit.flows ~63s、pty driver ~17s、models.flows）。日常默认只跑局部：`bun run test -- <测试文件>`；全量只在发布前、改动影响跨多个慢套件或 CI 要求时跑。
- 单元/集成测试走 `bun run test`（vitest，Node 环境；不要用 `bun test`）。交互式 TUI 测试优先 `packages/mica-pty`：`PtyDriver` 只能在 Node/vitest 下 import（Bun 下不可用），内置 PTY 工具运行时（`PtyManager` + Node helper 桥接）Bun 主进程可安全使用。
- `apps/cli/src/cli/app-server.flows.test.ts` 真实 spawn `mica app-server` + 本地 mock OpenAI provider，**不需要真实 API key**，默认随全量运行；compact 测试需至少两轮对话且超过 recent-token budget，resume host 必须复用同一 `MICA_HOME`。
- PTY 冒烟验证需要真实 provider key，默认跳过：`bun run build` 后 `MICA_PTY_SMOKE=1 npx vitest run packages/mica-pty/tests/mica.smoke.test.ts`（flow 变体用 `MICA_PTY_FLOW_SMOKE=1` + `MICA_PTY_SOURCE_HOME`）。vitest 会重定向 `HOME`，必须显式传 `MICA_PTY_SOURCE_HOME`（测试只复制 config.json 到隔离的 `MICA_HOME`，不触碰用户数据）。
- 常规 pty 测试：`bun run test -- packages/mica-pty/tests/driver.test.ts packages/mica-pty/tests/manager.test.ts packages/mica-pty/tests/serverSource.test.ts`。

## 工作区安全与变更检查清单

- 开始修改前查看 `git status --short`；不要回滚、覆盖、格式化或删除与任务无关的用户改动；修改已有未提交改动的文件时先读清当前内容再补丁合并。不使用 `git reset --hard`、`git checkout --`、强推、批量删除；不用 `--no-verify` 过检查；不自动 commit、push、建分支或开 PR。
- 递归搜索用 `rg` 或 `rg --files` 并排除 `temp/`、`node_modules/`、`dist/`，例如 `rg "pattern" src packages scripts docs blogs --glob '!temp/**'`；只有用户明确要求才进入这些目录。
- 变更前检查：provider/model/effort/role 切换（busy guard、config/storage 分离、effort clamp、context size、role 回退）；provider 协议（请求参数与 history normalizer）；turn loop（queue/retry/abort/partial response/session save/hooks）；UI 状态（uiState、conversationMessages、responseText、thinkingText、workingStatus）；多 agent（active proxy、owner-aware queue、background agent、session switch）；MCP/tools（registry 清理、readOnly 标记、输出截断）；skills；session/rewind/compact（snapshot 版本、UI restore、display state 边界）；desktop（业务代码只能进 `src/host`，运行时与外壳的边界不倒退，本机专属 API 在 `transport.js`/`electron-shim.js` 都有降级，移动端断点与长按）；build/install（本地 dist 与已安装 mica 一致）；docs（本文件、README、package README 同步）。只要答案是"会影响"，就把文档同步作为本次交付的一部分。
