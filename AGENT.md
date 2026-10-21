# Mica Code Agent 手册

本文件由 `packages/mica-agent/prompt/index.ts` 注入系统提示词的 `<project-instructions>`。
优先级低于系统、开发者和当前用户指令；与代码不一致时以代码为准，并在同次变更中修正文档。
只记录稳定约束、职责边界、关键运行链路和验证方式，避免重复实现细节与修复流水账。

## 1. 工作约定

- 修改前查看 `git status --short`，保留用户已有改动；涉及已修改文件时先阅读再合并。
- 只改任务相关内容，不顺手格式化、重命名或重构；不使用 `git reset --hard`、`git checkout --`、强推、批量删除或 `--no-verify`。
- 不自动 commit、push、建分支或开 PR。
- 搜索优先 `rg` / `rg --files`，默认排除 `temp/`、`.backups/`、`node_modules/`、`dist/`；仅在用户明确要求时进入这些目录。
- 测试与临时复现使用隔离的 `MICA_HOME`，不污染真实用户数据。
- 改动影响本文件中的架构、路径、命令、配置、协议、状态或流程时，同步更新对应章节。
- 用户可见命令同步检查根 `README.md`、`packages/mica-builtin-commands/README.md`；公共 API 同步检查 `packages/README.md` 和对应包的 README。
- prompt、skills、工具描述、联网策略和项目指令加载会影响 agent 行为与 prompt cache 前缀，修改时保持稳定前缀。

## 2. 项目与常用命令

Mica Code 是基于 Bun、TypeScript、React、Ink 的终端 code agent，要求 Node >=22。
`apps/cli/src` 负责应用装配，稳定领域能力优先放入 `packages/*`。
会话历史偏向 append-only，compact 只在明确边界执行；UI 保持紧凑、键盘优先。

### CLI（仓库根目录）

```bash
bun install
bun run dev
bun run typecheck
bun run test -- <测试文件>  # Vitest；根项目不要用 bun test
bun run build             # typecheck → 单二进制编译 → 安装本地入口
bun run format            # 全仓格式化；局部任务只格式化改动文件
```

### Desktop（`apps/desktop/`）

```bash
npm install
npm run dev               # 构建运行时后启动 Electron + Vite
npm test                  # 此项目使用 bun test，覆盖 host / renderer / main
npx eslint src/
npm run build             # Electron 外壳 + Web 运行时
npm run start:web         # 运行已构建的 Web 运行时
npm run serve:web         # 构建后运行 Web 运行时
```

验证 host 改动时使用独立端口，例如 `MICA_DESKTOP_PORT=8899 npm run dev`。
外壳会复用默认端口上已有的运行时，窗口可能因此连到旧代码。

## 3. 目录与依赖边界

### 应用

| 路径               | 职责                                          |
| ------------------ | --------------------------------------------- |
| `apps/cli/`        | CLI 装配、turn loop、headless、app-server     |
| `apps/desktop/`    | Web 运行时、renderer、Electron 容器           |
| `apps/config-web/` | 配置页浏览器宿主：Bun HTTP 服务与内嵌静态资源 |
| `apps/website/`    | Astro 官网                                    |

### 公共包

以下包均位于 `packages/`。

| 包                            | 职责与限制                                                               |
| ----------------------------- | ------------------------------------------------------------------------ |
| `mica-agent`                  | agent、provider adapter、prompt；不依赖 UI、session、commands 或应用入口 |
| `mica-runtime`                | runtime 协议、事件、状态、队列原语；不编排 turn loop                     |
| `mica-tools`                  | 唯一工具 registry，接入内置工具与 MCP                                    |
| `mica-mcp`                    | MCP server 生命周期                                                      |
| `mica-ui`                     | Ink 组件与状态 store；不调用 provider                                    |
| `mica-session`                | 会话快照持久化                                                           |
| `mica-config`                 | 配置、本地状态、模型规则、品牌路径                                       |
| `mica-context`                | compact；不直接操纵 provider adapter                                     |
| `mica-commands`               | 通用命令机制                                                             |
| `mica-builtin-commands`       | 产品命令、运行期插件、启动扩展                                           |
| `mica-skills` / `mica-plugin` | skills 扫描解析缓存 / 插件机制                                           |
| `mica-common`                 | 跨端纯逻辑，如 loop 参数、引用、消息定位、自动链接                       |
| `mica-pty`                    | PTY 驱动与 Node helper；native binding 只在 Node 子进程加载              |
| `mica-web-shared`             | desktop renderer / 运行时共享的展示、状态、搜索、地址约定                |
| `mica-file-mentions`          | CLI / desktop 共用的文件补全触发、扫描、排序、插入逻辑                   |
| `mica-config-ui`              | 配置页唯一实现：页面、服务端数据动作、共享类型                           |

- 公共 API 从包的 `index.ts` 导出，应用层优先使用 `@packages/<name>/index.js`。
- 根 tsconfig 提供 `@packages/*`、`@apps/*` alias；package 不得反向依赖 `@apps/*`。
- 底层需要上层能力时，通过类型、回调、service、hook 或 adapter 注入。
- `mica-builtin-commands/plugins` 经 `PluginContext` 接入，不反向 import 应用 `src/**`。
- TypeScript 使用 strict、isolatedModules、verbatimModuleSyntax，类型导入用 `import type`。
- 默认静态导入；进程模式分派、PTY 首次加载和 renderer 重模块按需加载可使用动态 import。
- **生产代码禁止静态 import `node-pty` 或 `mica-pty/index.js`**；保持 native binding external，Bun 编译二进制无法解析它。

## 4. CLI 启动与活动上下文

启动顺序：

1. `apps/cli/src/app/configWebWorker.ts` 优先分派 Config Web worker。
2. `apps/cli/src/index.ts` 在加载 config/runtime 前分派 version、models、exec、commit、compact 与交互模式；`startup/validate-config.js` 补齐兼容默认值。
3. `Application.start()` 启动 Ink → 完整配置校验 → 必要时选择初始模型（仅动态 provider 且顶层 model 为空）。
4. 创建 runtime、session、registry、hooks、services、agent/session manager、UI bridge 和 subagent manager；通过 `micaTools.registerRuntime(new ToolAgent(...))` 注册工具上下文。
5. 设置 active context → 注册内置插件 → 用户插件 `setupAll` 并写 `plugin-status.json` → 启动 UI bridge 与 runtime。

失败时显示配置修复提示、注销 runtime、清理插件与 session，设置 `process.exitCode = 1`。
插件 setup 中 `ctx.onDispose()` 登记的资源须逆序回滚；新增 capability 同步登记 disposer。

- `apps/cli/src/app/activeContext.ts` 是应用上下文的唯一全局入口，底层不得 import `Application.ts` 取状态。
- 多 agent 命令使用 `createActiveAgentProxy` / `createActiveSessionControllerProxy`，不固定构造时的 agent。
- provider/model/effort/role 切换先 busy guard、同步当前配置，再开选择器；完成后 `reloadConfig(false)`、保存 session、同步 UI。
- role 切换重建 client 并保留历史。非空会话跨协议切换由 `applyConfigSwitchUpdate` 阻止；恢复旧会话协议不匹配时降级恢复 model/effort，不静默丢历史。

## 5. Turn、队列与持久化

### 执行顺序

