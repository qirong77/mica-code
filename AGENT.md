# Mica Code 仓库说明

本文件面向后续 agent 和开发者，记录会影响代码修改方式的稳定约定。实现细节请优先读相邻源码和对应 package README，不要把本文件扩写成流水账。

## 项目定位

- Mica Code 是一个基于 Bun + TypeScript + React（Ink）的终端 code agent。
- 核心目标是把 CLI 启动、runtime turn loop、模型 provider、工具、命令、会话、配置、UI、插件和 skills 分层管理，为 compact、memory、todo、fork、multi-agent 等长期能力保留清晰扩展点。
- 仓库采用 `src/` 应用装配层 + `packages/` 可复用包的结构。新增通用能力优先放入对应 package，`src/` 只做应用级 wiring 和跨包编排。
- 设计上偏向 append-only 会话历史和稳定 prompt 前缀：默认追加消息、工具调用、工具输出和日志，只有在上下文压力明显影响推进时才在阶段边界 compact。

## 快速命令

```bash
bun run dev             # 开发运行
bun run typecheck       # 类型检查：bunx tsc --noEmit
bun run test            # 运行项目 Vitest 测试；不要直接运行裸 bun test
bun run build           # 类型检查后用 bun build --compile 构建本地二进制并安装
bun run format          # 格式化 README、AGENT、src、packages、scripts、docs、blogs
```

引擎要求：Node `>=22`，运行时与包管理使用 Bun。

## 目录结构

```text
src/                         应用装配层：入口、Application、runtime、session、插件 wiring
  index.ts                   CLI 入口：dotenv、错误钩子、Application 启停
  app/                       Application、ApplicationContext、activeContext、runtime/UI adapter
  agent/                     AgentRuntime 与运行时配置读取
  agents/                    终端内多 agent session 管理
  runtime/                   RewindCheckpointManager、ToolLogController、uiBridge
  session/                   SessionController，会话保存/恢复编排
  plugins/                   内置插件：commands、mcp、runtime message queue
packages/                    可复用包，详见 packages/README.md
  mica-agent                 provider adapter、agent 抽象、prompt 构建
  mica-tools                 内置工具、工具 registry、MCP 工具接入
  mica-mcp                   MCP 配置读取、server 连接管理
  mica-ui                    Ink 终端 UI 组件和状态 store
  mica-runtime               runtime 协议、事件、状态、输入、消息队列
  mica-session               会话快照本地保存、读取和列表
  mica-config                本地配置、storage、模型列表、模型规则、runtime env
  mica-commands              通用斜杠命令注册与分发
  mica-builtin-commands      Mica Code 内置产品命令
  mica-context               上下文管理，当前主要是 compact
  mica-skills                用户 skills 扫描、解析和缓存
  mica-plugin                插件生命周期、hooks 和 service container
  mica-common                跨包共享底层工具
  mica-logger                运行时日志 store 和格式化工具
  @anthropic/ink             Ink fork（终端 React 渲染）
scripts/                     构建、安装和 release installer 脚本
docs/                        设计草案和长期能力规划
blogs/                       开发过程记录
skills/                      仓库内示例/内置 skill 资料
temp/                        临时外部/实验代码目录，不属于默认源码和验证范围
```

## 运行时架构

- `Application`（`src/app/Application.ts`）是唯一应用入口，负责创建 `AgentRuntime`、`SessionController`、`LocalRuntimeController`、`MicaUiRuntimeBridge`、`CommandRegistry`、`HookRegistry`、`ServiceContainer`、`PluginManager` 和 `TerminalAgentSessionManager`。
- `ApplicationContext` 通过 `src/app/activeContext.ts` 暴露 `setActiveContext`、`getActiveContext`、`clearActiveContext`。插件、runtime 和命令服务不要反向 import `Application.ts` 获取全局状态。
- 插件注册发生在 `Application.start()` 内：先 `useBuiltinPlugins(...)` 注册内置插件，再 `plugins.setupAll(...)` 初始化。
- `AgentRuntime` 持有 provider client 生命周期和模型 run loop；协议消息结构、history normalizer、usage 归一化和请求参数转换留在 `packages/mica-agent/providers/`。
- `LocalRuntimeController` 负责任务提交、命令分发、turn loop、UI 协调、per-agent queue、exclusive task、rewind checkpoint、retry 和中止处理。
- `MicaUiRuntimeBridge` 监听 agent/runtime/session 状态并同步到 `mica-ui` store；`mica-ui` 不直接调用 provider 或持有 agent 运行逻辑。
- 运行中输入通过 `MessageQueueService` 管理；message queue 插件决定哪些输入可在 turn 运行期间排队。

## Provider、配置与本地数据