`LocalRuntimeController.submit()` 先 trim 并解析命令，再经 `input:received` guard hook 处理普通输入。
未被处理的输入进入 turn：保存 `running` → 每次工具迭代保存 checkpoint → 成功保存 assistant 消息与 `completed`；失败/中止保存 `error` / `aborted`。
非 completed 会话在 `/resume` 标为 `（uncompleted）`。

- UI 对话以 `TerminalAgentSession.uiState.conversationMessages` 为准，不从 provider history 临时推断。
- turn 启动即保存本轮用户输入；headless 只对 `input.source === 'ui'` 写入。后续 checkpoint 不得重复追加。
- **每个写 session 的 turn 都必须持有 turn lease**，在 `refreshFromStore()` 前获取，拿不到就拒绝；`save: false` 的一次性任务例外。
- **lease 必须在 `turn:after` 前释放**，finally 保留幂等兜底，否则插件提交下一轮会被自己的旧锁挡住。

### 单槽队列

- `MessageQueueService` 的操作必须带 owner；pending input 只放 `pendingInputs`，不提前追加对话或 provider history。
- TUI 与 desktop 的 Enter / Tab / Shift+Tab 统一使用 `after_iteration`，在完整工具迭代边界注入当前 turn。
- 当前 turn 无后续迭代时，由 message-queue 的 `turn:after` 兜底发送；仅 `completed` 自动发送，失败/中止保留输入供撤回。
- `after_turn` 仅供 `/loop` 等显式请求；不再为普通用户输入增加第二种排队时机。
- 两端都支持 Shift+← 撤回。desktop 的 host 槽走 `mica/queue/recall`，本地槽走本地撤回；撤回请求在 turn 运行中必须可用。

### 重试与中止

- turn 级重试最多 5 次、间隔 10s；仅当错误可重试且本轮没有非只读工具调用时自动重试，先恢复 pre-turn snapshot。
- provider 的 `withRetry` 仅在尚无文本/工具输出时重发请求（thinking 不算输出），5 次退避为 2/4/8/16/30s。
- provider 重试经 `onRetry` 透传；TUI 原地更新单条 notice，app-server 只写 stderr。
- headless 与 TUI 使用相同策略；重试清 responseBuffer，重放已消费的 after_iteration 输入，等待可被 abort 立即打断。
- `turn:retrying` 不得投影为 Codex `error`，否则 desktop 会提前结束 run。
- `AgentRuntime.abort()` 递增 runId 并中止 controller。`preserveAbortedTurn` 只补未提交的消息：两个 client 使用 `turnCommitted`，不能只比较历史末尾用户文本。
- TUI / headless 各自维护 `committedResponseBuffer`，迭代边界更新；补写只传 `uncommittedResponseText(responseBuffer, committedResponseBuffer)`。
- 两个 provider 的流迭代结束后仍须 `throwIfQueryStopped`，防止 SDK 吞掉 AbortError 后提交空 assistant 消息。

## 6. Provider、Prompt 与模型

### 协议与消息

- `createModelClient` 按 `provider.protocol` 显式选择 ChatCompletionsClient / ResponsesClient，不按 `api_base` 猜协议。
- adapter 负责 wire 参数、消息结构、history normalizer、usage 和 tool-call 转换；runtime 不直接拼请求。
- `executeProviderToolCalls` 将连续只读工具与 `Agent` 调用并发，其余写/执行工具作为串行屏障；结果按调用顺序回填，每组前后检查 abort。
- `readOnly: true` 同时允许并发与安全重试，工具必须无共享可变状态。
- 多模态工具结果：Chat Completions 先追加全部 tool 文本，再用一条 user 消息承载图片；Responses 使用原生 `function_call_output`。UI、日志、run JSON 只取文本投影，不输出 Base64。
- 运行中压缩只能通过 `rewriteIterationMessages` 改写 provider loop 的本地数组；`loadSnapshot` 不会改变在途请求。钩子输入不含 system prompt，Chat Completions 重写后须补回 system；改动同步 `iterationRewrite.test.ts`。
- 无视觉模型经 `stripImagesForVision` 将发送副本的图片换成 `imageOmittedPlaceholder`；持久化历史保留原图。`supportsVision` metadata 缺失时默认 true。
- 两种运行模式的 `[Image](路径)` 都先经 `parseImageRefs` 转成多模态块；headless 直接导入 `mica-ui/utils/imagePaste.js`，避免引入 React/Ink。
- Responses 带 reasoning 参数时保留 `summary: 'auto'`。历史 reasoning 经 `dropReplayedReasoningItems` 从发送副本移除；不改 session / thinking 展示。

### Prompt 与角色

- `buildSystemPrompt()` 默认读取 `mica-agent/prompt/system.md`；自定义 role 只替换 `<system>`。
- cwd 的 `AGENT.md` / `AGENTS.md` 合并注入，路径按 live cwd 解析，不在模块加载时冻结。
- skills 仅以索引进入 system prompt。角色扫描 `$MICA_HOME/role/*.md`；内置 `default` 不可被同名用户文件覆盖。
- 模板品牌占位符通过 `brandTemplate.ts` 的 `applyBrandTemplate` 统一展开；未知占位符保留，不硬编码品牌名。

### 模型规则

- effort 仅 `none/low/medium/high/xhigh`；provider 可用 `supportsEffort: false` 禁止发送。切换模型时 clamp effort 并同步 context window。
- 模型未命中时使用 `mica-config/getModelRule.ts` 的通用规则：context 1M、effort medium、全 effort、supportsVision true。
- metadata 优先级：磁盘缓存（24h）→ 内置 models.dev 种子 → 在线刷新（≤15s）。降级写 stderr、进程内去重；后台刷新透传 signal。
- 只有 `get_model_url` 动态 provider 查询模型列表，结果不写回 config.json。
- 交互/headless 先注册 model-effort-context resolver，再 `ensureModelRule`；headless metadata 失败使用通用规则，不污染协议 stdout。

## 7. 配置与会话存储

### 配置入口

- `packages/mica-config` 是配置和本地状态的唯一入口，UI / commands / runtime / adapter 不自行读写路径。
- `MICA_HOME` 覆盖全部用户路径；否则经 `brand.ts` 的 `resolveMicaHome` / `resolveMicaHomePath` 使用品牌目录，默认 `~/.mica`。
- `PersistedMicaConfig` 只存静态字段；运行时 provider/model/effort/contextWindowSize 经 `stripRuntimeFields` 去除。
- 配置迁移与语义校验统一在 `startup/validate-config.js`，配置 Web 保存复用它。
- 仅当磁盘所有 provider 都没有 api_key 时，`envProvider.ts` 从 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 合成运行时 provider；默认协议 `openai_responses`，可由 `MICA_PROVIDER_PROTOCOL` 覆盖。
- 环境合成 provider 经 `isEnvOnlyProvider` 过滤，永不写回 config.json；改动同步 `envProvider.test.ts` 与 exec 环境认证用例。

### 快照与用量

- session 是 version 1 JSON，包含 id、title、时间、cwd、snapshot；新增字段要有版本策略、默认值和 sanitize/parse。
- `subagentUsageHistory` 独立于主 `usageHistory`，保持 rewind 裁剪语义。
- compact 保留 `lastUsage` / `usageHistory` 供 Stats 对账；界面 ctx 优先读 `displayUsage`，下一次较新的真实请求后失效。
- fork 清空两类 usageHistory，只保留描述继承上下文的 `lastUsage`。旧会话用量副本由 `usageIdentity` / `filterOwnedUsage` 统一归属，列表与详情保持一致。
- 无手动标题时取最后一条真实用户消息，最长 60 字符；跳过 compact 元数据与 `displayContent` 不同于 content 的插件注入消息。

### 索引、并发与删除

- `$MICA_HOME/session-index.json` 是可重建缓存，不能放进 `sessions/`。save/delete 合并磁盘最新索引，避免跨进程覆盖；读取发现 id 集合不一致时重建并立即持久化。
- 垃圾占位须同时满足：默认占位标题、无对话、无 usage；`turnState === 'running'` 永不作为垃圾隐藏或删除。
- `saveCurrent` 签名冲突时以内存快照降级写盘并递增 revision，不永久跳过；文件已被删时清签名并重新写盘。
- `sessions/.turn-locks/<id>.lock` 是跨进程写入的唯一事实来源，使用 `wx` 文件锁与 owner pid 存活判定；孤儿锁在 acquire 时回收，delete 同步清锁。pid 复用是已知边界。
- desktop 删除会话须同时清理 pins、projects、sort、loops、BTW 等关联状态；本进程正在跑或有活 lease 时拒绝删除。

## 8. Headless 与 app-server

### HeadlessTurnExecutor

- 核心在 `apps/cli/src/runtime/HeadlessTurnExecutor.ts`，不触碰 Ink/UI。
- 每轮顺序为取 lease → `refreshFromStore()` → `reserveRunId()`；每轮都发 `turn:finish`，结果仅 completed/aborted/error。
- 排队轮次同样逐轮取 lease；失败也要有完整 started/completed 通知。`start()` 取锁失败返回 `busy-remote`，客户端回滚乐观消息并恢复草稿。
- `HeadlessPluginHost` 是 exec / app-server 共用的插件装配层；新增适用插件须同步注册。MCP 显式初始化，输入框、命令 UI、用户文件插件不注册。
- `attachPluginLayer()` 同步替换 executor queue，避免插件写入与 loop 读取不同实例。

### 协议与请求

- `mica app-server` 是每会话常驻进程，不改为全局 daemon；stdin / stdout 使用 Codex v2 JSONL。
- framing 在 `mica-runtime/codexProtocol.ts`，事件投影在 `runtime/CodexProjector.ts`。每个 executor turn 都有完整 `turn/started` + `turn/completed`，turnId 由 executor 事件分配，每轮重新 attach projector。
- `mica/*` 扩展通知（queue、tasks、BTW、history、autoCompact）直接送 renderer，不进入 turn 重放缓冲。
- 撤回、任务详情/终止、改名、BTW 等辅助请求不启动主 turn，不改 `run.running` / `hostPending`；可在 turn 运行中调用。编辑重跑另有 busy guard。
- 任务记录只活在 host；详情与终止走 `mica/backgroundTasks/*`、`mica/subagentTasks/*`。运行快照不含已结束任务，详情响应仍须带最终状态与退出码。
- `turn/start` / `mica/turn/editMessage` 可传 role，由 host 在启动 turn 前应用；edit 时必须在 `loadSnapshot()` 后应用。缺失角色只 warning 并保留原角色，不为切角色重建 host。
- 改名先找常驻 host，调用 `SessionController.renameCurrent`；无 host 且无其他进程 lease 时才直接写盘，避免内存快照覆盖标题。
- resume / chdir / MCP 初始化失败降级继续；只有 resume 失败发 Codex error，其余发 warning。游离 unhandledRejection 记录并 warning，uncaughtException 发 error 后退出；退出前 flush stdout/stderr。

### 编辑重跑

- `mica/turn/editMessage` 将 provider history 截断到目标用户消息之前，再用新文本重跑；不能追加一条新消息冒充编辑。
- 定位共用 `mica-common/promptText.ts`：剥媒体占位、折叠空白，再按 `occurrenceFromEnd` 匹配；唯一匹配允许计数回退，多条匹配严格计数。
- 顺序为保存截断历史和本轮输入 → 发 `mica/sessionHistory/replaced` → `executor.start`；启动失败恢复原快照并再次通知。

### exec 兼容

- `mica exec` 默认人读文本，`--json` 为 Codex exec ThreadEvent JSONL，`--thinking` 控制 reasoning item，`--no-save` 不落盘。
- 保留 codex-family 参数兼容：`--cd`、`--enable`、`--skip-git-repo-check`、危险跳过权限别名、`-c`、`--` 和裸 prompt。
- `-c` 仅解释 reasoning effort / summary，其他键接受并忽略；minimal/max 映射为 low/xhigh，不扩大 Mica effort 枚举。
- 修改同步 `args.test.ts`；事件名与 usage 保持 Codex 形状。app-server 的 transport 参数兼容独立维护。

## 9. 命令、工具、MCP 与 Skills

### 命令

- 命令实现放 `mica-builtin-commands/commands/`；装配放 `plugins/command-*.ts`，统一从 `index.ts` 导出。
- quick commands 另由 `apps/cli/src/plugins/commands/index.ts` 注册；新增/删除时检查两条路径与 README。
- 通过 `CommandRuntimeServices` / active proxy 注入依赖；耗时且改状态、文件、配置或 git 的命令走 exclusive task。交互反馈用 `services.showNotice`。
- turn 运行中是否可执行由注册时的 `allowDuringTurn` 决定，检查 quick commands 与 `plugins/command-*.ts` 两条路径；exclusive task 期间仅 status、task、agents、new。
- `/model` / `/effort` 开 selector 前检查 busy，并保留二次 guard。完整命令清单以 builtin commands README 为准。

### 工具与 PTY

- `mica-tools` 是唯一 registry，产品工具优先经插件 `ctx.tools.register()`；新增工具继承 `MicaTool`，声明 schema、展示、错误格式与 readOnly。
- readOnly 分类受 `MicaTool.test.ts` 约束：纯查询为 true；写文件、patch、shell、kill、PTY、wait_for 为 false。
- `truncateDisplayText` 仅在 `process.stdout.columns` 存在时裁剪；app-server 管道无列宽，不按 80 列截断。
- PTY 由懒启动 Node helper `mica-pty/src/server.mjs` 承载，Bun 首次调用动态加载 `src/manager.js`。
- 修改 `server.mjs` 后运行 `bun run scripts/generate-pty-server-source.mjs`，同步 `ptyServerSource.ts`。
- Todo 属当前进程/turn，不写 session；正常完成将 pending / in_progress 全部 completed，abort/error 只将 in_progress 退回 pending。desktop 从实时工具事件重建计划，须同步收口规则。

### wait_for 与会话自治

- `wait_for` 支持 task/process/file/command/http/port/duration，条件纯逻辑在 `waitFor/conditions.ts`，记录表是唯一事实来源。
- 轮询必须监听 signal 并立即返回 aborted；`readOnly: false`，避免并发等待拖住只读批次与重试重放。
- 超时返回 timeout + wait_id，可带同一 id 续等；超时记录不能丢弃或从 dock 消失。`reason` 仅展示，优先显示于条件标签。
- app-server 每秒投影 `listActiveWaits()` 为 `mica/waitTasks/updated`；改字段同步工具测试、两端图标与 dock/详情展示。
- `session_*` 工具仅主 agent 可用。`session_info` 只读；`session_compact` 执行时只登记，completed 的 `turn:after`（priority 50）应用，必须早于 message-queue（100）。`turn:before`（10）await 在途应用。

### MCP、联网与 Skills