- 静态 provider 配置保存在 `~/.mica/config.json`，由 `packages/mica-config` 统一读写、校验和迁移。
- 本地状态保存在 `~/.mica/storage.json`，包括按精确当前目录记录的最后使用 provider/model/effort/contextWindowSize，以及共享输入框历史等数据。
- 会话数据由 `packages/mica-session` 管理，默认目录为 `~/.mica/sessions`；`SessionController` 负责把 `AgentRuntime` 序列化为 version 1 的 `PersistedSession`。
- 入口 `src/index.ts` 会加载当前工作目录的 `.env` 和 `packages/mica-agent/.env`。
- Provider 通过 `protocol` 显式选择 `openai_chat_completions`、`openai_responses` 或 `anthropic_messages`；缺省按 `openai_chat_completions` 处理，不要根据 `api_base` 猜测协议。
- 配置了 `get_model_url` 的 provider 在运行时拉取模型列表，只缓存到内存配置，不回填 `models` 到 `config.json`。没有动态模型接口的 provider 可以配置静态 `models`。
- 模型能力由 `packages/mica-config/model-rules.json` 建模：按模型名小写后是否包含 `modelKeysIncludes` 任一项匹配；全局 effort 枚举为 `none/minimal/low/medium/high/xhigh`；规则可用 `enableEffort: false` 禁用 effort；未命中规则时只支持 `none`，context size 默认 256K。
- 请求参数必须通过 `resolveChatCompletionsEffortParams` 或 `resolveResponsesReasoningParams` 在具体协议 client 内生成，runtime 不直接拼 provider 请求参数。
- runtime env 参数由 `packages/mica-config/runtimeEnv.ts` 读取，只影响当前进程 UI 节流、日志展示和文本截断策略，不写入配置文件。

## 命令系统

- 通用命令机制放在 `packages/mica-commands`，产品命令放在 `packages/mica-builtin-commands`。
- `src/plugins/commands/index.ts` 负责把内置命令注册到 `CommandRegistry`，并同步到 UI quick commands。
- 命令实现不要直接依赖应用层单例；需要的 runtime、session、agent、UI、MCP、日志等能力通过 `services` 或 active proxy 注入。
- 耗时且会修改上下文、文件或配置的命令应通过 runtime exclusive task 执行，避免用户并发发送对话或切换状态。
- 当前内置命令包括：`clear`、`resume`、`provider`、`model`、`effort`、`status`、`context`、`doctor`、`compact`、`new`、`fork`、`agents`、`rewind`、`mcp`、`skills`、`log`、`copy`、`rename`、`git-diff-context`、`git-diff-context-current`、`commit`、`exit`。

## 工具、MCP 与 Skills

- `packages/mica-tools` 是唯一工具 registry。内置工具和 MCP 工具都必须通过 registry 暴露给模型和 runtime。
- 新增工具优先继承 `MicaTool`，提供参数 schema、执行逻辑、展示文案和错误格式化；文件、shell、网络类工具必须保留边界检查和输出限制。
- shell 工具的前后台执行流程、cwd 校验、输出截断、后台任务读取和终止逻辑保留在 `packages/mica-tools` 内相邻模块，不分散到应用层。
- MCP 生命周期由 `packages/mica-mcp` 管理：读取配置、连接 server、注册远端 tools、重连或关闭时清理对应工具。
- `web_search` 使用 `serperApiKey` 或 `SERPER_API_KEY`；`web_fetch` 负责 URL 抓取和 HTML 转 Markdown。
- `packages/mica-skills` 只负责扫描、解析和缓存 skills，不执行 skill 内容；默认扫描 `~/.mica/skills`，每个 skill 目录包含 `SKILL.md`。

## 多 Agent、Session、Rewind 与 Compact

- `TerminalAgentSessionManager` 管理同一终端内的多个 agent session。`/new` 创建独立 agent，`/fork` 基于当前历史创建分叉 agent。
- 主 runtime 需要维护 per-agent queue、response buffer、session controller 和运行状态，切换 agent 时同步 UI snapshot。
- `RewindCheckpointManager` 在 turn 前捕获对话和文件状态；`/rewind` 只回退到明确 checkpoint，不做模糊历史重写。
- `packages/mica-context` 提供 `CompactionService`。压缩结果通过 runtime/session 层接入对话，不应让 provider adapter 直接感知 compact 策略。
- abort 后如已有可用的部分回复，需要通过 `AgentRuntime.preserveAbortedTurn(...)` 决定是否写回会话，并裁剪被中止 run 的 usage 记录。

## Import 与代码约定

- 根 tsconfig 配置了 `@packages/*` alias，映射到 `./packages/*`。`src/` 中引用 package 统一使用 `@packages/<name>/index.js`，除非需要访问该 package 明确公开的相邻模块。
- 每个 package 通过 `index.ts` 暴露公共 API，应用层优先从 `index.ts` 引用。
- 不使用动态 import。
- import 路径风格保持与所在文件周边一致。
- 新增公共能力时同步更新对应 package README 和导出入口。
- 不把应用装配逻辑塞进 package；如果底层包需要上层能力，优先通过类型、回调、service 或 adapter 注入。
- 代码注释保持克制，只在复杂流程前留下能减少阅读成本的说明。

## 包依赖边界