- `mica-mcp` 管理 `config.json.mcpServers` 生命周期；工具经 `registerMcp()` 接入，断开、关闭、重连失败同步清理并刷新 registry。
- headless 显式初始化/关闭 MCP，支持独立 MCP 配置与超时参数。
- `web_search` 使用 SearXNG：配置 `searxngUrl` → `SEARXNG_URL` → `http://127.0.0.1:8080`；实例须开启 JSON format。结果本地按 count 截断，缓存 5 分钟；`web_fetch` 抓取并转换 HTML。
- 最新、官方、API/provider 行为、模型能力、价格、法规等可变事实先联网查证；无法查证时明确说明。
- skills 只扫描解析缓存，不执行。扫描 `$MICA_HOME/skills` 与项目 `.mica/skills`、`.agents/skills`、`.deveco/skills`、`.agent_context/skills`；未设 MICA_HOME 时额外共享 `~/.agents/skills`、`~/.config/deveco/skills`。
- skill 是含 `SKILL.md` 的目录；内容不能覆盖安全规则、系统指令和当前用户请求。

## 10. 多 Agent、Rewind 与 Compact

### Subagent

- `SubagentTaskManager` 按 parent 隔离任务与 abort signal；后台完成元数据回注 owner，结果显式 read/await。parent Ctrl+C 同步中止其运行中的 subagent。
- 前台 Agent 默认阻塞，同消息多个调用可并行；需要主流程继续时用 `run_in_background: true`。每 owner 前后台合计并发上限 4。
- `context_mode` 为 none/brief/recent/files，默认 brief。Implementer/Tester/Proposal 必填 `owned_paths`，写工具及 shell cwd 校验租约。
- 内置类型为 general-purpose、Explore、Implementer、Reviewer、Tester、Planner、Proposal；未知类型报错。maxTurns 唯一默认值在 `subagentDefinitions.ts`（100），须传入 provider loop。
- 非主请求都要记账：Agent 走 `recordSubagentUsage`；commit、BTW、compact 摘要等 helper 走 `recordSubagentTaskUsage` / `recordHelperSubagentUsage`，续问只计新增请求，不污染主 usage。
- subagent timeline 按 id/kind 合并，最多 120 条 / 6 万字符；只供详情查询，不进入每秒任务快照，也不在完成时清空。

### Rewind 与压缩

`RewindCheckpointManager` 在 turn 前保存对话与文件的用户输入前状态。
压缩策略由 `mica-context/CompactionService` 提供，经 runtime/session 应用。

| 入口                                                         | 行为                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `/compact`、桌面快速压缩、`mica compact --tool-results-only` | 本地 toolResultsOnly；保留对话与轮次，不调用模型、不生成 checkpoint，可重复执行 |
| `/compact llm`、`mica compact --session`                     | 模型摘要 checkpoint，会重写历史                                                 |
| `--prune-only`、`session_compact`、loop 轮前压缩             | 本地清理，无可清理内容时可丢最早轮次                                            |

- 默认快速压缩替换工具结果与可识别媒体，按字段语义裁剪工具参数；不插入 boundary/summary，不改对话文本。
- tool-call arguments 必须始终是合法 JSON：只裁正文/长命令，保留路径、pattern、name、offset、短值；解析失败原样保留。
- 裁剪规则集中在 `CompactionService.ts`，正文/命令阈值 200/400；摘要以 `[omitted ` 标记幂等，改规则同步测试。
- 未知结构里的 url/data 不作为媒体改写。移除 Responses encrypted_content 后，整条丢弃失效 reasoning，避免 ctx 虚高。
- 所有压缩保留 usage 记账；需模型的 compact/review/commit 经 subagent 或 exclusive task，不污染运行中的主 turn。

## 11. Desktop 架构与共享状态

以下 `src/` 均指 `apps/desktop/src/`。

### 三层边界

| 层                    | 职责                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| `src/host/`           | chat、terminal、files、git、stats、配置、loop、共享状态等业务                           |
| `src/server/index.js` | 自包含 Node HTTP 运行时，托管 renderer，`POST /api/invoke` + SSE `/api/events`          |
| `src/main/index.js`   | Electron 容器：启动运行时、窗口导航、未读徽标、窗口状态；受控浏览器与终端控制是业务例外 |
| `src/renderer/`       | 页面；`transport.js` 统一实现 `window.mica` 与平台差异                                  |

- 外壳不注册通用业务 IPC，不加 preload；页面始终通过 HTTP + SSE 访问运行时。主进程只保留两个受控能力（`src/main/browser/`、`src/main/terminal/`），窗口页面同样走运行时端口。
- `electron-shim.js` 将 host 所需 Electron 接口映射为 Node 实现；平台差异收敛在 transport/shim，不散落业务组件。
- 运行时构建保持 `ssr.noExternal: true`，只 external Node 内置模块与 node-pty；asar 没有 node_modules。新增依赖后跑 `npm run build:server && npm test` 检查裸导入。
- 页面根节点必须套 `renderer/src/ErrorBoundary.jsx`：React 遇到 render 抛错会卸掉整棵树，表现为整页黑屏（只剩窗口按钮）。渲染期引用未初始化的 `const` 是常见来源，由 renderer 的 `no-use-before-define` 拦住；确有延后引用时按处豁免并写明原因。
- 外壳通过 stdin 管道管理子进程；运行时启动即 `stripContainerEnv()`，在任何 spawn 前移除 `ELECTRON_RUN_AS_NODE`。
- 受控浏览器与终端控制的 socket 只在 `will-quit` 关闭：`before-quit` 里做不可逆清理时，一旦退出被取消，进程还在但 socket 已 unlink，`/remote/*` 会永久 503。
- `resolveMicaExecutable()` 保持平台感知：Windows 不检查 POSIX 可执行位，`.exe` 优先于需 shell 的 `.cmd`。
- `desktop-process-env.js` 追加工具目录到 PATH；`shell-env.js` 采集并缓存 profile env，超时静默降级。
- `MICA_DESKTOP_USER_DATA` 与 shim 默认值解析到同一 `mica-code-app` 目录。

### 共享界面状态

- 运行时只有一份 workspace / drafts / layout / rightTerms / terminalOpenByChat / cwd / Git 偏好等状态，落盘 `userData/ui-state.json`，广播给所有页面。
- 语义在 `mica-web-shared/ui-state.ts`；新增状态加键。整键 last-write-wins，条目补丁用 `setUiStateEntries`，null 表示删除。
- 回声按键和值在 store 的 `applyRemote` 入口认领一次；组件不得各自 `claimUiStateEcho`。卸载时 flush。
- 草稿按 nodeId 订阅字符串；App 用引用稳定的 `draftMarkers`，不把整张 drafts 表读入组件渲染。
- 同一 session 在所有页面是同一 node、run、终端。`dedupeSessionNodes` 合并重复页签并优先保留运行节点；不增加跨页签认领、观察者心跳或所有权转移机制。
- 仅另一个进程由 turn lease 拦截；`remoteRunning` 显示只读提示并每 3s 复查，解锁后重拉历史。

### 路由、分享与访问

- 默认 `0.0.0.0:8787`，**运行时无认证，所有客户端拥有完整宿主能力**；README 必须保留风险说明。
- 仅一个端口：`/`、`/mica-web` 为完整应用，`/share` 为分享视图，`/terminal-control` 为终端窗口页面，`/api/*` 为能力，`/remote/control/*` 为浏览器代理，`/remote/terminal/*` 为终端代理。地址约定只用 `mica-web-shared/app-paths.ts`。
- `shareView` 仅影响呈现，不是权限边界；不新增访客授权。资源路由先 `toAssetPath()` 去前缀。
- `--share-port` 只保留兼容开关语义；`--no-share` / `MICA_DESKTOP_SHARE_PORT=0` 只关闭 `/share`。端口占用可随机回退，从 ready JSON 获取实际地址。
- `access-core.js` 校验 Origin / Host 防跨站与 DNS rebinding；同站忽略端口以支持 Vite 代理，允许代理域名通过 `MICA_DESKTOP_ALLOWED_HOSTS` 配置。
- 分享地址用 `access:info.shareBaseUrl`，按 PUBLIC_URL、当前可达地址、私网地址挑选，端口换为实际运行时端口；不以本机 `location.origin` 兜底。
- 链接形如 `/share?session=<id>`，无 token/有效期/撤销权限；复制即登记分享列表，失败如实提示。列表在 `shared-sessions.js`，无 session 参数时由 `ShareIndex` 展示。
- 当前会话写入 `?session=`（replaceState，保留其他参数）；启动待列表就绪后打开目标，首帧不抹掉参数。
- `GET /api/health` 探活；`MICA_DESKTOP_EXIT_ON_STDIN_CLOSE=1` 防孤儿进程。

### 切换服务器与外壳恢复

- 页面 origin 即当前服务器；切换前由 host 探活，再开新窗口/标签页，不加代理或跨源 API 层。
- Server 入口桌面悬停卡片、触屏内联展开；最近服务器存在当前 origin 的 localStorage（最多 8 条、探活成功才记），备注只改已有条目。
- Electron 一窗口一服务器，已打开的服务器聚焦复用；本机主窗口关闭只隐藏，不恢复上次远端服务器。
- `⇧⌘M` 由壳提供回本机能力。默认回环地址的本机判定先于探活，避免端口占用时误连另一实例。
- `watchPageBoot` 在导航完成后检测 booted/error-page/blank，空白仅有限次重载；`enterWindow` 聚焦前也检测空白并恢复，保留两条路径。

## 12. Desktop 对话与输入

### 事件流与恢复

- chat run 按 nodeId 存于 `host/chat.js`。请求级发送错误走 `chat:queue-error`，回滚乐观消息并恢复草稿。
- 队列唯一投影为 `chat-queue.js.mergeQueuedItems`：host after_iteration 在前，本地显式 after_turn 在后；所有查询、撤回、单槽判定使用同一投影。
- `turn/steer` 被接受即回 `queued`（并记进 hostPending），排队行一律可撤回：确认通知没回来的乐观行（`pending`）也走同一入口。撤回前先发 `mica/queue/hold` 冻结该条（迭代边界不再注入，用户正在重新编辑的文本不会被发出），失败则解冻；结果由 `chat-recall.js.resolveQueueRecall` 判定为「回输入框 / 已开始发送 / 保留」。`hostPending` 只由 `mica/queue/*` 改写，不在 turn 结束时清空。
- `commandExecution.command` 按第一个空格切成 name + JSON，不能压缩 JSON 内的空白。
- `run.events` / `run.prompt` 每轮重置；恢复先用 `historyBeforeRunReplay` 裁掉本轮已保存回答再重放。
- host 主动启动的轮次发 `chat:run-started` 补用户行；按 clientMessageId 和末尾未回答的同文行去重，不能全局按文本去重。
- 每次模型请求后立即转发 usage；tokens/cached/ctx 取 `tokenUsage.last`。实时 usage 不改 turnState / updatedAt，避免误判完成。
- 阶段文案与计时都读 `statusLinePhase`；工具结束后回到 connecting。
- `ChatView` 保留最近 5 个实例，运行/锁定/活跃节点不淘汰；DOM 渲染顺序固定为 workspace 顺序，避免移动节点清 scrollTop。
- 按 nodeId 保存滚动位置与贴底意图；隐藏时忽略 clientHeight=0 的滚动事件，重建后恢复。

### 输入、补全与编辑

- CLI / desktop 共用 `mica-file-mentions`，候选最多 20；desktop 不二次排序截断。host 预热 cwd，查询防抖 100ms，空查询立即。
- `@` 和 desktop `/` skill 补全仅在词首触发；斜杠后再次出现 `/` 按路径处理。选中只插文本，不执行。
- skill 候选不截断（host 上限 200），名称与说明都参与匹配与高亮；浮层只让候选列表滚动，标题行固定。
- desktop composer 不分派斜杠命令，`/loop` 等原样发给模型；需 UI 的能力通过面板操作。
- 输入历史只由 Alt+↑/↓（CLI 另支持 Ctrl+P/N）翻，普通方向键移动光标。
- `TerminalComposer` 容器与 textarea 的 min/max height 共用变量，markdown layer 与自绘光标镜像同一 scrollTop。
- 主对话区查找按 Cmd/Ctrl+F（`ChatFind.jsx`，交互照 VS Code 的 find widget）：命中只用 CSS Custom Highlight API 上色，不往 React 管的 DOM 里包节点；匹配规则（大小写/全字/正则、上限与 `n/总数`）在 `chat-find.js`，流式变化由 MutationObserver 防抖补扫。
- 输入法组合期用 `resolveComposerSelection` 取 selectionEnd 并收起选区；blur 清组合态，不在组合期从外部 setInput。
- 粘贴共用 `composer-paste.js`：图片字节转 `[Image](路径)`，文件插绝对路径；系统路径由 `clipboard:file-paths` 按 basename/顺序对齐，失败提示，不插错误文件路径。
- 角色入口在输入条箭头，非 default 显示角色名，随下一次发送/编辑的 role 参数持久化。
- 双击用户消息就地编辑，仅空闲且非空时提交；经 `chat:edit-message` 调截断重跑，失败保留编辑文本并 notice。
- 引用按钮经 `mica-common/chatQuote.ts` 插入围栏文本，展示从草稿反推，删除只删对应块，发送与存储不设特殊协议。

### 展示与面板

- 主文本共用 `--chat-text-size`；用户块与回答保留不同底色、前景与轮次间距。消息标记贴首行，复制/引用按钮绝对定位，不撑高单行消息。
- **自动链接与全角标点**：唯一规则在 `mica-common/autolink.ts.splitAutolinkPunctuation`，自动链接在首个全角标点处截断且校验显示文本，显式 Markdown 链接原样保留。
  desktop 的 `remarkAutolinkPunctuation` 放在 `remarkGfm` / `remarkPathLinks` 前；CLI 用 `splitTerminalLink`。新增标点只改共享集合，同步两端测试。
- 路径识别在 `chat-paths.js` / `PathToken`：单击目录打开、文件定位，Cmd/Ctrl 或中键在应用内打开，图片单击预览；失败 notice，缺 context 时纯文本。
- 工具日志完整折行，输出可展开并封顶 5000 行 / 20 万字符；`TurnLogItem` memo，计时更新仅影响运行行。
- 模型/loop 面板统一用 `Popover`，同一尺寸、锚点、关闭逻辑；触发器带对应 `data-popover-trigger`，body 为唯一滚动层。
- 电脑隐藏发送/排队按钮，移动端保留；停止只用 danger、排队只用 warn，上传保持中性。loop 徽标自带 tick，不在 ChatView 或侧栏全树计时。
- 后台任务/子代理 dock 仅列运行项，详情通过 host 查询，结束后保留最终结果；查询/终止不改变 turn 生命周期，终止后台任务须确认。