- `mica-common` 不依赖任何产品业务包。
- `mica-agent` 不依赖 UI、session、commands 或应用入口。
- `mica-ui` 不直接调用模型 provider，不持有 agent 运行逻辑。
- `mica-runtime` 只定义协议和状态原语，不做具体 turn loop 编排。
- `mica-commands` 只放通用命令机制，产品命令放在 `mica-builtin-commands`。
- `mica-builtin-commands` 通过 services 注入外部能力，避免直接导入应用层单例。
- `mica-tools` 统一管理工具定义和执行，MCP 工具也必须通过它注册。
- `mica-session` 只负责持久化，不调用模型、不渲染 UI。
- `mica-plugin` 只提供插件机制，不内置具体产品插件。

## 测试与验证

项目测试使用 Vitest，测试文件与源码放在同一目录，命名为 `*.test.ts` 或 `*.test.tsx`。常用运行方式：

```bash
bun run test
bun test packages/mica-agent/prompt/index.test.ts
bun test src/runtime/RewindCheckpointManager.test.ts packages/mica-tools/MicaTool.test.ts
```

不要直接运行裸 `bun test`。Bun 会递归发现仓库下所有测试文件，而根目录 `temp/` 可能包含外部项目、临时代码或缺依赖代码，会导致无关失败、超时或长时间扫描。扩大验证范围时显式指定 `src/`、`packages/`、`scripts/`、`docs/` 等白名单路径。

当前重点测试文件包括：

- `packages/mica-agent/prompt/index.test.ts`
- `packages/mica-agent/providers/createModelClient.test.ts`
- `packages/mica-builtin-commands/configSwitch.test.ts`
- `packages/mica-builtin-commands/gitDiffContext.test.ts`
- `packages/mica-builtin-commands/log.test.ts`
- `packages/mica-config/config.test.ts`
- `packages/mica-config/micaStorage.test.ts`
- `packages/mica-config/runtimeEnv.test.ts`
- `packages/mica-skills/loadSkills.test.ts`
- `packages/mica-tools/MicaTool.test.ts`
- `packages/mica-tools/ToolApplyPatch.test.ts`
- `packages/mica-tools/ToolRunShell.test.ts`
- `packages/mica-ui/agentTurnLogItems.test.ts`
- `packages/mica-ui/app/StartupBanner.test.ts`
- `packages/mica-ui/bottom/dropdown/quickCommandHandler.test.ts`
- `packages/mica-ui/utils/workingStatusDisplay.test.ts`
- `src/agent/AgentRuntime.test.ts`
- `src/app/adapters/MicaUiRuntimeBridge.test.ts`
- `src/plugins/runtime/messageQueuePlugin.test.ts`
- `src/runtime/RewindCheckpointManager.test.ts`
- `src/session/SessionController.test.ts`

修改 packages 后至少运行：

```bash
bunx tsc --noEmit
```

改动涉及 prompt 时至少运行：

```bash
bun test packages/mica-agent/prompt/index.test.ts
```

## 命令范围与临时目录

- 根目录 `temp/` 是临时目录，已被 git 忽略，不是本项目源码、测试、格式化、构建或搜索默认范围。
- 后续 agent/开发者执行会递归扫描的命令时，必须避开 `temp/`：优先使用项目脚本，或显式传入 `src/`、`packages/`、`scripts/`、`docs/`、`blogs/` 等目标路径。
- 如果必须手写递归命令，使用白名单路径或排除规则，例如 `rg --glob '!temp/**' ...`。只有用户明确要求检查 `temp/` 时才进入该目录。
- `.backups/` 目录是临时备份痕迹，不应作为默认实现或验证输入。

## 构建与发布

- `bun run build` 先执行 typecheck，再通过 `scripts/build.mjs` 调用 `bun build --compile`，默认输出 `dist/mica`。
- `scripts/install.mjs` 是本地安装脚本，默认安装为 `$HOME/.local/bin/mica`；可用 `MICA_INSTALL_DIR` 和 `MICA_BIN_NAME` 覆盖。
- `.github/workflows/build-binaries.yml` 在 push、PR 和手动触发时运行 typecheck/test；推送 `v*` tag 时构建 Linux/macOS x64/arm64 release 二进制，打包进自包含 `install.sh` 并上传 release asset。
- `scripts/install.sh` 是 release installer 模板，默认把对应平台二进制安装为 `mica-code`。

## 维护要求

- 如果一次改动涉及项目整体架构、目录结构、关键运行链路、公共 package 边界、配置/数据位置、常用命令或开发约束变化，必须同步修改本 `AGENT.md`。
- 如果新增长期模块、核心服务、命令体系、runtime 生命周期、session 存储格式、工具注册方式、UI 状态模型或本地数据格式，也必须更新本文件中的对应章节。
- 如果新增或删除用户可见命令，同步更新根 `README.md` 的常用命令和 `packages/mica-builtin-commands/README.md`。
- 如果新增 package 或改变 package 依赖边界，同步更新 `packages/README.md` 与对应 package README。
- 不要为了兼容旧架构保留双路径实现；影响旧数据或旧架构时，明确迁移边界后一次性切到新写法。
- runtime 级公共结果类型优先放在 `packages/mica-runtime`；例如 rewind 预览/应用结果类型由 `packages/mica-runtime/Rewind.ts` 导出，命令包只消费或 re-export。