## 13. Desktop 专项能力

### 定时循环

- CLI / desktop 共用 `mica-common/loopArgs.ts`：省略间隔默认 30 分钟，支持复合单位、秒与纯数字秒；最短 10 秒，最长一周，越界拒绝。
- CLI `LoopController` 只活在 TUI 进程；插件注册 loop 状态/修改/停止工具，仅主 agent 且 owner 匹配可操作。
- CLI 每轮前 prune-only，失败提示但不中断，经 after_turn 提交；停止移除 system prompt loop 指引。
- desktop `host/loop-state.js` 为纯模型，`host/loops.js` 持久化 `userData/loops.json`，单定时器调度；不在页面 setInterval 重造。
- 按 nodeId 归属，首轮拿到 sessionId 后绑定；启动即跑，忙时 skip 不计执行次数，重启仅追赶一轮。
- 循环不改变 Pinned/Projects/Recent 归属；控制面只有输入条时钟面板，侧栏显示时钟与进度。

### 自动压缩

- 设置和按 sessionId 计数由运行时 `host/auto-compact.js` 持有，落盘 `userData/auto-compact.json`，配置页是唯一设置入口。
- desktop 每轮经 turn/start / editMessage 下发设置与计数，app-server 执行并回推；计数只由 host 报，宿主不再次累加。
- 未收到 autoCompact 参数的 exec / Codex driver 不自动压缩。
- 每次完整请求按 usageId 去重，先快速、仍超阈值再模型；同次升级算一次触发。默认快速 200k/3 次、模型 120k/3 次、间隔 20 分钟，安全下限 150k/100k。
- 失败只记 note，不中断 turn；只改发给模型的历史，不改 conversationMessages。状态通知不进 turn 缓冲，不碰运行态。

### By The Way

- 共用纯逻辑 `mica-builtin-commands/commands/btwThread.ts`；headless 不导入 builtin commands 总出口，避免经 `btw.ts` 引入 Ink/React。CLI `/btw` 不挂流式回调。
- desktop `BtwThreadController` 接受请求立即 ack，结果通过 `mica/btw/updated` 流式快照推送，不堵塞 interrupt / steer / recall。
- 同线程单子代理串行回答，允许一条排队与撤回；不同线程可并行。停止仅中止当前问答，保留部分回答与后续队列，用量单独记账。
- 线程落盘 `$MICA_HOME/btw/<sessionId>.json`，共享路径在 `mica-common/btwState.ts`；存 entries + 子代理 messages，去媒体，context 重开后重新计算。
- 历史会话无 host 时读盘恢复，提问/压缩按需起 host；主 turn 运行中仍可用，仅无 sessionId / remoteRunning 禁用。
- 快照每 80ms 合并且有界：正文 200k、思考尾部 20k、工具输出 4k、每回答 20 工具、线程 20 条；下一问清上一问的思考/工具字段。
- 面板为右侧并排抽屉，移动端全屏；只由关闭按钮、Esc、触发按钮关闭。复用 TerminalComposer、图片粘贴与工具行组件，保持独立右键菜单和滚动贴底意图。
- BTW 不进入主对话上下文、不占主队列、不改 run 生命周期；侧栏通过 host 推送显示 BTW 运行态。

### 受控浏览器

- 唯一主进程业务例外在 `src/main/browser/`；`browser-docs.js` 是端点唯一目录，路由、文档和技能引用同源。
- 主进程通过 Unix socket 提供服务，`MICA_BROWSER_SOCKET` 交运行时桥；agent 访问本运行时 `/remote/control`，不另开 TCP 服务。
- `browserOwnerEnv()` 注入 `MICA_BROWSER_OWNER` / `MICA_BROWSER_URL`，owner 唯一决定会话归属；纯 Web 宿主无服务时正常降级。
- 窗口默认隐藏，关窗只 hide，销毁须专用 close API；同一 `persist:mica-browser` 分区共享持久 Cookie，权限拒绝，window.open 转同窗新标签。
- 截图用 CDP `Page.captureScreenshot`。依赖显示面的操作（截图、click、type、keys、scroll）统一走 `withShownWindow`：先 `showInactive` 露出窗口、必要时挂上目标标签页并等首帧，做完按原状态 hide/minimize 复原（不抢焦点、不改 `visible` 状态）。隐藏窗口原生输入会被丢弃、合成器不出帧，因此合成事件路径只作为恢复不了显示面时的兜底，via 报告实际走的那条。
- `app.whenReady()` 前设置 `disable-backgrounding-occluded-windows` 保持隐藏窗口 rAF/可见性；进程级开关 `MICA_BROWSER_UNTHROTTLE=0` 可关闭。
- 服务保持 Origin/Host 守卫，无 CORS，非 GET 要求 JSON；Cookie 导出文件 0600，写失败只报告。
- 顶栏图标显示/隐藏窗口，销毁二次确认；未归属窗口变暗显示。Browser Control 设置页永远可打开，无能力时给说明，仅展示文档入口，不管理窗口。
- 生成的 `$MICA_HOME/skills/mica-browser/SKILL.md` 仅含服务地址，启动会覆盖；改端点文档只改 `browser-docs.js`。

### 终端控制

- 第二个主进程业务例外在 `src/main/terminal/`：`node-pty` 打开真实 pty 与登录 shell，`@xterm/headless` 只做屏幕镜像供 AI 读屏，**不是模拟终端**。`terminal-docs.js` 是端点唯一目录。
- 主进程只监听 Unix socket（`MICA_TERMINAL_SOCKET`），运行时把它代理成 `/remote/terminal/*`，剥掉整个前缀后端点就是 `/sessions`、`/events` 等；`MICA_TERMINAL_URL` 即该服务根，agent 拼 `/sessions`。socket 变量不进 chat 子进程，避免绕过代理。
- 两个主进程服务统一用 `shared/endpoint-http.js` 的 `listenLocalSocket` 绑定：先探活，有人监听就报「已被另一个实例占用」而不删文件（同一个 userData 起第二个实例时，删掉等于让第一个实例变成「进程在、文件没了」）；只有无人在监听的残留文件才清掉重绑。服务与技术站关闭放在 `will-quit`，`before-quit` 只做可逆清理。
- 一个会话一个后台窗口，按需创建：`show` 为假时不建渲染进程，agent 专用终端不占内存；关窗只 hide，销毁走 `close` API。窗口加载运行时托管的 `/terminal-control?session=<id>`，页面与 AI 都通过 HTTP + SSE 操作同一条 PTY，不需要 preload。
- 页面用 xterm DOM 渲染（不用 canvas）；PTY 尺寸是唯一事实来源，AI resize 后页面跟随，用户调整窗口才反向 fit 并回报。页面隐藏时只记 `hiddenDirty` 不逐帧解析，重新可见后按快照整屏重建，后台窗口不再空转渲染。
- 读屏前必须等 headless 解析完已排队输出（`pendingWrites` 计数），并且该等待必须有硬预算（读屏 2s、`wait` 用剩余超时），否则高吞吐输出时读屏与 `wait` 会卡死；读屏终点按最后一行非空内容算，光标不在底部时不能截断下方内容。`wait` 的 `text`/`regex` 默认调用 `maskEchoedInput`（`skipEcho: false` 关闭）：按最近输入逐行拆成片段，遮掉每段**最靠下且带提示符**的回显行，以及该行上方等于输入原文的碎片行；回显下方等于原文的行视为真实输出保留。`expectExitCode` 不匹配时立刻返回实际退出码，idle 至少等满设定时长。
- 终端会话存在进程内，最多 12 条**活着的** shell（已退出不占额度）。`sweep()` 每分钟自动回收没人管的会话，两条线都以「窗口没在显示」为前提：已退出的留 10 分钟供读屏后回收；活着的要连续 6 小时无活动（输出、输入、改尺寸）才回收，正在跑东西的 shell 不会被误杀。`windowVisible` 的一律保留。`closed` 事件统一销毁窗口，端点关闭与回收关闭走同一条路径。`close` 用 `destroy` 结束进程，退出后仍可读最后屏幕。纯 Web 宿主没有主进程，`/remote/terminal/*` 明确回 503。
- SSE 的 `terminal:output` 只发给订阅该会话的页面，`terminal:changed` 只发给该会话的页面与不限会话的列表订阅者，不做全量广播。
- 写入类操作（`input`、`keys`、`resize`、`close`）校验 `x-mica-owner`：带 owner 且与会话 owner 不一致即 403；不带 owner 视为本人在页面操作，放行。读屏与 `wait` 不拦。这是防串台护栏，不是权限边界。
- 生成的 `$MICA_HOME/skills/mica-terminal/SKILL.md` 仅含服务地址，启动会覆盖；改端点文档只改 `terminal-docs.js`。
- 设置页 Terminal Control 与 Browser Control 同构：入口常驻（`layout/Sidebar.tsx`），只有桌面运行时能读数据，拿不到时用 `unavailableTerminalControlDetails` 说清未开启；页面只展示服务状态、会话列表与端点文档，不建会话、不管窗口。端点分组/curl/环境变量说明与浏览器页共用 `web/controlEndpoints.ts`，样式共用 `.control-*`。
- 顶栏图标与受控浏览器同一套显示逻辑：一条会话一个图标（多开按序标号），当前会话没有终端就**不出现**，顶栏也不再承担新建入口；会话由 agent 经 `POST /sessions` 创建。点击显示/隐藏窗口，右键确认后关闭。
- 通用路由、owner、本机 Origin/Host 校验在 `src/main/shared/endpoint-http.js`，浏览器与终端共用，不各写一份。

## 14. Desktop 文件、终端与侧栏

这里的终端是运行时里的用户终端面板；第 13 节的终端控制是主进程 PTY + 后台窗口，两套互不复用会话。

### 文件与 Git

- Files / TerminalHost 按需挂载后保留实例；ref 未就绪的打开请求暂存，挂载后补开，避免丢请求或未保存内容。
- Files root 与 terminal cwd 取活跃会话路径；每会话独立终端组，TerminalHost 仍接收全量 nodes，隐藏组不卸载。
- shell 由 `shell-path.js.resolveDefaultShell` 按平台和存在性解析；不能假定 SHELL 有值或 Linux 有 `/bin/zsh`。
- PTY 共享输出与 replay，rightTerms 清单共享；空闲 cwd 变化可重建，有前台进程不打断。每 10min 回收闲置 8h 的终端，跳过活跃会话、运行进程和缺活动记录项。
- 文件树尺寸沿用 VS Code：活动栏 48px、树行 22px、缩进 8px；桌面编辑器分栏始终存在，未打开文件显示 watermark。
- Git 分暂存/工作区两段，写操作仅 stage/unstage/discard，discard 点名文件并确认。
- 所有 Git 命令带 `GIT_OPTIONAL_LOCKS=0`；必需写锁冲突短重试，最终错误短暂提示，不能覆盖整个编辑器。
- 工作区 summary 与 branch compare 独立；比较 IO 在无 Electron 依赖的 `git-compare.js`，真实临时仓库验证。
- 比较固定为 compareRef commit hash；fingerprint 表示内容，引用失效自动回退并显示 warning。NUL 解析路径，读取并发上限 8。
- Git 审阅状态按仓库/基线/模式及 fingerprint 保存，内容不变不重建 Monaco 模型；普通编辑器在比较期间保持挂载。
- DiffEditor 统一只读，缺失侧用空模型，换文件先 setModel(null) 再释放。staged = HEAD→索引，worktree = 索引→工作区，snapshot = 固定提交→工作区。
- Git 轮询只在可见且有焦点时进行，Files 3s / 其他 10s，不重叠；保存、写操作、聚焦和进入 Files 立即刷新。

### 侧栏、搜索与统计

- Pinned / Projects / Recent 互斥，归属统一经 `stats:move-session`；分组换父级经 host，normalize 防成环/悬空。
- 拖放判定在 `session-dnd.js`，Recent 不手动重排；新建优先复用同 cwd、同组、无草稿文本且空闲的节点。
- 会话行共用操作列/图标列/名称栅格，仅分组嵌套加深；行内按钮阻止冒泡。删除会话与关页签是不同动作。
- 状态优先级沿用 `session-state.js`：running / unread 可向第一个可见祖先代显，error / 草稿铅笔不向上合并，角标不多占一列。
- error 红点表示异常未完成，后续 completed 才清；aborted 不算异常。running + 活 lease 显示运行态，running + 无活 lease 才判中断；lease 每次探测，不进文件签名缓存。
- 会话搜索共用 `mica-web-shared/session-search.ts`：等长全半角/大小写折叠、多词 AND、评分、高亮与片段；renderer 合并草稿并按相关度排序，最多 200 项。
- 正文由运行时搜 user/assistant 文本，排除 notice、工具和 compact boundary；每会话最多 20k 字符（首 60% + 尾 40%）。默认最近 3 个自然日，全部范围最多最近 600 个候选；截断须告知。
- 正文查询防抖 220ms，忽略过期响应；匹配规则不内联组件。快捷键 Cmd/Ctrl+K 不抢终端/输入框自身快捷键。
- 上下文统计同时支持两种协议，按整条消息 JSON 估算并单列 envelope，所有位置的媒体 payload 都排除。
- compact / rewind 后旧 input usage 失效时用 staleInput 说明，分母至少为消息体估算，避免占比超过 100%；详情与状态栏共用 ContextUsagePanel。

## 15. UI、配置页与移动端

### Ink

- `mica-ui` 只管组件/store，runtime 映射经 `MicaUiRuntimeBridge`；每 agent 保存独立 UI snapshot，展示 hot path 保持截断上限。
- Ink stdin 到 `parse-keypress.ts` 前保留 Buffer，不提前 setEncoding；增量 UTF-8 与 C1 规范化在解析层处理。
- Alt 键两种编码都支持，stdin tokenizer 保持 `metaEscape: true`，避免把 Option+↑ 拆成 Escape 清空输入。
- 编辑撤销/重做历史保存在组件 ref，新编辑清 redo；displayContent 只改展示，不改发给 agent 的内容。

### 配置页与主题

- `mica-config-ui` 为唯一配置页实现：config-web 用 HTTP 托管，desktop SettingsView 直接嵌入组件，数据经运行时，不改回 iframe/子进程。
- 新增数据动作先声明 `ConfigWebClient`；宿主无能力则方法可选并提供对应降级。Auto Compact 按能力出现，Browser Control / Terminal Control 始终显示说明。
- 样式限定 `.mica-config-ui`，页面级 html/body/#root 高度链由整页宿主定义，不能覆盖 desktop 窄屏根高度。
- 配置页新建/删除/放弃操作用 `DialogHost` 的 confirmDialog / promptDialog，不依赖原生 prompt/confirm。
- 改配置页后运行 `bun run build:config-web`，提交生成的 `generatedStaticAssets.ts`；system prompt 与内置角色直接复用 CLI 模板，跳过用户 default.md。
- desktop app.css 与配置页 styles.css 共用 Darcula token，修改同步；Monaco、xterm、theme-color、manifest 的字面色值同步。
- 内容面 `#2b2b2b`、外框 `#3c3f41`、正文 `#cccccc`、分界 `#4b4b4b`；保留前景梯级，Git diff 沿用 vs-dark 默认对比色。
- 主顶栏、侧栏占位、抽屉标题保持 h-8，对应外壳交通灯与 sheet offset 同步。
- 默认隐藏滚动条，仅主对话与 turn 日志可见；例外同时覆盖 scrollbar-width 和 webkit display。Monaco/xterm 自绘滚动条单独关闭。

### 移动端

- <768px 单栏 + 会话抽屉，Files 树/编辑器切换；右键操作提供 longPress 等价。`?layout=mobile|desktop` 可预览。
- 贴边元素处理 safe-top/safe-bottom，表单字号至少 16px（排除 Monaco inputarea），避免 iOS 自动放大。
- 根高度由 visual viewport / innerHeight / clientHeight 中明显更小的信号决定，保持固定定位与 `--vvh-top` 补偿；不能退回 100dvh 或被共享样式覆盖。
- viewport resize/scroll、window resize、orientation、focusin/out 后补量；高度缩小达到键盘阈值才补偿 offsetTop，缩放平移不作键盘位移。
- `TerminalKeyBar` 经 `term.input()` 进入 xterm，按钮 pointerdown/mousedown 阻止失焦；非 secure context 剪贴板失败提示系统粘贴。
- xterm 6 软键盘补发仅覆盖空格/A–Z，须 preventDefault，keyCode 229/0 放行 IME；升级含上游 #5614 的版本后删除补发并复验。
- xterm 6 使用 DOM 渲染器；字号/颜色走 options，改字号后 fit，不用 CSS 覆盖。

## 16. 构建、资源与验证

### 构建与资源

- `bun run build` 产出 `dist/mica`，默认安装到 `~/.local/lib/mica`，`~/.local/bin/mica` 为薄 launcher；行为不符先核对实际入口。
- `mica.build.env` 定义 runtime/version/app/config-dir 品牌键，同名环境变量优先，经 build --define 和 `mica-config/brand.ts` 暴露；改键同步构建文件与本手册。
- models.dev 种子用 `bun scripts/update-models-dev-seed.mjs` 刷新；release CI 刷新失败 warning，使用固定副本继续构建。
- 品牌 SVG 唯一源为 `apps/desktop/resources/icon.svg`，其他端引用，网页保留 `?url&no-inline`。位图由 `npm run icons:generate` 生成，macOS 留白在生成器外扩 viewBox，不改 SVG。
- renderer 显式 `build.minify: true`；重依赖本地 lazy 加载，不用 CDN。Monaco 仅由 monaco-runtime 和 lazy 编辑器加载，保留 JSON contribution 与 json worker 分派。
- 文件图标用 `?url&no-inline`，避免全部内嵌主包；静态文本 gzip，hash 资源 immutable 缓存。
- 官网架构图只改 `apps/website/architecture/*.architecture.json` 再由 Archify 生成 HTML；交付前 showcase validate 零错误/警告，visual-check 四档无溢出（1440×900、1600×1000、1920×1080、2048×1320），清除生成的检查 sidecar。
- GitHub Pages 显式传 configure-pages 的 base path output，Astro 内部链接经 `import.meta.env.BASE_URL` 拼接。

### 验证选择

- 局部改动默认跑相关测试、必要的 typecheck 和 `git diff --check`；全量测试约 7–8 分钟，仅发布、跨慢套件或 CI 要求时跑。
- 根测试用 Vitest / Node；`PtyDriver` 仅 Node/vitest 可导入，Bun 用 manager + Node helper。
- `app-server.flows.test.ts` 使用本地 mock provider，无需真实 key；compact 测试至少两轮且超过 recent-token budget，resume 复用隔离 MICA_HOME。
- PTY 常规回归覆盖 driver、manager、serverSource；真实 provider 冒烟须显式开启 `MICA_PTY_SMOKE=1`，并传 `MICA_PTY_SOURCE_HOME`，避免 Vitest 重定向 HOME 后读错配置。
- desktop 改动至少 `npx eslint src/` + `npm test`；新增运行时依赖另构建 server 验证自包含。
- 浏览器主进程能力还须用 Electron 临时脚本 + 本地 stub 页面验证 create/evaluate/click/type/screenshot/cookies/console/network/隐藏行为，单测不能替代真窗口检查。
- 终端控制同样要真窗口验证：真实 pty 起 zsh、窗口加载 `/terminal-control`、AI 输入命令后读屏与页面 DOM 一致、hide/show、close 销毁窗口；`@xterm/headless` 与 `node-pty` 都是原生/大依赖，不能只靠单测。**bun 下 node-pty 能加载但不送数据**，会话级测试因此用 `createTerminalSessions({ spawnPty })` 注入假 pty，真 pty 只在 Electron/Node 里跑。
- 运行时桥可用 stub 浏览器服务 + `node out/server/index.mjs` + `/api/invoke` 验证；spawn 保持 stdin 打开，`--port 0` 被视为未设置。

### 调试与临时验证

- **同一时刻只起一个 Electron 实例**。每个实例都会建窗口与 PTY，并行起两个就能把机器拖到无响应；需要对比新旧行为时串行做，验证完先退出再起下一个。
- 起测试实例必须同时给 `MICA_HOME`、`MICA_DESKTOP_USER_DATA`、`MICA_DESKTOP_PORT` 和一个独立 `--user-data-dir`：只给其中一个，socket 会落到真实 userData 上，把用户正在用的服务顶掉。
- `npm run dev` 会复用默认端口上已有的运行时，窗口因此可能连到旧代码；验证 host/主进程改动时换端口（如 `MICA_DESKTOP_PORT=8899`），并从 ready 日志取实际地址。
- 长时间运行的进程放后台任务，用 `wait_for`（http/port/文件）等就绪，不要用大数字 `sleep` 或 shell 超时硬等——超时会把进程留在半死状态，后续判断全部失真。
- 临时探针脚本（CDP、截图、curl 序列）命名成 `.probe-*.mjs` 之类并放在仓库内，用完立即删除；交付前用 `git status --short` 确认没有残留文件与临时目录。
- 端到端验证只在真正需要时做；能靠单测覆盖的行为不要动真窗口。真窗口验证后确认进程已退出（`pgrep`）且端口已释放（`lsof -nP -iTCP:<port>`）。
- 只格式化自己改过的文件，禁止对整个目录跑 Prettier：会把无关文件一起改掉，混进本次 diff。
- 判断「服务不可用」先看证据再下结论：`curl` 端点、`lsof` 端口与 socket 文件、日志里的 ready 行三者对齐后再动手，避免把旧构建产物、复用实例或残留 socket 误判成代码缺陷。
- 见到整页空白/黑屏先查渲染期异常（未初始化的 `const`、抛错的组件），不要先怀疑数据；`ErrorBoundary` 的兜底页会带出真实错误与堆栈。

交付前按实际影响复查：依赖方向、busy guard、队列 owner、retry/abort 去重、lease、snapshot/UI 恢复、用量归属、工具 readOnly、MCP 清理、desktop 三层边界、构建产物与文档同步。
