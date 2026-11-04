# Mica Code Agent 手册

本文件由 `packages/mica-agent/prompt/index.ts` 注入系统提示词的 `<project-instructions>`，每次请求都会发送。
优先级低于系统、开发者和当前用户指令；与代码不一致时以代码为准，并在同次变更中修正本文。
只写稳定约束、职责边界、关键链路与验证方式；实现细节留在代码和 `docs/`。

## 1. 工作约定

- 改前看 `git status --short`，保留用户已有改动；禁止 `git reset --hard`、`git checkout --`、强推、批量删除与 `--no-verify`。
- 只改任务相关文件，不顺手格式化、重命名或重构；只格式化自己改过的文件。
- 不自动 commit、push、建分支或开 PR。
- 搜索用 `rg`，默认排除 `temp/`、`.backups/`、`node_modules/`、`dist/`、`out/`。
- 测试与临时复现使用隔离的 `MICA_HOME`；起桌面实例还要独立的 `MICA_DESKTOP_USER_DATA`、`MICA_DESKTOP_PORT` 与 `--user-data-dir`。
- 改动触及本文的架构、路径、命令、配置、协议或流程时，同次更新对应段落。
- 用户可见命令同步根 `README.md`、`packages/mica-builtin-commands/README.md` 与 `apps/website/src/pages/docs/commands.astro`；公共 API 同步 `packages/README.md` 与包 README。
- prompt、skills 索引与工具描述参与 prompt cache 前缀，改时保持前缀稳定。
- 产品能力优先做成插件：内核里不出现具体插件名词，插件也不靠改别人的数据伪造界面。
- **插件系统本身仍在持续迭代，实现插件时同步考虑重构插件系统**：当现有 `PluginContext` 能力面、插件格式或生命周期难以承载新插件时，不要为了绕开限制写特例、塞私有约定或让插件去改别人的数据；先按第 7 节的设计准则重构插件系统，再在新机制上实现该插件。
- 不为旧形态保留兼容分支：改了数据形态、目录布局、协议字段或插件格式，就删掉旧的解析、回退与迁移，只留一句「这个形态不再支持」。
- 改造影响已有会话数据时，优先一次性迁移或清洗受影响的旧会话数据，使其符合新形态；不要为旧数据在运行时代码中保留长期兼容分支。迁移前确认范围，保留无关会话和用户数据。**旧数据清洗统一由官方插件 `evolution` 承担**（见第 7 节「数据演进与旧数据清洗」）：改了持久化形态就在同一次变更里往 `plugins/evolution/migrations.ts` 加一条迁移，而不是在读取点写 `?? 旧形状`。

## 2. 常用命令

### 仓库根目录（CLI）

```bash
bun install
bun run dev
bun run typecheck
bun run test -- <测试文件>   # Vitest；根项目不要用 bun test
bun run test:unit          # 只跑 unit project（进程内单测，并行）
bun run test:process       # 只跑 process project（真实子进程 E2E，文件串行）
bun run build              # typecheck → 单二进制编译 → 安装本地入口
bun run build:config-web   # 配置页产物 + generatedStaticAssets.ts
bun run format             # 全仓格式化；局部任务只格式化改动文件
```

### Desktop（`apps/desktop/`）

```bash
npm install
npm run dev                # 构建运行时后启动 Electron + Vite
npm test                   # bun test，覆盖 host / renderer / main
npx eslint src/
npm run build              # 先构建根 CLI（bun run build），再外壳 + Web 运行时
npm run build:app          # 同上 + electron-builder --dir，产出可直接运行的 .app（约 6s）
npm run build:mac          # 再打 DMG + zip（发布用；打包与压缩占 20s 以上；根目录 `bun run build:release` 同效）
npm run start:web          # 运行已构建的 Web 运行时
```

`build:app` 之前会执行根 `bun run build`：桌面端经 `resolveMicaExecutable()` 使用 `~/.local/bin/mica`，不刷新 CLI 就会连到旧二进制。

## 3. 代码地图与依赖边界

### 应用

| 路径               | 职责                                          |
| ------------------ | --------------------------------------------- |
| `apps/cli/`        | CLI 装配、turn loop、headless、app-server     |
| `apps/desktop/`    | Web 运行时、renderer、Electron 容器           |
| `apps/config-web/` | 配置页浏览器宿主：Bun HTTP 服务与内嵌静态资源 |
| `apps/website/`    | Astro 官网                                    |

仓库根的 `plugins/` 是官方插件源码，由 `packages/mica-official-plugins` 静态登记后编译进产物；用户插件装在 `$MICA_HOME/plugins`，格式相同。

### 公共包

以下包均位于 `packages/`。

| 包                            | 职责与限制                                                              |
| ----------------------------- | ----------------------------------------------------------------------- |
| `mica-agent`                  | agent、provider adapter、prompt；不依赖 UI、session、commands 或入口    |
| `mica-runtime`                | runtime 协议、事件、状态、队列原语；不编排 turn loop                    |
| `mica-tools`                  | 唯一工具 registry，接入内置工具、插件工具与 MCP                         |
| `mica-mcp`                    | MCP server 生命周期                                                     |
| `mica-ui`                     | Ink 组件与状态 store；不调用 provider                                   |
| `mica-session`                | 会话快照持久化与 turn lock                                              |
| `mica-config`                 | 配置、本地状态、模型规则、品牌路径                                      |
| `mica-context`                | 压缩（`CompactionService`）；不直接操纵 provider adapter                |
| `mica-commands`               | 通用命令机制                                                            |
| `mica-builtin-commands`       | 产品命令、运行期插件、启动扩展                                          |
| `mica-skills` / `mica-plugin` | skills 扫描解析缓存 / 插件机制与能力面                                  |
| `mica-common`                 | 跨端纯逻辑（loop 参数、引用、消息定位、自动链接、能力开关、会话笔记等） |
| `mica-pty`                    | PTY 驱动与 Node helper；native binding 只在 Node 子进程加载             |
| `mica-web-shared`             | desktop renderer 与运行时共享的展示、状态、搜索、地址约定               |
| `mica-file-mentions`          | CLI / desktop 共用的文件补全触发、扫描、排序、插入                      |
| `mica-config-ui`              | 配置页唯一实现：页面、数据动作、共享类型                                |
| `mica-diagnostics`            | 诊断日志唯一写入器：JSONL 落盘、慢操作聚合、进程内存采样（node-only）   |
| `mica-official-plugins`       | 官方插件目录：`manifests.js` 只含清单，`index.js` 才带入口              |
| `@anthropic/ink`              | 仓库内 vendored 的 Ink 分支：终端渲染原语，`mica-ui` 的唯一 Ink 来源    |

### 边界规则

- 公共 API 从包的 `index.ts` 导出；应用层优先用 `@packages/<name>/index.js`。
- `@packages/*`、`@apps/*` alias 在根 tsconfig；包不得反向依赖 `@apps/*`。
- 底层需要上层能力时，通过类型、回调、service、hook 或 adapter 注入。
- `mica-config` 是配置与本地状态的唯一入口；UI / commands / runtime / adapter 不自行拼路径。
- TypeScript 使用 strict、isolatedModules、verbatimModuleSyntax；类型导入用 `import type`。
- 默认静态导入；进程模式分派、PTY 首次加载、renderer 重模块可按需动态 import。
- 生产代码禁止静态 import `node-pty` 或 `mica-pty/index.js`：native binding 必须保持 external。
- 只想列插件的宿主只 import `mica-official-plugins/manifests.js`，别把插件实现拖进进程。

## 4. CLI 运行链路

### 启动

1. `apps/cli/src/app/configWebWorker.ts` 优先分派 Config Web worker。
2. `apps/cli/src/index.ts` 在加载 config/runtime 前分派 version、models、exec、compact、插件命令（`mica commit`）与交互模式；`startup/validate-config.js` 补齐默认值。
3. `Application.start()`：Ink → 配置校验 → 必要时选初始模型 → runtime、session、registry、hooks、services、agent/session manager、UI bridge、subagent manager。
4. 设 active context → 注册内置插件 → 用户插件 `setupAll` 并写 `plugin-status.json` → 启动 UI bridge 与 runtime。
5. 失败时显示修复提示、清理资源、设置 `process.exitCode = 1`。

- `apps/cli/src/app/activeContext.ts` 是应用上下文的唯一全局入口；底层不 import `Application.ts` 取状态。
- 多 agent 命令使用 `createActiveAgentProxy` / `createActiveSessionControllerProxy`。
- 插件 `ctx.onDispose()` 登记的资源在正常卸载与启动失败时都按注册逆序释放；单项清理失败仍继续释放其余资源，正常卸载结束后汇总抛错。`actions.register`、`desktop.panel` 与 `desktop.sessionMenu` 的登记由 manager 自动回收，新增 capability 同步登记 disposer。
- provider/model/effort/role 切换先 busy guard，完成后 `reloadConfig(false)`、保存 session、同步 UI。
- 非空会话跨协议切换由 `applyConfigSwitchUpdate` 阻止；恢复旧会话协议不匹配时降级恢复 model/effort，不静默丢历史。
- `/resume` 与 `--resume` 切到会话自己的 `cwd`（目录缺失时保留当前目录并提示）；app-server 的 resume 以客户端传入的 cwd 为准。

### Turn 与队列

- `LocalRuntimeController.submit()` 先 trim 并解析命令，再经 `input:received` guard hook 处理普通输入；未被处理的输入进入 turn。
- 每个写 session 的 turn 必须持有 turn lease，在 `refreshFromStore()` 之前获取；拿不到就拒绝。lease 必须在 `turn:after` 前释放，finally 保留幂等兜底。
- 保存顺序：`running` → 每次工具迭代 checkpoint → 成功 assistant + `completed`；失败/中止存 `error` / `aborted`。非 completed 会话在 `/resume` 标 `（uncompleted）`。
- turn 启动即保存本轮用户输入；headless 对**非 `system`** 的输入都写入（插件 `ctx.runtime.submit` 的一轮在客户端没有乐观气泡，不写就只剩回答），内容取 `displayText`，缺省用真正发给模型的输入。本轮跑完后原文进了 provider 历史，保存时用展示文本**就地替换**那一条（`mergeInFlightUserMessage`），不追加第二条；定位那条消息要按共享归一化（`comparableText`，纯媒体退回图片引用）比，不能按原文——compact 会把图片块换成 `[image omitted during compact]`，原文比对必然落空，那条副本就留在会话末尾（重开 APP 时表现为同一条用户消息渲染两遍）。
- `MessageQueueService` 的每个操作都带 owner；pending input 只放 `pendingInputs`，不提前追加对话或 provider history。
- TUI 与 desktop 的 Enter / Tab / Shift+Tab 统一 `after_iteration`；`after_turn` 仅供 `/loop` 等显式请求。
- 当前 turn 没有后续迭代时由 message-queue 的 `turn:after` 兜底；仅 `completed` 自动发送，失败/中止保留输入供撤回。
- 两端都支持 Shift+← 撤回；desktop 的 host 槽走 `mica/queue/recall`。

### 重试与中止

- turn 级重试最多 5 次、间隔 10s；仅在错误可重试且本轮没有非只读工具调用时自动重试，先恢复 pre-turn snapshot。
- provider 的 `withRetry` 只在尚无文本/工具输出时重发（thinking 不算输出），退避 2/4/8/16/30s。
- 流空闲超过 60s 视为超时（`core/streamIdleTimeout.ts`）：SDK 的超时只覆盖到响应头，网关握手成功却不再吐事件时由看门狗关流并抛 `TimeoutError`，交给上面的重试判定。
- 重试清空 responseBuffer，重放已消费的 `after_iteration` 输入，等待能被 abort 立即打断。
- `turn:retrying` 不得投影为 Codex `error`，否则 desktop 会提前结束 run。
- 重试与失败写成 notice 存进 `conversationMessages`（`runtime/turnNotices.ts`），不进 provider history。
- `AgentRuntime.abort()` 递增 runId 并中止 controller；补写只传 `uncommittedResponseText`。
- 流迭代结束后仍须 `throwIfQueryStopped`，防止 SDK 吞掉 AbortError 后提交空 assistant 消息。

### Provider 与 Prompt

- `createModelClient` 按 `provider.protocol` 显式选择客户端，不按 `api_base` 猜协议。
- adapter 负责 wire 参数、消息结构、history normalizer、usage 与 tool-call 转换；runtime 不拼请求。
- `executeProviderToolCalls` 把连续只读工具与 `Agent` 调用并发，写/执行工具作为串行屏障；结果按调用顺序回填，每组前后检查 abort。
- `readOnly: true` 同时允许并发与安全重试，工具必须无共享可变状态。
- 多模态工具结果：Chat Completions 先追加全部 tool 文本，再用一条 user 消息承载图片；Responses 用原生 `function_call_output`。UI、日志只取文本投影。
- 两种运行模式的 `[Image](路径)` 都先经 `parseImageRefs` 转成多模态块；headless 直接导入 `mica-ui/utils/imagePaste.js`，避免引入 React/Ink。
- 运行中改写只能经 `rewriteIterationMessages` 改 provider loop 的本地数组；钩子输入不含 system prompt，Chat Completions 重写后须补回 system。
- 无视觉模型经 `stripImagesForVision` 替换发送副本中的图片；持久化历史保留原图。
- Responses 带 reasoning 参数时保留 `summary: 'auto'`；历史 reasoning 经 `dropReplayedReasoningItems` 从发送副本移除。
- `buildSystemPrompt()` 默认读 `mica-agent/prompt/system.md`；磁盘 role 只替换 `<system>`，插件 role（清单 `roles` → `$MICA_HOME/plugin-roles/`）**追加**在末尾并带 `append: true`；cwd 的 `AGENT.md` / `AGENTS.md` 合并注入，路径按 live cwd 解析。会话角色名是**配置**：`loadSnapshot` 与 `resolveCurrentRole` 解析不到它时用默认角色的正文，但绝不把名字改写成 `default`（插件 role 由插件 setup 之后才发布，那一刻查不到很正常；改写会让下一次保存真的把角色丢掉）。`agent.role` 因此报配置里的名字。
- base prompt 只放「换宿主也不变」的东西：身份、指令层级、能力与插件的判断方式、工作方式、编辑约束、验证与交付。计划、委派、笔记、记忆这类策略由对应插件注册 `ctx.prompt.section()` 注入，随插件停用一起消失——不要为了「提示词完整」把工具用法抄回 base。
- 工具用法（参数、超时、并发、等待语义）只写在工具 schema 描述里，base prompt 不重复：两处都写必然漂移，且每次改工具都在改 prompt cache 前缀。
- skills 只以索引进入 system prompt。
- 每次提示词注入都有 XML 边界：项目文件各用 `<document source="…">`，插件只通过 `ctx.prompt.section()` 注入，由宿主生成 `<injection source="plugin" plugin="…" section="…">`；`system-prompt:build` 不再支持。正文允许语义 XML，动态数据必须转义；外层标签由宿主保留。子代理规则、角色与插件独立模型请求也分别包装，来源属性保持稳定，不含轮次随机值。
- `AgentRuntime.setCapabilities()` 保存会话开关；prompt、工具定义与执行校验读同一份状态。未定制的会话跟随 `config.capabilityDefaults`，`resetCapabilitiesToDefaults()` 回到跟随默认。
- effort 的档位名就是模型在 models.dev 声明的真实取值：`minimal`/`max`/`xhigh` 各是各的，不归一化、不落别名；只有开关的模型是 `none`/`on`，只声明 budget 或没有 reasoning 的模型没有档位。没有任何档位的模型不发推理参数，也不在 `/effort`、desktop 选择器里凑五档；models.dev 没收录的模型由 provider 的 `effortLevels` 声明档位。切换模型时 clamp 到该模型自己的档位并同步 context window。metadata 优先级：磁盘缓存（24h）→ 内置 models.dev 种子 → 在线刷新。
- 档位/上下文跟着「谁在服务这次请求」查：`getModelRule` / `ensureModelRule` 接受 provider 作用域（`{ id, api_base }`），缓存键带上 provider。同一个模型在网关（OpenRouter 的 `moonshotai/kimi-k3` 有 `none`）与厂商原生条目（没有 `none`）下的档位可以不同，只按模型名匹配会用错那一份。服务商在 models.dev 里收录了这个模型就以它为准（先认 `id`、再认 `api_base` 的主机名），否则仍按模型厂商的条目。
- 发给模型的是 `getModelRule(model, provider)` 的那份规则，界面显示的也必须是同一份：状态行按「模型声明的档位 + 模型默认档位」收敛（`resolveDisplayedEffort`），没有档位显示 `—`，不属于该模型的档位显示它自己的默认值——界面不能显示一个不会发出去的值。
- 档位解析分两条策略（`resolveRuntimeConfigOverride` 的 `effortPolicy`）：`mica exec --variant` 这类命令行显式参数走 `strict`，档位不合法就报错；客户端带上来的 model+effort（desktop 选择器、Codex 驱动的 thread/\* 字段）走 `clamp`，收敛到目标模型的档位或丢掉它没声明的档位，由 host 用 warning 说明实际发了什么。app-server 因此绝不能因为一个客户端档位起不来。
- 解析档位之前必须先 `ensureModelRule(model)`：档位集合来自 models.dev，磁盘缓存异步读，先算会把「只在缓存里、随包种子里没有」的模型判成没有档位。
- 档位的**字段名**跟着「谁在服务这次请求」走（`isGatewayEntry`）：厂商直连的条目（`deepseek-flash`）用 `thinking` / `reasoning_effort`，聚合网关的条目（`z-ai/glm-4.6` 这类带前缀的键）只能用 `reasoning.effort`——网关会静默忽略 `thinking`，推理照跑。两边一起发更糟，网关会先命中 `thinking` / `reasoning_effort` 而把 `none` 顶掉。
- models.dev 的档位是社区数据，未必等于某台网关的真实枚举（`openai/gpt-6.1-terra` 在一处声明 `none`，某台 codex 网关只认 low…max）。provider 用 400/422 明确拒绝本次带上的推理参数时，客户端丢掉推理参数重发一次，并经 `markEffortLevelRejected` 记住「这台服务商的这个模型不收这一档」，`resolveEffortParams` 之后直接不发——压缩摘要、起标题、子代理这些每次新建客户端、effort 又不是用户选的路径因此不会反复撞同一个 400。
- 只有 `get_model_url` 动态 provider 查询模型列表，结果不写回 config.json。

## 5. 配置、会话与存储

- `MICA_HOME` 覆盖全部用户路径，默认 `~/.mica`；品牌目录经 `brand.ts` 解析。
- `PersistedMicaConfig` 只存静态字段；运行时用 `stripRuntimeFields` 去除 provider/model/effort/contextWindowSize。新会话默认值唯一来自 `config.json.defaultModel: { provider, model, effort? }`；未配置取 `providers[0].models[0]`（动态列表取返回首项），未填 effort 用模型默认档位。`micaConfig.resetSessionModelDefaults()` 重读默认值并保留已加载的动态模型列表，TUI `/new`、`/clear` 同样调用；恢复会话与显式选择保留自己的值。`storage.json` 不再读写目录模型偏好。
- 旧版本写在 `config.json` 的 `searxngUrl` 在启动时迁进 `plugin-settings/web-search.json`（已有值不覆盖）并删掉原键；搜索改成插件后只有插件设置生效。
- 配置迁移与语义校验统一在 `startup/validate-config.js`，配置页保存复用它。
- 仅当所有 provider 都没有 api_key 时，`envProvider.ts` 从 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 合成运行时 provider；环境 provider 永不写回 config.json。
- session 是 version 1 JSON；新增字段要有版本策略、默认值与 sanitize，字段类型不对按损坏拒绝。
- `parentSessionId` 是顶层元信息（与 `cwd` 同级），记录「谁派生的这条会话」：`--parent`、
  `thread/start`、fork（父会话换成源会话）。非法值（非字符串、id 形状不对、自指）丢弃而不是拒绝整个
  会话——它只影响侧栏嵌套。`$MICA_HOME/session-index.json` 的版本号跟着升，旧索引直接重建。
- 会话级状态都在快照里：`capabilitySelection` / `capabilitiesCustomized`、`pluginState`（插件自己的 JSON）、`pluginSessionSettings`（插件设置的会话覆盖，只存改过的键）、`notes`。`startNewSession` 清空，resume/fork 沿用，rewind 随 checkpoint 回滚。`turnTimings`（最近 50 轮的耗时分解）是例外：它记录这条会话跑过的轮次，`startNewSession` 与 fork 都清空，读盘时坏掉的条目丢掉而不是判整份会话损坏。
- `snapshot.systemPrompt` 是「最近一次请求真正发出去的 system prompt」的存档（角色 + 项目说明 + skills 索引 + 环境信息 + 插件段落），只给界面看，绝不用于重建请求——下一轮仍然现场拼装。写在 `AgentRuntime` 解析 `systemPrompt` 的那一刻，随 checkpoint 落盘；旧会话没有这个字段，界面如实说「没有记录」而不重新拼一份冒充。
- `subagentUsageHistory` 独立于主 `usageHistory`；fork 清空两类历史，只保留描述继承上下文的 `lastUsage`。
- `usageHistory[*].rawUsage` 只存**标量 + 一层明细**（`mica-common/rawUsage.ts` 的 `compactRawUsage`，被裁过就带 `truncated: true`）：聚合网关会在 `usage.attribution.items` 里逐条回传 token 归因，没有消费方，却能让单条记录到 247KB、一份 1.5MB 的会话涨到 30MB。读回旧会话时按同一份规则压一次（幂等，与内存态同形），下一次落盘文件也就跟着变小。
- compact 保留 `lastUsage` / `usageHistory` 供 Stats 对账；界面 ctx 优先读 `displayUsage`。
- 无手动标题时取最后一条真实用户消息（最长 60 字符）；自动改名不得覆盖 `titleSource === 'manual'`。
- `$MICA_HOME/session-index.json` 是可重建缓存，不进 `sessions/`；索引 v3 记录读不出摘要的 `rejects`（id + size/mtime），避免每次全量重扫，并带上侧栏嵌套要用的 `parentSessionId`（v2 没有它，版本对不上就整份重建）。
- `sessions/.turn-locks/<id>.lock` 是跨进程写入的唯一事实来源（`wx` + owner pid 存活判定）；孤儿锁在 acquire 时回收。
- 垃圾占位须同时满足：默认占位标题、无对话、无 usage；`turnState === 'running'` 永不隐藏或删除。

## 6. Headless 与 app-server

- `HeadlessTurnExecutor` 不触碰 Ink/UI；每轮顺序：取 lease → `refreshFromStore()` → `reserveRunId()`；取锁失败返回 `busy-remote`。排队输入只在上一轮**完成**后才接着跑，中止/失败把它留在队列里可撤回（与 `message-queue` 插件的 `turn:after` 同一条规则）——否则点了停止会先停、再把排队的话发出去、再停一次。桌面宿主的 abort 强杀兜底只针对发起中止的那一轮（`run.aborting` + turn id），不能杀中止之后新起的轮次。
- 桌面端点停止是「撤回排队 + 中断」一次动作：`chat:abort` 先经 `mica/queue/recall`（和本地 after_turn 槽）把排队消息取出来，随结果回给页面放回输入框，再发中断。取不到（已注入 / host 不响应）就留在队列里，中止后仍可按 Shift+← 撤回。
- 每轮都发 `turn:finish`，结果只有 completed / aborted / error；排队轮次同样逐轮取 lease。
- `HeadlessPluginHost` 是 exec / app-server 共用的插件装配层；MCP 显式初始化，不注册输入框与命令 UI。用户插件（`$MICA_HOME/plugins`）只在常驻宿主装：`createHeadlessPluginHost({ loadUserPlugins: true })` 交出「重新扫描用户插件」的加载器（app-server 传 true、exec 不传），面板与桌面入口都靠它；加载与 `plugin-status.json` 的写入都由 manager 按 `pluginStateSync` 完成，启停走同一条路。
- `mica/turn/input`（`MICA_TURN_NOTIFICATIONS.input`）在插件发起的轮次启动**之前**发出，带展示文本；晚于 `turn/started` 会让页面把上一轮的文本当成本轮用户消息。
- `attachPluginLayer()` 同步替换 executor queue，避免插件写入与 loop 读取不同实例。
- `mica app-server` 是每会话常驻进程；stdin/stdout 使用 Codex v2 JSONL。framing 在 `mica-runtime/codexProtocol.ts`，事件投影在 `runtime/CodexProjector.ts`。
- `--parent <sessionId>` 标记这条会话由谁派生（子会话、fork 分支），写进会话文件的
  `parentSessionId`。只对新建会话生效：resume 时以文件里记的那条为准。`thread/start` 的
  `parentSessionId` 同样只被尚未落盘的会话采纳，且已有值时幂等——重复 startNewSession 会换掉
  会话 id，客户端手里那份 thread 就对不上落盘文件名了。
- `mica/*` 扩展通知直接送 renderer，不进 turn 重放缓冲：queue、tasks、BTW、history、capabilities、turn retrying。
- `mica/capabilities/get|set` 读写会话能力；运行中 set 返回 `ok:false`。
- `mica/input/activity` 是「用户在输入框敲了字」（不是提交）：宿主只把它翻成运行期事件 `input:activity`，由插件决定要不要动作。桌面端在 `ChatView` 里节流 2s 发出，没有常驻进程时 host 直接吞掉（绝不为几个按键 spawn 一个）；TUI 与 `mica exec` 不发。自动压缩已不再订阅它——轮次之外不压，只当「人在不在」的通用信号。
- `mica/input/focus` 是「焦点回到了输入框」（还没敲字）：同样只翻成运行期事件 `input:focus`。桌面端在 `TerminalComposer` 获得焦点时发，并且只在会话没在跑（本页或其他进程都没在跑）时发。与 `input:activity` 一样，当前没有插件消费它。
- `turn/start` / `mica/turn/editMessage` 可传 role，由 host 在启动 turn 前应用；edit 时必须在 `loadSnapshot()` 之后应用。角色缺失只 warning 并保留原角色，不为切角色重建 host。
- `mica/sessionState/get|set` 读写**某个插件的会话级状态**（`pluginState[pluginId]`）。内核不解析那份 JSON：笔记这类形状由插件自己定义，桌面卡片与插件自己的 `ctx.sessionState` 读写同一份。落盘跟随本轮 checkpoint，不在 handler 里抢占 lease。
- `mica/session/cwd` 换本会话的工作目录（页面右下角那个项目路径）。宿主自己 `process.chdir` 并按新目录改已落盘的那份：盘上的 `cwd` 是 `process.cwd()` 的快照，页面直接改文件会被下一轮保存覆盖回去、那一轮也还在旧目录里跑。运行中拒绝（这一轮已按旧目录起了工具与 prompt）；`updatedAt` 不动（换目录不是会话活动，否则会话会被顶到 Recent 最前面）。桌面端 `chat:set-cwd` 优先交给这条会话的宿主，没人持锁才直接写文件，草稿（还没落盘的会话）不写。
- `mica/subagentTasks/list|detail|kill|restart` 管子代理任务：`list` 与每秒一次的 `mica/subagentTasks/updated` 快照只用于列表，`detail` 才带完整 timeline；`restart` 只在任务已停下、且能确认原执行进程已退出时接受（见第 8 节）。桌面端详情弹窗的「重启」按钮就发这一条。
- `mica/pluginPanel/view|action` 读一块插件面板的视图、转发一次动作（`pluginId + action/key/values`）；面板处理器活在常驻会话宿主里（插件就在那个进程），没有宿主时桌面端按需起一个。
- `mica/sessionMenu/run` 转发一次会话右键菜单动作（`pluginId + action`），插件回 `{ copyText?, message? }`；处理器与面板一样活在常驻会话宿主里，没有宿主时桌面端按需起一个。
- 改名先找常驻 host 调 `SessionController.renameCurrent`；无 host 且无其他进程 lease 时才直接写盘。
- 新对话（还没有会话）改名 = 这条会话此刻就要存在：桌面端按需起常驻 host 让它把空会话连同手动标题落盘，回包里的 `sessionId` 立刻绑到页签上。手动标题（`titleSource === 'manual'`）的空会话不按草稿删——`saveCurrent` 与 `discardCurrentIfEmpty` 都跳过它，否则侧栏里刚命名的会话会在换会话/落盘时凭空消失。
- `mica/turn/editMessage` 把 provider history 截断到目标用户消息之前，再用新文本重跑；定位共用 `mica-common/promptText.ts`。启动失败恢复原快照。
- `mica exec` 默认人读文本，`--json` 为 Codex ThreadEvent JSONL；保留 codex-family 参数兼容（`--cd`、`-c`、`--` 与裸 prompt）。
- resume / chdir / MCP 初始化失败降级继续；只有 resume 失败发 Codex error。unhandledRejection 记 warning，uncaughtException 发 error 后退出。

## 7. 扩展：插件、命令、工具、MCP、Skills

### 插件

**插件系统仍在持续迭代：实现一个插件时，把「这个插件是否需要先推动插件系统进化」当作设计的一部分，而不是只在现有能力面上将就。**

- 该先重构的信号：需求要读插件拿不到的数据、要靠改别人的数据伪造界面、要依赖宿主里的私有约定、要在多个插件间共享同一份可变状态、或必须为某个插件在宿主里写死分支——出现任一条都说明能力面缺东西，先重构插件系统，再在新机制上实现该插件。
- 重构方向是通用能力面：扩展 `PluginContext` 的某一面（`agent` / `background` / `commands` / `desktop` / `events` / `hooks` / `session` / `sessionState` / `settings` / `skills` / `tools` / `ui`）或复用已有能力；宿主里不出现具体插件名词，「加个 if 兼容某插件」不算设计。
- 重构与实现同一次变更交付：插件系统改动、受影响的官方插件、`plugins/README.md` 与本文章节一并更新；按第 1 节不留旧形态兼容分支，不为过渡保留双路径。
- 插件格式或能力面变更后跑 `plugins/**` 相关测试与 `bun run typecheck`；触及工具定义或 prompt 前缀时按第 1 节确认前缀稳定。
- 插件只有一种形态：目录 + `plugin.json`（`id` / `name` / `version` / `icon` / `main` / `assets` / `dependencies` / `required` / `priority` / `mica.apiVersion` / `settings` / `llm` / `requires` / `desktop`）+ 入口（`default` 导出 `setup(ctx)`）。`icon` 是配置页插件目录与桌面入口行的图标名，不认的值回落默认图标。格式与字段以 `plugins/README.md` 为准。
- 官方插件在仓库根 `plugins/<id>/`：清单登记在 `mica-official-plugins/manifests.ts`，入口登记在 `index.ts`。用户插件在 `$MICA_HOME/plugins/<id>/`，由 `FilePluginLoader` 启动时加载，id 一律加 `user.` 前缀。
- 没有 `plugin.json` 的目录、散落成文件的 `.js` / `.mjs` 都不是插件，加载器不猜。
- 启停状态在 `$MICA_HOME/plugins-state.json`（`{ "disabled": [...] }`）；停用的插件**照常注册**、在装配阶段跳过，所以启用只是「再 setup 一次」。
- 常驻宿主（TUI / app-server）在 `baseContext.pluginStateSync` 里交出「怎么重新扫描用户插件」与 `canSyncNow()`，manager 据此跟着 `plugins-state.json` 走：**文件一变（`watchFile` 400ms + 120ms 去抖）就对齐一次**，停用的插件立刻卸载、重新启用的立刻装配，并重写 `plugin-status.json`；`canSyncNow()` 为 false（这一轮正在跑）时只记下来，等 `turn:after` 补做——工具与钩子不能从跑到一半的轮次脚底抽走。`turn:before` 仍兜底 stat 一次（容器 / 网络盘可能漏事件），所以漏了也不会错到下一轮之后。一次性宿主（`mica exec`、插件命令 / 动作）没有下一轮可等，名单只在装配时读一次。每插件的资源按 pluginId 分开登记，卸载一个插件不能碰别人的工具、命令与钩子。
- `requires` 必须写全插件触碰的每一面：`actions` / `agent` / `background` / `commands` / `desktop` / `events` / `git` / `hooks` / `llm` / `models` / `prompt` / `runtime` / `session` / `sessionSettings` / `sessionState` / `settings` / `skills` / `subagents` / `tools` / `ui`。缺一项整插件跳过，原因写进 `plugin-status.json` 的 `skipped`；跳过**不写** `plugin-health`——缺哪一面是当前宿主的事实（TUI / `mica exec` 没有 `desktop`），写进所有宿主共享的健康状态会让桌面端显示别的宿主留下的「待配置」。
- `plugin-status.json` 由 `mica-plugin` 的 `writePluginStatus()` 唯一写盘（装配完成与每次启停对齐后各写一次）：记**全部**装配过的插件（官方与用户一视同仁）、写下 `host`（`tui` / `app-server`）。装配结论来自 manager 记的每插件 attempt（`setupReport()`），被停用的插件因此不会留下一条过期的「已加载」。配置页显示「已跳过 · TUI」，跳过不参与「插件坏了」的判定；没有记录时页面如实说「尚未加载」，不给官方插件编默认值。
- 属于插件、但不属于任何一次会话的操作（注册到中转机、试连接口、生成访问链接）声明成清单 `actions`，实现用 `ctx.actions.register(key, handler)`，结果是 `{ message?, link? }`。配置页在插件设置下方画按钮、就地显示结果，**不要**为此把用户跳去对话、也不要为此要求会话宿主在线：执行它的是 `mica plugin-action --plugin <id> --action <key>`，一个只装配目标插件的一次性进程（没有 agent、没有 turn）。动作通常要顺手写设置与状态文件（`ctx.settings.set()` + `plugin-data/<id>/data.json`），这样页面刷新后仍能看到结果。做不完的操作（要一串判断、要调工具）就回 `{ newSession: { prompt, send: false } }`：页面开一个新会话、把提示词放进输入框、关掉配置页，等用户按回车后由 agent 去做——提示词要能独立成立（接手的新会话看不到这里的状态）：随包 skill 用 `[skill:名字](绝对路径)` 指过去，要它落在某个仓库里做事就用 `cwd` 指定工作目录；这是与面板动作同一份 `newSession` 形状（归一化在 `mica-plugin/PluginNewSession.ts`），浏览器宿主没有会话可开时如实说「在桌面端里点」。
- 需要「一直在跑」的东西（周期轮询、心跳、增量同步）注册成 `ctx.background.register(...)`，不要自己 `setInterval`，更不要装成 launchd / systemd 服务：那种形态在插件停用后还在跑，用户以为关了其实没有。间隔用 `every: number | (() => number)` 声明，退避策略留在插件里；单轮抛错只记健康状态与日志。跟着插件一起结束的子进程在 `ctx.onDispose()` 里杀掉，状态写 `$MICA_HOME/plugin-data/<id>/`。
- 官方插件载在**每会话**的 app-server 里（会话关掉进程就退），所以「必须活得比会话久」的常驻工作不能只靠进程内循环，要由常驻任务监管一个脱离父进程的子进程；随包脚本先落盘到 `$MICA_HOME` 再用 `node` 跑（`packages/mica-pty` 的 helper 与 computer-use 的 runtime 都是这个模式），源码内嵌由脚本生成。
- 插件里**跨会话共享的数据不能拿会话 id 当身份**：档案按「这份需求 / 这个项目」存，会话只留一个指针（`ctx.sessionState`）；指针缺失或被覆盖时按稳定键认回已有档案，绝不因为换了会话（fork、重开、镜像丢失）就另起一份空的——用户看到的是「我记过的东西又没了」。
- 内置 skill 用 `ctx.skills.register()`：正文随包用 `import … with { type: 'text' }` 内嵌，元数据由 `micaSkills.parseMarkdown(SKILL.md)` 解析（frontmatter 是唯一来源），注册后与磁盘 skill 同权（prompt 索引 / `skill` 工具 / 会话能力开关）。磁盘上的同名 skill 优先，被遮蔽的条目从返回值 `skipped` 读出来并 `ctx.health.report()`。`baseDir` 必须是真能读到的目录——单二进制没有插件目录，所以随包资源要先落盘到 `$MICA_HOME/<插件目录>` 再注册（`plugins/computer-use` 是完整示例，源码内嵌由 `scripts/generate-computer-use-sources.mjs` 生成，改 `runtime/**` 必须重跑）；**正文不落盘（`baseDir/SKILL.md` 不存在）的 skill 不会进补全列表**，因为补全插入的就是这条路径。
- 注册成功的内置 skill 由插件系统顺带发布到 `$MICA_HOME/plugin-skills/<pluginId>.json`（`PluginSkills.ts`，一个插件一份、整份重写）：不 setup 插件的宿主（桌面运行时给 `/` 补全、配置页）靠这份索引列出内置 skill，不必为两个名字冷启动会话进程。索引不主动清理（多进程会互相踩），读的时候按 `plugins-state.json` 的停用名单与 `SKILL.md` 是否还在过滤——所以停用插件、卸掉插件之后它立刻从列表消失。
- 插件整块按会话角色门控时（段落、工具、技能一起只对某个角色出现），技能也要声明角色：`ctx.skills.register(skill, { roles: ['需求开发'] })`（空数组＝所有角色）。角色随条目写进索引（`version: 2`，缺 `roles` 的旧索引直接当没有），由读索引的一方按会话角色过滤——索引是全局一份、注册只发生在跑插件的那个进程里，判定只能留在读取侧。
- **随插件分发的 skill 用清单 `skills` 声明**，不要手写 `ctx.skills.register()`，也不要把正文抄到 `$MICA_HOME`：每条是相对插件目录的路径，目录里有 `SKILL.md` 就是一条 skill、否则当容器扫一层子目录（`["skills"]` 带一组、`["./skills/x"]` 带一条）。宿主按 `MicaPlugin.root` 读成运行期 skill 并发布索引，**编辑插件目录里的文件就是编辑 skill**；相对路径以外（绝对路径、`..`）在清单解析阶段就拒绝。目录读不到只报一条健康状态、插件其余能力照常启动。`ctx.skills.register()` 仍然保留给「正文来自内存/需要动态生成」的场合（`plugins/computer-use` 的源码内嵌就是这一种）。
- **随插件分发的角色用清单 `roles` 声明**（同一套相对路径规则、同样在解析阶段拒绝越界），正文是 `<插件目录>/roles/<名字>.md`。它与 `$MICA_HOME/role/*.md` 的区别只有注入方式：磁盘角色**替换** `<system>`（写的是整份系统提示词），插件角色**追加**成 `<role>` 段（只写「这个角色额外要遵守什么」）——`AgentRole.append` 标出这一条，`AgentRuntime.buildSystemPrompt()` 据此决定 `baseSystemPrompt` 与 `rolePrompt`。宿主装配时写索引 `$MICA_HOME/plugin-roles/<pluginId>.json`（`mica-plugin/PluginRoles.ts`），输入框的角色箭头（`host/chat.js` 的 `listRoles`）与 `/role`（`mica-agent` 的 `listAgentRoles`）都只读索引，不必 setup 插件；磁盘同名角色优先并遮蔽插件那条。读索引的一方要按 `plugins-state.json` 的停用名单过滤（索引要等某个宿主对齐时才清，用户刚关掉插件时那些名字不该还能切到）。改角色 = 改插件目录里的文件。
- 输入框 `/` 里的条目用清单 `completions` 声明（`[{ name, description?, insert, roles? }]`，`name` 不能带空白——`/` 后面的查询按空白截断）：选中只往输入框插 `insert` 那段文本，不执行动作，`/` 是补全而不是命令面板。写清单而不是运行期注册，是为了**没有会话宿主时也能列出来**（刚打开应用、还没跑过任何一轮）：宿主只读官方清单（编译进产物）与 `$MICA_HOME/plugins/*/plugin.json`，不导入插件入口（`host/plugin-completions-core.js`，渲染层并入 `/` 的同一套评分）。停用插件、角色不匹配都跳过；重名只留先出现的那条（用户插件排在官方前面）。
- 运行条件由清单 `desktop.checks` 声明，取值只能来自 `mica-plugin/PluginDesktop.ts` 的 `DESKTOP_CHECKS`；配置页 Settings → Plugins 的插件详情里渲染成「运行条件」一节（状态 + 打开系统设置），插件跑在 app-server 子进程里、探测不到也渲染不了。新增一种检查项 = 在 `DESKTOP_CHECKS` 登记 + 桌面端实现探测器（`src/main/system/`）。声明了它就写 `requires: ["desktop"]`。
- 运行状态由清单 `status` 声明（`key` / `label` / `type: text|link`），值由插件写进 `$MICA_HOME/plugin-data/<id>/data.json`，配置页插件详情渲染成「运行状态」一节。值是字符串或 `{ text, tone: ok|warn|error }`——插件判断语义，页面只上色；没写过的键显示「尚未上报」，不隐藏。插件详情因此不需要为每个插件各写一套状态界面。
- 「得有人点一下才会好」这类状态另写一条 `attention`（`{ text, tone: warn|error, action? }`，同一份 `data.json`）：侧栏 **Plugins** 入口与插件目录的卡片上出现一枚提示点，点进去是插件详情里的一条提示 + 清单声明过的那个动作按钮，结果就地显示。`action` 必须是清单 `actions` 里的 key，页面丢弃没声明的；没 `text` 或 `tone: ok` 视为撤销。**写不写由插件判断**——没有可执行动作的 warn（中转机不可达、本机缺产物）不该上报，一枚点不动的提示比没有更糟；解析与归一化在 `mica-config-ui` 的 `plugins.ts`，侧栏那枚点由 `renderer/src/plugin-attention.js` 每 30 秒重读一次详情。**一条提示只点一次**：页面按「插件 id + 文案」记住点开过的那条（文案里带版本号，所以换了一版是另一条），插件在动作里要把这件事记上账并抹掉 `attention`（`mobile-relay` 的 `page-notice.json`）——持续状态每次重算都重新点亮红点，等于一个关不掉的通知。
- `desktop` 能力只有桌面端 spawn 的 app-server 提供：`buildSpawnEnv` 注入 `MICA_PLUGIN_DESKTOP_HOST=1`（别用 `MICA_DESKTOP_HOST`，那是运行时的绑定地址），`runAppServer` 据此传 `desktopHost` 给 `HeadlessPluginHost`。CLI / TUI / `mica exec` 里没有它，依赖插件整块跳过。
- 桌面入口由清单 `desktop.entry`（`{ "entry": { "label": "Connections" } }`，可选 `placement`：`sidebar`（默认）是侧栏一行、`header` 是主区顶栏右侧的一枚图标按钮，文案进 tooltip）+ 插件目录里的 `desktop.jsx` 组成：`default` 导出卡片组件（props `{ api, onClose }`），可选命名导出 `summary(api)` 给入口行右侧那一行字。宿主只画一行与卡片容器（悬停/点击、浮层定位、Esc 与点外部收起都在 `renderer/src/PluginEntries.jsx`），按 id 用 `import.meta.glob('@plugins/*/desktop.jsx')` 找模块，所以**不需要在宿主里登记**。只对随包插件生效：页面是构建期打的包，`$MICA_HOME/plugins` 里没有它的模块，用户插件声明了也渲染不出入口。同一个 `desktop.jsx` 若在清单里另外声明 `desktop.page`（`{ "page": { "title": "排期" } }`），点这一行不进浮层而是打开整页：宿主把它渲染在 `renderer/src/PluginPage.jsx` 里（盖住整窗、顶部一条 `← 返回对话` + 标题，内容是插件模块自己的组件，props 同样是 `{ api }`），`App.jsx` 用 `pluginPage` 状态承接、清掉浮层的悬停展开——时间轴、看板这类要整屏宽高的界面走这条，浮层的 320px 放不下。
- 对话右侧面板由清单 `desktop.panel`（`{ "panel": { "label": "需求开发", "roles": ["需求开发"], "display": "modal", "shortcuts": [...] } }`）+ `ctx.desktop.panel({ view, action })` 组成：**插件给数据、宿主画出来**，所以用户插件也有。视图是纯数据（`title` / `status` / `statusBar` / `sections〔title, subtitle, text, rows, items, table, fields, commit, actions〕`），宿主统一归一化（长度、条目数与字段类型）后渲染，畸形视图不会让页面崩掉；四种内容各管一种事——`text` 是一整段会换行、保留段落的正文（需求描述、结论），`rows` 是「标签 — 一个值」（`wrap` 让长句 / 长路径换行而不省略，`link` 让值可点、由宿主交给系统浏览器），`items` 是一列可带按钮的条目，`table` 是几列并列的清单（`columns` 声明列，`grow` 让一列吃掉剩余宽度，`actions: true` 的那一列画 `row.actions`；格子是 `{ text, sub?, tone, link }` 或 `{ check: { checked, action } }`（`sub` 是同一格的第二行：地址、路径、上次连接的时间；主行照常染色，副行退一档，别把两件事拼成一行）——勾选列由宿主收窄居中，勾选切换带上行的 `key` 与 `values.check/column`，`keepDrafts` 保证切换不动表单里正在填的字；没有行的表整块不画，让插件用 `empty` 说话）；`statusBar.section` 让输入框上方那颗状态胶囊点开后落到指定分区；`display` 决定呈现形态——默认 `drawer` 是右侧 340px 抽屉、每个 section 一块 `CollapsiblePanel`（`collapsed` 决定初始是否收起），`modal` 是盖住整窗的弹窗、**左边分区导航（复用设置页的 `SplitView` / `split-item`）、右边该分区的详情**、**高度定死**（切分区不抖）且内容在内部滚动（内容多时别用抽屉）；`open` 声明「点了入口直接执行这个动作」而不是打开抽屉——只回答一件事的面板（手机访问那张二维码）用它，点「+」菜单那一行就把动作交给插件、按动作回包弹窗，不必为一张码先摊开一整块抽屉；有输入框的 section 用 `commit` 声明自动保存动作，宿主在输入停顿约 0.5s 后带字段值调它，设置类因此不用再点按钮；**自动提交不消费表单**——它只是把草稿同步过去，动作完成默认会按新视图把输入框归位，所以这类动作（以及任何失败后要让人改一个字再试的动作）回 `keepDrafts: true`，否则视图永不回填的输入（密码）会在停顿半秒后凭空消失；动作只回 `{ action, key?, values? }`，宿主每次动作后重新取一次视图。一个插件最多一块面板（再注册会替换）。`roles` 是显示条件（会话角色名，空数组＝任何角色）；声明了它就要写 `requires: ["desktop"]`，但**没有** `desktop.entry` 那条「只对随包插件生效」的限制。`shortcuts` 是输入框正上方那排按钮，每个四选一：`action` 直接触发插件动作（不打开面板），`section` 打开面板并展开同名 section，`items` 是一组写死的子项（悬停/点击展开：「频道」→ 同步频道 / 频道设置），`menu` 的**表格**来自视图的 `menus[menu]`（`{ columns, rows: [{ key, action, cells }] }`：会话事实现算，「PR」→ 这个需求涉及的项目 / 端 / 分支，点一行就评审那一条）——常用动作、配置项与按状态变长的入口因此各走各的路，不用挤进一块抽屉；动作可以 `return { message }` 回一句话，页面显示在按钮旁边（常驻宿主里 `ctx.ui.notice` 用户看不到）、回 `{ compose }` 把文本放进当前会话输入框（不发送）、回 `{ newSession: { prompt, role?, cwd?, confirm?, send? } }` 开一个新会话跑这段提示词（默认先弹窗让用户看见并编辑，点开始才发；`send: false` 只把提示词放进输入框、等用户按回车，指令类动作不该由插件替人按发送）、或回 `{ dialog: { title, subtitle?, text?, qr?, columns?, rows?, note?, configure? } }` 弹一个只读弹窗（`qr` 是一段二维码，插件只给 `{ value, caption? }`、编码与静区归宿主；`text` 是会换行的正文；`columns` + `rows` 给对齐的表格，格子 `{ text, link? }`，带 `link` 的交给系统浏览器打开；三者可以单用也可以叠；`configure: { label? }` 在底部多一个打开**这个插件自己的设置页**的按钮，「还没配好」的弹窗用它把人送过去，`panel: { label? }` 同样是个按钮但打开**面板**（弹窗只回答最常问的那件事，首次部署这类细节仍留在面板里）；两者之外纯展示、编辑仍回面板 section）、或回 `{ openPath: { path, line?, focus? } }` 让宿主把这个文件在应用里打开（下同）、`{ openReview: { cwd, base?, head?, label? } }` 让宿主盖一层**整窗评审视图**：`head`（缺省取那个目录当前检出的分支）相对 `base`（缺省按仓库主分支解析：`origin/HEAD` → `main` → `master`）在分叉点上比，左边文件、右边 diff。两边都只从提交里读（`git:ref-summary` + `git:file` 的 `refs` 模式），**不读工作区、也不改会话目录**——评审别人的分支不会把评审人自己的未提交改动混进来，副本目录被系统清掉也不影响，关掉就回到原来的对话。`cwd` 是副本目录而不是会话工作区（它只提供仓库位置，评审层不加载副本的文件树；面板只有 340px，插件自己的配置、随包分发的 skill 这种超过一屏的正文在那里既看不清也改不动，编辑交给宿主已有的能力）——面板只有 340px，插件自己的配置、随包分发的 skill 这种超过一屏的正文在那里既看不清也改不动，编辑交给宿主已有的能力；建会话、摆页签、控制发送时机、弹窗排版都由页面负责，插件只声明意图；动作改到的 `ctx.sessionState` 由宿主在动作返回后补一次会话落盘，插件不用自己触发保存。
- **界面控件只有一份**，在 `@mica-config-ui/web`：按钮 `Button`（`variant` + `size="compact"` + `fullWidth`；`primary` 是抬起的灰底、`accent` 是实心强调，对话框主操作（确定 / 开始 / 保存）用 `accent`，行内动作用 `ghost`、破坏性的用 `danger-ghost`）、状态 `Tag`、空态 `Empty`、错误 `Alert`、开关 `Switch`、勾选 `Checkbox`（带 `mixed`）、下拉 `SelectMenu`（可 `filterable` / 分组 / compact）、日期 `DateField`（可打字 + 自绘月历）、分段 `Segmented`、数据表 `DataTable`（列定义 + 受控排序 + 翻页 + 窄容器退列，单元格内容由调用方渲染）、输入框样式类 `text-input`（密集工具栏加 `is-compact`）、行 `SettingRow`、分组 `SettingsGroup`、折叠 `CollapsiblePanel`、`SecretInput`。样式全部限定在 `.mica-config-ui` 作用域内，宿主负责套这一层：插件整页（`PluginPage`）与插件入口卡片（`PluginEntries`）已统一套好，面板视图本身由宿主渲染。**禁止原生 `<select>` / `type="date"` / `type="checkbox"`**：它们的弹层与外观由系统绘制，在浮层和内嵌视图里会飘出控件、几百个选项时铺满整屏，也和旁边的共享控件对不齐；也确实存在不了的形态（多行截断的行按钮、页签、导航项）才用结构化 `<button>` + 自己的布局类，而不是重画一个按钮控件。要新控件先加到 `web/components/Ui.tsx`（或同目录的独立组件）再从 `web/index.tsx` 导出，别在页面、面板或插件里各写一套——同一应用里三种按钮高度比样式不统一更糟的是每次改都要改两处。
- 插件前端模块用到的 Tailwind 工具类必须被扫描到：`plugins/` 不在 `apps/desktop` 下，`app.css` 里用 `@source '../../.../plugins'` 显式纳入，否则插件里的间距、`group-hover/*`、`max-md:*` 一个都不会生成（表现为间距全塌、悬停不出现）。
- 插件清单的 `name` 与 `desktop.entry.label` 一律英文（侧栏其它入口也是英文），描述这类正文才写中文。
- 插件前端模块的能力就这几件，来自 `renderer/src/plugin-host.js` 的 `createPluginHostApi(pluginId, session)`：`currentHost()`（页面所在运行时的 origin）、`probe(address)`、`readData()` / `writeData(value, options?)`、`open(url)`、`access`（读改写这台机器的远程访问策略）、`action(key)`（执行清单 `actions` 里声明过的动作，宿主转给一次性插件进程 `mica plugin-action`；卡片要「真的干一件事」时用它，不要用 `writeData` 伪造一个请求位再等后端轮询，没声明的 key 会被拒绝，卡片能做的动作与配置页的按钮是同一份声明）、`session`（页面正在看的那条会话：`id()` / `sessionId()` / `cwd()`、`state.read()|write(value)|subscribe()` 读写插件自己的会话级状态（`pluginState[pluginId]`，与 `ctx.sessionState` 同一份，走 `mica/sessionState/get|set`）、`onIdle()` 在这一轮跑完时回调——模型在轮次里写下的状态只能在这一刻重读）。`session` 为 null 表示当前没有打开的会话，卡片要如实画空态。探活、数据读写、访问策略与动作必须由运行时代劳（页面读不到跨源响应、碰不到请求分派、也没有文件系统），落在 `host/plugin-host.js` 的 `plugin-host:probe` / `plugin-host:read-data|write-data` / `plugin-host:access-get|set` / `plugin-host:run-action`；数据文件统一在 `$MICA_HOME/plugin-data/<id>/data.json`，宿主不解析结构。读取返回 `{ value, version }`，缺文件两者为 null、IO 失败显式报错；读改写可带 `{ expectedVersion }`，宿主在跨进程锁内比较版本并原子替换，冲突返回 `{ ok: false, conflict: true }`，插件重读并只重放本次修改。`open` 是纯页面行为，分支在 `shell-env.js` 的 `isElectronShell`。
- 卡片宽度默认 320px，插件模块可以 `export const card = { width }` 声明更宽的（夹在 240–960）；长文编辑这类在 320 里放不下的界面用它，宿主只负责尺寸与浮层定位。
- 设置项在清单 `settings` 里声明，类型 `text` / `password` / `textarea` / `select` / `number` / `switch`；数字项可带 `step` 与 `unit`，开关值只能是 `"true"` / `"false"`。值存 `$MICA_HOME/plugin-settings/<id>.json`，读取按 mtime 判断是否变化。
- 校验只有 `validatePluginSettingValues()` 一处：写盘前拒绝，插件读值时同样过一遍；非法值既不落盘也不静默通过。
- 插件自己拿到值（注册换回的口令、探测到的地址）就用 `ctx.settings.set()` 写回去，只改传入的键、其余保持原样，写盘前过同一份校验——不要要求用户复制粘贴，那正是最容易出错的一步。
- 需要按会话调整的项标 `perSession`：默认值仍是 `settings`（配置页写），会话里只存**改过**的键（`pluginSessionSettings[pluginId]`），没改过的继续跟随默认值。插件读 `ctx.sessionSettings.get()`（合并后的生效值），界面由 `mica/pluginSettings/get|set` 驱动，桌面端从会话设置→插件进入。只存改过的键是硬约束：整份存会把当时的默认值固化进老会话。
- 用户可见故障（缺配置、外部服务拒绝、请求失败）必须 `ctx.health.report({ level, message, hint })`，不能只写日志。记录带上是哪一版插件写的（`createPluginHealthStore` 的 `version`），读的一方传 `version` 就只认这一版：升级之后上一版留下的「连不上 X」不该继续挂在页面上。装配失败（setup 抛错、入口加载不了）不属于健康状态——那条走 `plugin-status.json`，卡片上写「加载失败」；健康状态 `error` 写「运行出错」。
- `ctx.logger` 按 pluginId 注入，同时写 `resolveLogDir()/plugin-<id>-<day>[-n].jsonl`（macOS `~/Library/Logs/mica`，2 MB 分片、7 天清理、`MICA_PLUGIN_LOG=0` 关闭）。排查插件问题先看它。
- 插件感知会话用 `ctx.session`：`describe(owner)`（含 `cwd`，按工作区归档的插件读它而不是缓存进程 cwd）、`messages(owner)`、`rename(title, { owner, source })`；`source: 'auto'` 在人工命名过时被拒绝。
- 宿主形态由 `ctx.agent.mode` 回答（`session` / `one-shot`，后者是 `mica exec`），与迭代重写句柄上的同名属性一致；会改变成本或输出的策略只在 `session` 生效。
- 影响模型请求的插件用 `ctx.agent.onIterationRewrite(handler)`：在迭代边界改写接下来要发送的历史。句柄只暴露 `sessionId`、`mode`、`lastUsage()`、`getState()` / `setState()`、`compact()`。
- 同一能力面的另一半是 `ctx.agent.compactIdleHistory(options?)`：在轮次之外把已落盘的历史快速压一次（本地清理，不调模型）。它由宿主提供（`HeadlessTurnExecutor.runIdleMaintenance` 取 turn lease → 对齐磁盘 → 调 `compactIdleSessionHistory` → 落盘），结果只有 `applied` / `skipped`（`busy`：会话忙或别的进程持锁；`empty`：没有可清理内容），两者都不算错误、不消耗次数。要在压缩结果旁边一起落盘的写入（计数、`ctx.ui.notice`）放在 `options.afterApply` 里——宿主在落盘**之前**调它，所以是同一次写；等 `await` 返回后再写，只能等下一轮（用户可能已经关掉页面）。`mica exec` 不落盘、TUI 走 `/compact`，两边都不提供，插件必须当可选能力。
- 轮次之外判断「现在多大」用 `ctx.agent.lastUsage()` 与 `ctx.agent.contextWindowSize`（与界面上那个 ctx 徽标同源、随会话切模型变化），不要让插件自己估历史：`lastUsage` 是最近一次真实请求的输入量，压缩保留它（Stats 对账口径），所以压完再读不会立刻变小。
- 要占住会话几秒的耗时工作（模型摘要）用 `ctx.agent.withMaintenance({ reason, label }, task)`：窗口开着时宿主通知客户端「别急着发」，用户这段时间的发送留在客户端的排队行里（可见、可撤回），窗口结束后由客户端补发。只由能跟客户端说话的常驻宿主提供（`mica app-server`），TUI / `mica exec` 里没有，插件写 `agent.withMaintenance ? … : await task()`。官方用法是自动压缩的模型摘要那一步（`reason: 'compaction'`、`label: '自动压缩'`）；本地快速压缩很快，不开窗口。
- 委派子代理用 `ctx.subagents`：`registerType()` 注册类型（工具白/黑名单、写策略、`maxTurns`）、`run` / `background` 跑一个、`tasks.list|get|kill|wait` 管后台任务、`caller(context)` 解出本次调用所属的委派来源。机制（建子代理、用量记账、路径租约、完成回注）在宿主，策略（有哪些类型、工具形状、什么时候委派）在插件；子代理类型挂在注册它的插件名下，插件停用即消失。
- 需要「可复用的隔离子代理」（旁问、连续追问）用 `ctx.subagents.thread({ type, systemPrompt, tools, allowedTools, disallowedTools, model, maxTurns })`：一次建线程、多次 `ask()`，同一线程串行（并发 ask 直接报错）、可用 `usage()` 读请求数与最近用量、`dispose()` 收尾。线程不占 `tasks`、不拿路径租约、绑定 `ask` 当时的当前会话；每次 ask 的用量由宿主以 `origin: 'plugin'` 记进会话 `subagentUsageHistory`。system prompt 是整体替换，插件要自己带上它需要的上下文。
- 命令结果给用户看走 `ctx.ui.notice(content, { command, status, surface, variant })`：`surface: 'command_panel'` 是输入框上方的运行中面板（被同一 `command` 的下一条 notice 收尾），默认进对话的 notice；headless 宿主直接落进 turn notice 日志。
- 插件自己问一次模型（起标题、写提交说明、整理记忆）只声明 `plugin.json` 的 `llm`，代码里用 `ctx.llm.request()`：接口地址 / Key / 协议 / 模型由声明生成（`group: 'llm'` 的普通设置项）。每个声明 `llm` 的插件都自带「复用当前会话模型」开关，**缺省就复用会话模型**（插件不声明也不需要声明；只有必须先用自己的接口才好用的插件把清单的 `reuseByDefault` 写成 `false`）。复用由宿主解析成当前会话的 provider（会话钉住的优先，其次模型名的 `provider/model` 前缀），选中时自己的四项在界面上隐藏。请求走 `ctx.llm` → `ctx.models` → `mica-agent/modelText.ts` + `apps/cli/src/plugins/pluginModels.ts`，协议分支、超时中断与用量记账只有一份实现，记录以 `origin: 'plugin'` 落进会话的 `subagentUsageHistory`，并作为一条 `plugin-llm` helper 运行进观察流；配置页的「测试连接」用同一个执行器（`probeModelConnection`，不记账也不进轨迹）。插件里不自建模型 HTTP 客户端，也不自己拼地址 / Key。
- 模型配置的界面只有一份：`mica-config-ui` 的 `LlmSettingsSection`，配置页插件详情与桌面端会话设置都渲染它（会话里带逐字段「跟随默认」，摘要写当前会话会用的模型）。新增宿主入口时复用它，不要再写第二套模型表单；插件也不自带模型配置组件。
- 插件配置的模型不可用时 `ctx.llm` 自己降级：用当前会话的模型（配置文件里的 provider/模型，会话里切过就是会话自己的）把这次请求重发一次，成功后记住这份配置（改任意一项就重新尝试），降级原因以 `warn` 上报 `ctx.health`、`describe()` 标「已降级」。abort 不降级；已复用会话模型且没点名模型时没有第二目标，直接抛错。降级是组件行为，插件不写 `try 自己的 → catch 换会话模型` 这一套。
- `llm` 的键（`useMainProvider` / `baseUrl` / `apiKey` / `protocol` / `model`）不允许再在 `settings` 里重复声明；`required` 只在关掉「复用当前会话模型」后生效（`requiredWhen`）。复用时隐藏的四项也不参与请求、摘要与试连，只有单次 `ctx.llm.request({ model })` 可以显式覆盖模型。
- 会话右键菜单由清单 `desktop.sessionMenu`（`[{ "label": "复制会话 Markdown", "action": "copy" }]`）+ `ctx.desktop.sessionMenu({ run })` 组成：**菜单项来自清单、处理器来自插件注册**——右键是同步交互，不能为「有没有菜单项」去冷启动 app-server；处理器只活在插件所在进程里，页面只转发 `pluginId + action`。`run()` 只认 `copyText`（页面写系统剪贴板：插件进程里没有剪贴板，也不该为三个平台各调一次系统命令）与 `message`（回给用户的一句话）。动作要立刻返回，不要在里面等模型请求。声明它就要写 `requires: ["desktop"]`；用户插件同样有。
- 官方插件：`todo`（进程内待办 + `plan` prompt 段落，计划纪律在 `plugins/todo/prompt.ts`，`requires` 含 `prompt`）、`btw`（`/btw` 旁问：`ctx.subagents.thread` 开一条可复用的隔离子代理，结果经 `ctx.ui.notice` 呈现）、`session-notes`（会话笔记）、`session-tags`（会话颜色标签）、`session-copy`（会话右键菜单「复制会话 Markdown」：`plugins/session-copy/markdown.ts` 确定性拼装标题 / 路径 / 模型 / 用户与助手正文，工具调用、思考与 notice 都不进导出，**不调用 `ctx.llm`**）、`session-rename`（每轮前自动起标题）、`auto-compact`（自动压缩）、`memory`（跨会话记忆，按**适用范围**分三层：`profile`（用户本人，总是注入）/ `domain`（`domains/<名字>.md` 头部 `match` 声明覆盖哪组同域仓库）/ `project`（按仓库身份归档：`repo.ts` 纯 fs 读 `.git`、worktree 的 `commondir` 与 `origin` 地址，不 spawn git；无 git 时只认带项目标记的当前目录）。**只注入当前会话适用的层**，没有适用条目时整段不出现；存储不设写入上限（20 000 字符失控保护），注入按层预算挑选、`! ` 前缀优先。**项目记忆跟着「实际在改哪个仓库」而不是 cwd**：`activity.ts` 从 `agent:observe` 的 `tool:call` 参数认路径（写 3 / `cd` 2 / 读 1，同一次调用按 slug 去重），权重 ≥2 的非 cwd 仓库（最多 2 个）注入，最高者成为工具省略 `repo` 时的默认写入目标，模型也可用 `memory({ repo })` 显式指定。`memory` 工具默认最窄作用域；整理器（`curator.ts`）过三道测试、默认最窄、**不允许写 profile**、不能新建领域，领域只能由 `/memory domain new` 创建，操作可带 `repo` 决定归属。会话内冻结，`/memory refresh` 或作用域变化（`/cd`、认出新目标仓库）才重读。整理可走宿主子代理，也可配独立接口地址 / Key / 协议 / 模型）、`web-search`（`web_search` 工具）、`video`（`video_frames` 工具：按时间点抽帧，走已有的多模态图片链路，内核零改动。**可寻址单位是时间不是帧序号**——下一轮的模型看不到上一轮返回的图片，`at:["1:03.5"]` 才自洽。不给 `at` 时按画面变化取样，不是均匀撒点：把视频降到 96×54 灰度逐帧求差（ffmpeg 自己的 `scene` 分值对深色终端录屏只有 0.016，完全不够用），静止为主的画面用噪声底线判切换——**不能按峰值折算阈值**，一次剧变（切窗口 0.89）会把同一视频里其他真实转场（0.0006）全吞掉；切换点要往后挪 0.25s 再取帧，差异最大的那一刻正是转场中间态（实测取到一整张纯白）；切换点比帧数多时按时间分桶、段内取变化最大处，只挑最剧烈的会把帧全挤到后半段。整段帧差都在噪声底以下（静止录屏、单页幻灯片）时只给首尾 1–2 帧并说明，别发四张一样的图（每张约 790 tokens）；段数少于请求帧数时如实给段数，硬凑只会重复某一段。`start`/`end` 只扫描那一段（长录屏看某 10 分钟），扫描 fps 按区间长度自适应以覆盖整段而不是只扫开头；`-ss` 落在最后一帧之后时 ffmpeg 一帧都取不到，采样上界按 `max(0.1s, 2/fps)` 往回退，极短视频（单帧导出）只取开头；帧按「真实路径 + 大小 + mtime」缓存在 `plugin-data/video/frames/` 并做容量 LRU，同一视频追问第二次不起子进程（536MB 4K 首次 5.1s、缓存 66ms）；依赖本机 ffmpeg，缺失时上报健康状态并给出可行动的报错）、`subagent`（7 种子代理类型、`agent` 工具、委派 prompt 段落与委派倾向设置）、`evolution`（旧数据清洗：启动后与之后每轮轮询，把 `$MICA_HOME` 下变过的会话就地改成当前形态；`/evolution status|run` 查看与手动触发。迁移规则的唯一来源是 `plugins/evolution/migrations.ts`，改了持久化形态就往里加一条，运行时代码不保留旧形态分支；账本与备份在 `plugin-data/evolution/`，每台机器各跑自己那份）、`commit`（`/commit` 命令：确定性 git 分析 + 一次模型请求写提交说明 + add / commit / push；模型可复用当前会话，也可单独配接口地址 / Key / 协议 / 模型）、`computer-use`（macOS 桌面自动化 skill：AX 元素树 + CGEvent 键鼠 + 截图，随包 runtime 落盘到 `$MICA_HOME/computer-use`，首次用到时 clang 编译 helper；权限状态显示在配置页插件详情的「运行条件」里）、`connections`（侧栏 `Connections`：接另一台机器上的运行时，连接清单存 `plugin-data/connections/data.json`；能力全在 `desktop.jsx`，后端 setup 是空的）、`schedule`（本地排期，与任何聊天工具无关：数据就是 `plugin-data/schedule/data.json` 里的一串任务，每条有名称、起止、颜色与 Markdown 备注，同色的任务排在同一行。侧栏 `Schedule` 开整页甘特图：工具栏改标题 / 日周月 / 缩放 / 今天 / 新增任务 / 导入导出清空，空白处点或横拖新建、拖条体 / 两端改期、点条开弹窗改名称颜色备注，滚轮缩放（锚点换算在 `gantt.ts`）、Shift+滚轮平移，别处的写入 15 秒轮询进来；模型经 `schedule` 工具（`list` / `add|update|delete_task`，按 id 只改一条）与随包 skill `schedule` 读写同一份数据。写盘共用一把跨进程锁：工具侧「现读 → 改一条 → 原子写」（`store.ts`），页面侧按版本比较、冲突时把这条操作重放到最新数据上（`writer.ts`），所以拖动、另一个窗口、模型同时改不会互相覆盖；旧的两层数据（`plans` / `stages`）读取时迁移成扁平任务（计划名并进任务名、计划备注放在第一条））、`sidecar`（派生并驱动子会话：随包 skill `sidecar` + 9 个 `sidecar_*` 工具，每个子会话是一个 `mica app-server` 子进程，`--parent` 写进会话文件让侧栏嵌套；事件走 Codex v2 JSONL，投影在 `plugins/sidecar/transcript.ts`，分层的读法在 `views.ts`；不传 `role` 时继承父会话角色，深度由 `MICA_SIDECAR_DEPTH` 限制在 2 层，子进程在 `onDispose` 里一路降到 SIGKILL 收掉）。、`ssh`（让模型操作远端服务器：系统 OpenSSH + 主机清单（面板里按「密码 / 私钥」两种认证方式填：用户名默认 `root`、别名可用中文、密码留空表示沿用已存的那个，口令存 `plugin-data/ssh/secrets.json` 的 0600 明文、只给插件自己读，模型只拿得到别名）+ **按会话的范围**（服务器表里两列勾选：「添加到会话」存会话快照的 `pluginState.ssh`，「自动添加到会话」是新会话的初值；prompt 与 `ssh_*` 工具只认本次会话里的机器，没有全局开关）+ 主机指纹固定 + `ssh_run`（多行脚本）/ `ssh_read`（只读、可多台并发）/ `ssh_session`（持久 shell，长任务分段取结果）/ `ssh_hosts`；ControlMaster 复用连接，输出默认只回尾部、全文在远端 `/tmp`，调用记 `plugin-data/ssh/audit.jsonl`）
- 新增插件：建目录 → 两处登记 → 测试放插件目录内（vitest 覆盖 `plugins/**`）。
- 运行观察走通用 `agent:observe` hook（`AgentObservationEvent`，owner/runId 关联）：运行开始/终态、请求边界（`request:start` / `request:end`：耗时、首字延迟、重试次数、tool 数）、最终 prompt、工具调用/结果、用量、重试、历史改写与压缩（`compaction`：策略 local/llm/idle、原因、前后条数与字符、是否真的改了历史）；委派运行带 `delegation: { type, parentSessionId }` 且 runId 取负数，与父运行分开。不在任何一轮里的工作同样在范围内：`createSubAgent` 与 `startHelperRun` 给它们补上负数 runId 的一对 run 事件、请求边界与用量（分类见下一条）。观察失败不得中断任务。
- 「这次回答没被接受」只认用户动作，不认模型自评：宿主把改写重跑、撤回排队消息翻成运行时事件 `input:corrected`（`kind: edit|recall`，撤回没取回时不发），插件自己决定怎么用。
- 不在任何一轮里的工作也算观察对象，只是分类不同：`run:start.helper: { kind, pluginId?, purpose? }` 标出压缩摘要（`compaction`）、旁问线程（`thread`，带 pluginId）、桌面 BTW（`btw`）、插件经 `ctx.llm` 问模型（`plugin-llm`）。它们与主运行一样有 `request:start` / `request:end` / `usage` / `run:finish`（`createSubAgent` 与 `startHelperRun` 都从同一条包装路径发事件），runId 取负数。归并成本必须按 `helper.kind` 分开：「自动压缩每次摘要 40 秒」和「某一轮慢」不是一件事。helper 运行不参与「用户重试同一任务」的推导——它的输入是压缩用的 transcript 或插件自己的文本，拿它跟上一轮用户输入比相似度必然误报。
- 插件自身的运行事件（常驻任务失败）走 `plugin:observe` hook（`PluginObservationEvent`，宿主在 `ctx.background` 的任务抛错时 `hooks.notify`）：它不属于任何一条 run，硬塞进去会让那条 run 的耗时与失败原因都变假。`agent:observe` 仍然只描述一次运行的起止与过程。
- 仍然**不覆盖**：插件装配结果（读 `plugin-status.json` 快照；装配失败与跳过是宿主事实，不是运行事件）。官方 `harness-review` 插件异步写 `$MICA_HOME/plugin-data/harness-review`，通过 `/harness-review list|report|prune|rebuild|assess` 和 `harness_review` 查看、导出、清理、重算、记录人工评估；按 cwd 复盘（helper 运行不进 Runs 表、单独按来源汇总；插件常驻任务的失败是机器级事实、不随 cwd 过滤），不自动修改 harness。报告的「Waiting / first token」列读 `request:end`——老摘要没有它，如实显示 `—`，不要用整轮时长冒充。
- 问题信号的精度是这类插件的核心，宁可少报也不要误报：非零退出码按**命令语义**判定（`rg` 无匹配、`ls`/`test` 找不到、`diff` 有差异不算工具错误，计入 `expectedExits`；`rg` 退出 2、`bun test` 退出 1 仍是真错误），决定 `$?` 的是链式命令的最后一段与管道的最后一个命令；重复调用只在结果逐字节相同且中间没有写操作时报，轮询类工具整个排除。findings 是派生数据，实时写入与 `rebuild` 重放必须共用同一份推导逻辑，`CLASSIFIER_VERSION` 变化后常驻宿主自动重算一次；摘要记 `hostPid`，复盘前按进程存活（早期记录按摘要静默时长）把僵尸运行回收成 `interrupted`。

### 数据演进与旧数据清洗

**改了持久化形态（会话字段、用量记录、插件数据布局、目录结构、配置键）时，同一次变更里必须做三件事**：删掉运行时代码里的旧解析 / 回退 / 兼容分支；在 `plugins/evolution/migrations.ts` 追加一条迁移；更新 `plugins/evolution/README.md` 的迁移表。三者缺一，旧数据要么读不出来，要么永远留在旧形态里慢慢被新代码当成脏数据。

- `evolution` 是官方插件（`plugins/evolution/`），启动后立刻跑一轮、之后按设置项轮询，把 `$MICA_HOME` 下变过的会话文件就地改成当前形态；`/evolution status|run` 查看与手动触发。账本在 `plugin-data/evolution/`，**每台机器各跑自己那份**——另一台装着 mica 的机器不会因为这边洗过而跳过。
- 一条迁移是纯函数（`Migration.apply(document)` 返回改动记录数），只允许**幂等**、**只增补或改名不删用户数据**、**只看文档本身**。不满足这三条就不要写迁移，先设计形态。
- 清洗的执行约束在 `plugins/evolution/run.ts`：只处理签名（size+mtime）变过的文件、拿到该会话的 turn lease 才动、单轮有数量上限、每 15ms 让出事件循环、写回走临时文件 + 原子重命名、改动前留首次备份（7 天）。新增迁移不需要改这里。
- 一次性、无法就地转换的形态（需要联网确认、需要用户决策）不写迁移：删掉兼容代码，在本文与插件 README 里写明「这个形态不再支持」，让用户重来而不是让代码长期背着旧分支。
- 统计 / 派生数据（`desktop-stats-index.json`、`session-index.json`）不写迁移：它们是可重建缓存，按签名或版本自动失效。

### 命令

- 命令实现放 `mica-builtin-commands/commands/`；装配放 `plugins/command-*.ts`，统一经 `index.ts` 导出。
- `/commit` 由官方插件 `plugins/commit/` 提供（TUI 里执行，可通过 `--dir` 之外的入口无参调用）。`mica commit`（CLI）与桌面右键 commit 都经 `apps/cli/src/cli/runPluginCommand.ts` 以一次性插件命令执行：只装配 `commands` / `events` / `settings` 这一层插件宿主，不建会话、不启 agent、不记账。
- 命令可以用 `CommandResult` 的 `message`（给用户看的一句话）与 `data`（结构化结果，`mica commit` 直接打印成 JSON）回报执行输出。
- `/capabilities` 管理本会话 Tools / Skills / MCP 三页签开关（运行中拒绝提交，逐项切换）。工具分组由 `mica-tools/registry.ts` 的 `TOOL_FAMILY_LABELS` 唯一定义：只认声明过前缀的工具，至少两个成员才成组。
- 工具名一律 snake_case 全小写；历史遗留名登记在 `mica-common/toolNames.ts`，读取处统一过 `normalizeToolName`。
- 只在会话里注册的工具（`agent`、`todo_write`、`session_peers`、`session_notes`、`harness_review`）在配置页/设置页由 `RUNTIME_TOOL_DESCRIPTORS` 兜底列出，改描述要同步 `runtimeToolDescriptors.test.ts`。每条描述带 `pluginId`：注册它的插件停用时 `getToolCatalog()` 跳过这一行。真正装配插件的宿主（TUI、`mica app-server`）在 setup 之前还会调 `micaTools.setRuntimeToolFallback(false)` 整块关掉兜底——那里注册表就是唯一事实来源，否则停用一个插件之后它的工具仍会被静态描述补回目录（用户在能力面板里看到「关掉了却还在」）。配置页 / 桌面设置页这些不加载插件的宿主保持开启。
- quick commands 另由 `apps/cli/src/plugins/commands/index.ts` 注册；新增/删除时检查两条路径与 README。
- 通过 `CommandRuntimeServices` / active proxy 注入依赖；耗时且改状态的命令走 exclusive task。
- turn 运行中是否可执行由注册时的 `allowDuringTurn` 决定；exclusive task 期间仅 status、task、agents、new。

### 工具与 PTY

- `mica-tools` 是唯一 registry，产品工具优先经插件 `ctx.tools.register()`；新增工具继承 `MicaTool`，声明 schema、展示、错误格式与 `readOnly`。
- `readOnly` 分类受 `MicaTool.test.ts` 约束：纯查询为 true；写文件、patch、shell、kill、PTY、wait 为 false。
- 执行类工具按「启动 / 等待 / 查看」拆开：`run_shell` 只跑前台命令（≤120s）；`background_tasks_start` 启动并立即返回 id；`wait_for` 只观察条件。
- `overlappable: true`（`wait_for` / `pty_wait`）或 `canOverlap(input)`（`agent` 仅 await/join）表示可与同消息其余调用重叠；加入前确认无写副作用。
- PTY 由懒启动的 Node helper（`mica-pty/src/server.mjs`）承载；改 `server.mjs` 后跑 `bun run scripts/generate-pty-server-source.mjs` 同步 `ptyServerSource.ts`。
- Todo（`plugins/todo/`）是「本轮计划」，不写 session 快照。宿主只渲染、不改写模型给的状态：turn 结束既不把 `pending` 升成 `completed`，也不把 `in_progress` 退回写进数据。**显示边界也是轮次**：`resolveTodoPanel` 只在清单所属那一轮还在跑（或用户 `/todo show` 手动打开）时返回 `visible: true`；turn 正常完成即收起，中断 / 失败则保留最近清单并暂停显示进行中，下一轮开始前从 checkpoint 读回进度。desktop 从历史里的 `todo_write` 工具行投影，必须校验 `turnId` 才能避免旧计划一直挂在页面上。解析归一化、投影、显示规则唯一实现在 `mica-common/todoState.ts`，TUI 面板与 desktop dock 共用。执行期只做归一化（未知字段忽略、多个 `in_progress` 降级、超长截断），不拒绝整次调用。
- 中断后的进度必须让模型也看得见，而不只是界面：工具批次里 `todo_write` 可能已经执行、其余调用尚未提交到 provider 历史就被打断。因此每次写入都原子落盘到 `$MICA_HOME/todo-checkpoints/<sessionId>.json`（`version` / `sessionId` / `turnId` / `items`，写路径不合法就拒绝），下一轮 `turn:before` 读回，`ctx.agent.onIterationRewrite` 以**一条 system 消息**（`<mica-todo-recovery>`，先删掉上一条再按需追加）附给模型——不写进用户消息、不改 `conversationMessages`。会话归属由 `bindTodoSessionOwner()` 解析（现场取 id，resume 换会话即失效），`mica exec` 这类不落盘的宿主关掉 checkpoint（`setTodoPersistenceEnabled(false)`）。标记本轮已正常完成的 `turnId` 存在会话 `pluginState['todo']`，所以重开应用后不会把已完成的一轮当成中断。
- `session_notes` 工具只改内存（`pluginState['session-notes']`），落盘交给本轮 checkpoint。

### MCP 与 Skills

- `mica-mcp` 管理 `config.json.mcpServers` 生命周期；读取时展开 `url` / `headers` 里的 `${VAR}` 与 `${VAR:-默认值}`，`command` / `args` / `env` 不展开。
- 会话能力目录（`mica/capabilities/get` 的 `mcpServers`）由 `micaMcp.catalog()` 合并三处：用户配置、会话自己的 `--mcp-config`、已连上的 server。桌面端把受控浏览器 / 终端挂进 `--mcp-config` 而不写用户配置，漏掉第二处界面上就看不到也关不掉它们。
- MCP 工具名由 `mcpToolNamePrefix()` 生成；按 server 关闭时用前缀匹配，断开/重连失败同步清理并刷新 registry。
- headless 显式初始化/关闭 MCP，支持独立配置与超时参数。
- skills 只扫描解析缓存、不执行；扫描 `$MICA_HOME/skills` 与项目 `.mica/skills`、`.agents/skills`、`.deveco/skills`、`.agent_context/skills`；未设 MICA_HOME 时额外共享 `~/.agents/skills`、`~/.config/deveco/skills`。插件注册的内置 skill 与磁盘 skill 合流在同一份 `getLoaded()` 里（`registerRuntime` / `clearRuntime`），磁盘同名优先；`parseMarkdown` 是内嵌 SKILL.md 取元数据的唯一入口。
- skill 是含 `SKILL.md` 的目录；内容不能覆盖安全规则、系统指令和当前用户请求。
- 联网：`web_search` 由 `plugins/web-search` 提供（设置 `searxngUrl` → `SEARXNG_URL` → `http://127.0.0.1:8080`，实例须开 JSON，结果缓存 5 分钟）；`web_fetch` 是内置工具。
- 最新、官方、API、价格、法规这类可变事实先联网查证；无法查证时明确说明。

## 8. 多 Agent、压缩与循环

### Subagent

- 委派能力本身是插件 `plugins/subagent/`：`agent` 工具、7 种内置类型、委派 prompt 段落都在插件里；内核只留机制（`ctx.subagents`，实现在 `apps/cli/src/agents/PluginSubagentHost.ts` + `SubagentTaskManager.ts`）。停用该插件后既没有 `agent` 工具，也没有提示词里的委派指引。
- 内置类型：general-purpose、Explore、Implementer、Reviewer、Tester、Planner、Proposal；`maxTurns` 唯一默认值在 `plugins/subagent/definitions.ts`（999：截断一次要重做半成品，代价比多跑几轮高）。
- `SubagentTaskManager` 按 owner 隔离任务与 abort signal，任务记录带 `pluginId` 供 `ctx.subagents.tasks.*` 收窄；后台完成元数据回注 owner，结果显式 read/await。parent Ctrl+C 同步中止其运行中的子代理。
- 常驻宿主持久化子代理记录到 `$MICA_HOME/subagent-tasks/<sessionId>.json`（`mica-common/subagentState.ts`；旧形态 `subagent-tasks/<sessionId>.json` 单文件读一次即迁移），每轮按 owner 只写变过的那条。resume 时 `restore()` 把记录读回来供详情与重启使用，`status: running` 只在该进程确实已退出（`ESRCH`）时才降级成 failed——PID 复用与权限错误一律当作仍在跑。恢复的只是记录，执行句柄、abort signal 与 timeline 现场不恢复。
- 重启不是「继续上一次执行」，是**用原任务和最近活动作上下文新起一个任务**：`mica/subagentTasks/restart` → `SubagentTaskManager.restart()` → 插件的 restart handler 重新过工具白名单、写策略与路径租约，成功后才创建替代任务。跨进程只允许一个进程重启同一个任务：`claimSubagentRestart()` 用不可变世代文件 + 原子硬链接占位，`commitSubagentRestart()` 把完整替代任务记录与提交标记用一次 `link` 发布，`releaseSubagentRestart()` 只在确实失败时释放；持有进程崩溃的 claim 可被下一个进程接管，已提交或已释放的不能被再次占用。重启失败要释放已申请的租约并允许重试。
- 前台委派默认阻塞，同消息多个调用可并行；需要主流程继续时用 `run_in_background: true`；每 owner 合计并发上限 4。
- turn 结束即收尾它起的后台子代理（`killRunningForOwner(owner, 'Parent turn finished.')`）：这一轮已经交付，结果只能经 `agent operation=read` 取回，而下一轮的模型不会去读上个 turn 的 `task_id`。留着它们只会在状态栏挂一条永远 running 的条目并继续烧 token。收尾在 `turn:after` 之前（TUI 在 `LocalRuntimeController.runTurn` 的 finally，headless 在 `HeadlessTurnExecutor.emitTurnAfter`），且不发完成通知。
- `context_mode` 为 none/brief/recent/files，默认 brief；Implementer / Tester / Proposal 必填 `owned_paths`，写工具与 shell cwd 校验租约（判定唯一实现在 `mica-tools/utils/pathOwnership.ts`）。
- 委派倾向由插件设置 `delegationMode` 决定（`proactive` 默认 / `on-request`），prompt 段落每轮按设置重新渲染。
- 失败重试分两层：单次请求由 provider 的 `withRetry` 处理；整轮子代理失败只有不落盘的类型（`write_mode` 为 `none` / `proposal`）且错误可重试时由插件自动重跑一次，可写类型不自动重跑。`run_many` 中单条任务启动失败（租约冲突、并发已满）只结算该任务，批次末尾给出 completed/partial/failed/skipped/running 统计。宿主报告的失败原因单独成段，不跟着 `Raw result` 一起被截断。
- 内置子代理达到默认 `maxTurns` 后复用原实例和工具历史续跑最多两次，保留任务、租约与累计用量；显式请求的 `maxTurns` 是硬上限，其他类型通过 `maxTurnContinuations` 选择续跑。续跑不重放工具调用，但模型仍可能自行重复调用。
- 任务状态四态之外还有 `partial`：用完续跑预算或显式 `maxTurns` 的子代理有可用成果但没完成任务，任务记录、`tasks.get`、工具输出与 `join` 统计都用它，不要退化成一个 `failed`。`await` / `join` 省略 `timeout_ms` 时按 10 分钟上限等待，超时返回当前状态让模型自己决定继续等还是放弃——不设上限的等待只能靠用户中止。
- 路径租约在 `prepareSpawn` 里判定（`owned_paths` 解析之后、建子代理实例之前）：冲突直接抛错，不会白建一个子代理，也不会在任务表里留一条从未跑过、0 用量的失败记录。
- 非主请求都要记账：Agent 走 `recordSubagentUsage`；BTW、摘要等走 `recordSubagentTaskUsage` / `recordHelperSubagentUsage`；插件自己的模型请求走 `ctx.models.request`，宿主在发起时绑定会话 id，以 `origin: 'plugin'` + `pluginId` 记进原会话的 `subagentUsageHistory`（Stats 的 By source 卡片与会话详情可见），同时经 `createPluginModels` 的 `trace` 作为一条 `plugin-llm` helper 运行进观察流（没有会话可归属的一次性命令只记账、不进轨迹）；`ctx.subagents.run/background` 起的后台子代理也写 `pluginId`，主对话经工具委派的那条写 `origin: 'delegation'`。等待期间切换会话不改变归属，旧会话已删除则不重建。插件里不出现自己拼的模型 HTTP 客户端——那笔开销没人记。
- 插件异步回写先通过 `ctx.session.captureOwner?.(callbacks.context)` 捕获发起者（命令不传上下文则取当前会话），notice 显式传回 owner；`turn:before` / `turn:after` 与会话生命周期按 owner 隔离临时状态，`primaryAgentOnly` 不代表整个 TUI 只有一条主会话。

### 压缩

| 入口                                                         | 行为                                       |
| ------------------------------------------------------------ | ------------------------------------------ |
| `/compact`、桌面快速压缩、`mica compact --tool-results-only` | 本地清理，不调用模型，不丢轮次，可重复执行 |
| `/compact llm`、`mica compact --session`                     | 模型摘要 checkpoint，会重写历史            |
| `--prune-only`、loop 轮前压缩                                | 本地清理，无可清理内容时可丢最早轮次       |

- 本地清理替换工具结果、可识别媒体与工具参数正文；tool-call arguments 必须仍是合法 JSON，只裁正文/长命令，保留路径、pattern、name、offset。
- 裁剪规则集中在 `mica-context/CompactionService.ts`（正文/命令阈值 200/400），幂等标记 `[omitted `。
- 自动压缩是官方插件 `plugins/auto-compact/`：每次模型请求的迭代边界检查，先本地清理、仍超阈值再模型摘要；阈值 300k / 200k、各最多 999 次。`minIntervalMinutes`（默认 30）只约束**同一轮运行中**的重复压缩：`turn:before` 把本轮起点写进 `turnStartedAt`，上一轮留下的 `lastRunAt` 早于它就不构成冷却——用户发来下一句、上下文又超阈值时立刻压。**轮次之外（会话空闲、焦点回到输入框）一律不压**：`mica/input/activity` 与 `mica/input/focus` 仍然到达插件，但自动压缩不订阅它们。抢跑试过，代价大于收益——上下文远未到阈值时白扫几十 MB 历史，阈值之上时又会替用户把工具结果换成占位符并落盘；真实反馈是来回切几次焦点，对话里就排出一列「已快速压缩」。要压由用户手动触发：命令面板「快速压缩（本地）」、`/compact`、`/compact llm`。notice 全部带 `command: 'auto-compact'` 与 `replace: true`（状态型：同一 command 只留最新一条）。**轮次边界的本地清理不写 notice**——它一轮里可能跑几十次、又不改用户看到的对话，提示只留给真正改写历史的模型摘要。**任何占住会话的压缩都经 `ctx.agent.withMaintenance` 开窗口**（插件能力面见第 7 节）：窗口里宿主发 `mica/host/maintenance`（`{ active, reason, label }`，`active: false` 只带 reason），客户端把这段时间的发送放进本地队列——条目带 `waitingFor: 'maintenance'`，排队行按窗口的 `label` 提示「自动压缩结束后发送」、可撤回——窗口结束后按宿主此刻的状态补发（还在跑就 steer 进当前 turn，已经空闲就 `turn/start`），中止中不补发（`chat.js` 的 `replayCompactionQueue` 只补发这一种，别的排队条目各有自己的时机）。轮内的模型摘要今天真的会开窗口（它就是几秒到几十秒的等待）；本地 quick 压缩不开——它很快、一轮里还可能几十次，开了只会在界面上闪出一堆排队提示。窗口按嵌套计数折叠：第一层进窗口才发 `active: true`，最后一层退出才发 `active: false`（`runAppServer` 的 `runMaintenance`），否则内层还在压而客户端已经补发。轮次之外的空闲压缩还会在 `active: false` **之前**补一条 `historyReplaced`（历史被改写、客户端要重载记录），顺序不能反。设置在插件 `settings`（每项都标 `perSession`，可在会话设置里按会话覆盖），计数与本轮起点在会话 `pluginState['auto-compact']`。模型那一路的摘要走清单 `llm`（「压缩摘要模型」面板）：默认复用当前会话模型，也能换成更便宜的独立接口，失败自动降级；插件只替换「谁写这段摘要」（`ctx.agent.compact` 的 `summarize`），分段、预算与重试仍归内核的 `CompactionService`。
- 自动压缩只在常驻会话生效：`mica exec` 是一次性运行（`agent.mode === 'one-shot'`），改变成本或输出的策略一律跳过。
- 压缩只改发给模型的历史，不改 `conversationMessages`；自动压缩失败只记 note，不中断 turn。
- 所有压缩保留 usage 记账；需要模型的 compact / review 走 subagent 或 exclusive task，不污染运行中的主 turn。插件自带摘要请求时（`compact(..., { summarize })`）走 `ctx.llm`，用量以 `origin: 'plugin'` 记进同一份 `subagentUsageHistory`。
- 会话笔记存在快照里，compact 改不到它，每轮由 `buildSystemPrompt()` 追加；rewind 随 checkpoint 回滚。

### 定时循环

- CLI / desktop 共用 `mica-common/loopArgs.ts`：省略间隔默认 30 分钟，最短 10 秒，最长一周。
- CLI `LoopController` 只活在 TUI 进程；每轮前 prune-only，失败提示但不中断；停止时移除 system prompt 指引。
- desktop 调度在 `host/loop-state.js` + `host/loops.js`（`userData/loops.json`），不在页面 setInterval；忙时 skip 不计次数，重启只追赶一轮。

### By The Way

- `/btw` 是官方插件 `plugins/btw/`：经 `ctx.commands.register({ allowDuringTurn: true })` 注册，靠 `ctx.subagents.thread()` 起一条可复用的隔离子代理线程，输出走 `ctx.ui.notice()`；停用该插件后命令消失。同一会话一次只答一条（再问如实拒绝），`-stop` 走 `AbortController` 中断并保留已流出的正文；不带 `-continue` 的新话题会 dispose 上一条线程。
- CLI 也把子代理的 `onText` / `onToolCall` / `onToolResult` 折成输入框上方的进度（正在调用什么工具、已出多少字、跑了多久，工具切换即时刷新、正文按 250ms 节流），完成后带耗时与本次请求数——终端里没有流式正文的位置，但「它还在动」必须看得见。
- 纯逻辑（主流程对话记录、system prompt 拼装、子代理线程构造）唯一实现在 `mica-builtin-commands/shared/btwThread.ts`，desktop「By The Way」抽屉与插件共用；headless 不导入 builtin commands 总出口，避免把 Ink/React 拖进进程。
- 子代理的 system prompt 是整体替换，必须显式带上：btw 规则、主会话角色名 + role prompt 全文、skills 索引、一次性主流程对话记录。工具集用 `btwToolFilter` 排除 `primaryAgentOnly`（插件侧由宿主线程提供的同名过滤兜底）。
- desktop `BtwThreadController` 立即 ack，结果经 `mica/btw/updated` 流式推送，不堵塞 interrupt / steer / recall。
- 同线程单子代理串行，允许一条排队与撤回；不同线程可并行。线程落盘 `$MICA_HOME/btw/<sessionId>.json`，共享路径在 `mica-common/btwState.ts`。
- 空线程（点了「+」还没提问）不落盘、不从磁盘恢复：`BtwThreads` 的 `exportState` / `restore` 与 `readBtwState` 都按 `entries.length > 0` 过滤，否则重启后抽屉里会多出一排「新线程」。抽屉对失败/被中断的条目给「重试」，Alt+↑/↓ 翻本线程问过的问题，Cmd/Ctrl+Shift+B 开关抽屉。
- 抽屉里的失败提示落在它自己那条通知栏里（`BtwDrawer` 的 `notice`），不写到主对话：抽屉开着时主对话那条 notice 在背后，用户只看得到「点了没反应」。抽屉关着时才走会话 notice。
- 线程上限唯一来源是 `mica-common/btwLimits.ts` 的 `BTW_MAX_THREADS`（host 与渲染层共用）：到上限时「+」直接禁用，不靠点了再拒绝。
- 线程上限 6（`MAX_BTW_THREADS`）：到上限时 `BtwThreads.open` 返回可展示的拒绝，**不再**悄悄淘汰最早的空闲线程——被淘汰的 tab 在客户端还在，点进去只会用一个 host 已不认识的 id 重建空线程，之前的问答就丢了。
- BTW 不进主对话上下文、不占主队列、不改 run 生命周期；用量单独记账（插件线程记 `origin: 'plugin'`，抽屉侧记 subagent `btw`）。

## 9. Desktop

### 三层边界与装配

| 层                    | 职责                                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| `src/host/`           | chat、terminal、files、git、stats、配置、loop、共享状态等业务           |
| `src/server/index.js` | 自包含 Node HTTP 运行时，托管 renderer，`POST /api/invoke` + SSE 事件流 |
| `src/main/index.js`   | Electron 容器：启动运行时、窗口导航、未读徽标、窗口状态                 |
| `src/renderer/`       | 页面；`transport.js` 统一实现 `window.mica` 与平台差异                  |

- 外壳不注册通用业务 IPC、不加 preload；页面始终通过 HTTP + SSE 访问运行时。主进程只保留三项业务例外：受控浏览器、终端控制、系统检查（TCC 权限状态只属于有 app 身份的那个进程，运行时进程拿不到）。
- 运行时构建保持 `ssr.noExternal: true`，只 external Node 内置模块与 node-pty。新增依赖后跑 `npm run build:server && npm test`。
- `package.json` 的 `dependencies` 只放主进程/运行时真正 require 的包；renderer 依赖全部归 `devDependencies`。
- `electron.vite.config.mjs` 的 `resolve.dedupe: ['react', 'react-dom']` 不能删。
- `tablerIconDeepImports()` 只影响 build，新增图标无需同步清单。
- 页面根节点必须套 `renderer/src/ErrorBoundary.jsx`。按需视图统一用 `renderer/src/lazy-view.jsx` 的 `lazyView(loader, name)`：校验导出、局部捕获失败，重试时重建 lazy 实例；外层仍由 `Suspense` 提供加载占位，单个视图失败不能卸掉整个对话页面。
- 运行时启动即 `stripContainerEnv()`；受控浏览器与终端 socket 只在 `will-quit` 关闭。
- 同一时刻只起一个 Electron 实例；验证时串行。

### 共享状态与路由

- 运行时只有一份 workspace / drafts / layout / rightTerms / terminalOpenByChat / cwd / Git 偏好，落盘 `userData/ui-state.json`；语义在 `mica-web-shared/ui-state.ts`。老版本单独存的 `workspace.json` 只在 ui-state 还不存在时导入一次、落盘后删除；ui-state 已存在就不再读它（否则用户清空过的工作区会被搬回来）。
- 条目补丁用 `setUiStateEntries`，null 表示删除；回声在 store 的 `applyRemote` 认领一次，组件不得各自认领。
- 同一 session 在所有页面是同一 node、run、终端；`dedupeSessionNodes` 合并重复页签。
- 默认 `0.0.0.0:8787`，没有账号体系，只有一道可选的口令；README 保留风险说明。非回环（且不在 `MICA_DESKTOP_TRUSTED_CLIENTS` 里）的连接**只公开别人手上那条分享链接**：`/share?session=<存在的会话>`，其余页面、`/remote/*`、`/mcp/*` 回 404 或登录页，**`/api/*` 没有凭据也回 404/401**（它等于整台机器）。唯一例外是探活指纹 `GET /api/health`（只回 `{ ok, app, access }`）：侧栏 Connections 连另一台机器必须先探通它，`access` 说明对方要不要口令，没开时由卡片直接给出可操作的提示而不是打开一个 404 窗口。路径分类唯一实现在 `host/access-core.js` 的 `classifyRemotePath`，放行判定在 `host/remote-access-core.js` 的 `remoteAccessDecision`，不要另写第二份白名单。
- 端口常量唯一出口 `mica-web-shared/runtime-port.js`；页面路径约定唯一出口 `app-paths.ts`。
- 单端口路由：`/`、`/mica-web`、`/share`、`/files`、`/terminal-control`、`/mcp/browser`、`/mcp/terminal`、`/api/*`、`/remote/control/*`、`/remote/terminal/*`。
- 受控浏览器与终端服务走 `userData` 下的 Unix socket；`apps/config-web` 是独立宿主（默认 13987）。
- `shareView` 只影响呈现，不是权限边界；`access-core.js` 校验 Origin / Host 防跨站与 DNS rebinding。
- 分享地址用 `access:info.shareBaseUrl`，不以本机 `location.origin` 兜底；链接形如 `/share?session=<id>`。
- 切换服务器：页面 origin 即当前服务器；由 host 探活后开新窗口/标签页，不做代理或跨源 API 层。探活与打开都用**完整入口**（`@packages/mica-web-shared` 的 `probeRuntime`）：中转机链接丢了 `?t=` 只是台没人认识的域名，外壳会把它当外链丢给系统浏览器；中转机窗口的身份是「origin + t」，所以同一台中转机后面的两台机器各开一个窗口。
- 运行时里的用户终端面板与主进程终端控制是两套，不复用会话。
- 终端里手跑的 `mica` 一轮结束时按**那条 PTY** 记未读（`host/notifyServer.js`，terminalId 是 `<终端条目 id>:<pane>`），main 的 dock 徽标数的是它的总数。标记已读必须用回这个 terminalId：按条目拼一个 `<条目 id>:mica` 会打到不存在的终端上，未读永远清不掉（徽标点不掉的来源）。PTY 级状态归并成条目视图只给界面用（`renderer/src/notify-state.js`），清未读只能对未读的那条 PTY 发；对话底部终端（点标签、在面板里敲字/滚动、焦点回到窗口时它就在屏幕上）与编辑器终端都要发出这条「看过了」的信号，否则那条会话的提醒除了重开终极端口没有别的出路。

### 对话与输入

- chat run 按 nodeId 存于 `host/chat.js`；请求级发送错误走 `chat:queue-error`，回滚乐观消息并恢复草稿。host 进程在应答 `turn/start` 之前就退出时走同一条路径（`chat-host-requests.js` 结算未应答请求）：那一轮从未跑过，气泡必须撤回，否则消息看起来已发送、会话里却不存在，双击编辑只会得到「找不到要编辑的消息」。
- 常驻宿主预热：渲染层每换到一个节点调一次 `chat:warm`，宿主侧只保证「App 开着就至少有一个宿主」（`chat-warm.js` 的 `resolveWarmAction`，已有活着的宿主就跳过，切页签不会各自养一个进程）。插件只载在会话宿主里，而宿主是按需 spawn 的——没有预热时重启桌面端后不发消息就没有宿主，桥与定时循环停摆，手机端显示「暂时不可用」。
- 闲置宿主回收（`chat-idle.js` 的 `resolveIdleReap`，每分钟扫一次）：开着不用的页签会一直占着 app-server（一个 50–270MB），一天下来能堆到几百 MB。判定只收「没在干活」的：有轮次 / 压缩 / 中止进行中、`hostPending` 或本地排队里有消息、btw 线程在跑的一律不动；按最近活动时间留最新的一个（插件只活在会话宿主里，收干净会让手机桥与定时循环停摆）；默认闲置 30 分钟才收，`MICA_CHAT_IDLE_REAP_MS` 可调。另有一条硬上限 `IDLE_MAX_KEEP = 3`：排在前 3 之外的宿主不看闲置时长、只要空着就收——进程数量本身就是代价，而插件只活在最近活动的那个里。收掉之后用户再发消息由 `startRun` 按需 spawn 并带原 sessionId 续跑，只多一次冷启动，历史不受影响。
- 队列唯一投影 `chat-queue.js.mergeQueuedItems`：host after_iteration 在前，本地 after_turn 在后；宿主占着会话时（自动压缩的维护窗口）条目带 `waitingFor: 'maintenance'` 与 `waitingLabel`，排队行据此说「<label>结束后发送」而不是等迭代边界。
- 宿主报告 `mica/host/maintenance active` 期间（自动压缩占着会话：空闲压缩是同步的读不到 stdin，轮内模型摘要是几秒到几十秒的等待——两种都不能让发送插进去）新输入走 `startRun` 的维护窗口分支：第一条进本地队列并如实回 `queued`，已有排队就按单槽就地拒绝。窗口关闭（`active: false`）时 `replayMaintenanceQueue` 只补发 `waitingFor: 'maintenance'` 的那一条，按宿主此刻状态分流——这一轮还在跑就 steer 进当前 turn（排队行原地变成「工具调用结束后发送」），已经空闲才 `turn/start`；`run.aborting` 时只刷新队列、不替用户发出去。渲染层拿到 `queued` 时若这一条本来没在排队，要把乐观的「正在运行」收回去——它确实还没跑。
- 排队消息只在输入框上方的 dock 里出现（`ChatView` 的 `transcriptMessages` 过滤带 `queued` 的行），每条一张卡片：头部是编号 / 「排队中」/ 时机芯片 / 右侧「撤回并编辑 ⇧←」，正文两行截断、悬停看全文；整卡双击与按钮同为一次撤回。时机芯片按 `items[0]` 取文案（`queueSendTiming`）：维护窗口 → 「<label>结束后发送」、轮次已结束 → 「下一轮开始时发送」、`after_iteration` → 「工具调用结束后发送」、其余 → 「本轮结束后发送」。文案是中文（与其它排队提示一致），不要再写成整句英文加 `shift + ← or double click to re-edit` 那种会折行的长句。
- `mica/queue/hold` 冻结待撤回条目，结果由 `chat-recall.js.resolveQueueRecall` 判定为回输入框 / 已发送 / 保留。
- `run.events` / `run.prompt` 每轮重置；恢复先用 `historyBeforeRunReplay` 裁掉本轮已保存回答再重放。
- 每次模型请求后立即转发 usage；实时 usage 不改 turnState / updatedAt。
- 阶段文案与计时读 `statusLinePhase`；`mica/turn/retrying` 让状态行显示 `retrying n/5`。
- 文件补全 CLI / desktop 共用 `mica-file-mentions`；`@` 与 `/` skill 补全只在词首触发，选中只插文本（文件插 `@路径`，skill 插 `[skill:name](SKILL.md 绝对路径)`）。
- `/` 浮层混排 skill、MCP server 与插件清单声明的条目（`completions`，类型标记「指令」）；前两类插入的是一枚 markdown 链接：`[skill:name](SKILL.md 绝对路径)`、`[mcp:name](接口地址)`（http 的 server 才有地址，stdio 退回 `config.json`），第三类插入清单里写好的那段提示词（`insert`）。目标含空白或括号时整条包进 `<…>`（CommonMark 允许），**不**做百分号编码——那会让模型读到一个要再解一次才成路径的东西。消息体里这类引用由 `splitTextByCapabilityRefs` 收成 `skill:name` 一枚短标签，点开仍是完整目标（原文一个字不改，编辑重发靠它定位）。两边都包含**内置能力**，不需要用户配置：skill 来自磁盘扫描 + 插件发布的 `$MICA_HOME/plugin-skills` 索引 + **插件清单声明的 skill 目录**（后者只解析 `plugin.json`、不导入插件代码，所以第一次打开就看得见随包 skill，不用等插件 setup 过一次；`skills-core.js`；索引里声明了角色的条目按会话当前角色过滤，`skills:list` 的 `role` 参数就是它，取输入条上还未发送的 `activeRole`），MCP 来自 `config.json` + 运行时按 socket 能力算出的 `mica-browser` / `mica-terminal`（`mcp-candidates-core.js`）；插入文本与普通条目一致。
- 每行是「名称 | 说明 | 类型 | 来源」四列，列数必须与行内子元素一一对应（多出来的子元素会掉到第二行，浮层看起来就是歪的）。类型标记写 `skill` / `MCP`（`@` 文件补全的 `file` 不画，一整屏都是文件时标一排只是噪声）；来源标记是 `source: { kind, label, detail? }`，kind 取 `builtin` / `plugin` / `project` / `user` / `config`：插件带的写「插件 <id>」、项目目录写 `.mica/skills` 这样的相对路径、用户目录写 `$MICA_HOME/skills` / `~/.agents/skills`、MCP 写「内置」或 `config.json`；`detail`（SKILL.md 路径、`config.json` 路径、插件 id）放悬停提示。来源由 host 两个扫描器给，渲染层只做白名单校验（不认识的 kind 整条丢掉），`label` 同时参与查询匹配但没有高亮——说明列只讲「这东西干什么」。
- desktop composer 不分派斜杠命令；输入历史只由 Alt+↑/↓（CLI 另支持 Ctrl+P/N）翻。
- ⌘/Ctrl+P 在主区顶部打开会话快速搜索（`SessionQuickOpen`，VS Code quick open 那种：标题 / 路径 / 分组匹配，不搜对话正文）；文件视图里同一组合归编辑器的文件快速搜索（`QuickSearch`），两处由 `disabled` 按视图分工，不要同时抢这个键。
- ⌘/Ctrl+K 聚焦侧栏搜索：焦点在对话输入框里也要能用（「刚敲完一句想翻旧会话」是最常见的入口），终端、编辑器与别处的输入框不抢，macOS 上只接管 ⌘K（Ctrl+K 在文本里是「删到行尾」）。侧栏收着（桌面折叠 / 手机抽屉）时先露出来再聚焦——快捷键与焦点规则在 `App.jsx`，输入框在 `SessionTree`。
- 从 ⌘P 点开一条会话后侧栏会自动把它露出来：`session-reveal.js` 的 `planSessionReveal` 只算「要展开什么」（分区 / 分组祖先 / 父会话祖先 / Recent 分页），`SessionTree` 负责展开、`scrollIntoView` 与 `.session-row-flash` 闪一下。搜索态占着列表时请求先挂着，查询清掉才落地（那时树才画出来）。
- 输入框内容变化会节流 2s 发一次 `chat:input-activity` → `mica/input/activity`（空输入不发）：它只服务「这个人回来了」这类提前量，当前没有插件消费（自动压缩已改为只看请求边界），没有常驻进程时直接丢弃，不回包也不影响输入。
- 输入框获得焦点发一次 `chat:input-focus` → `mica/input/focus`（只在会话没在跑时发）：同样是提前量，自动压缩据此在用户还没敲第二个字之前就压完。两条都只在已有常驻 host 时转发，不为一次焦点去 spawn。
- 粘贴共用 `composer-paste.js`：图片转 `[Image](路径)`，文件插绝对路径。
- 角色入口在输入条箭头，随下一次发送/编辑的 role 参数持久化。
- 对话右键菜单里的「耗时分析」（`TurnTimingDialog`，入口**不在**「+」里：它是一份只读报告，不是往对话里加东西的动作）：一轮按「等模型 / 输出 / 跑工具」首尾相接切成区间，界面先给三类合计条 + 图例（占比、次数、累计耗时）与工具耗时排行，再按发生顺序列出每段的开始偏移、内容与耗时。切分、聚合与落盘形态的唯一实现在 `packages/mica-common/turnTiming.ts`；`AppRuntime` 每轮跑完把记录写进会话快照（`snapshot.turnTimings`，最近 50 轮，新的在后；fork / 新会话清空），所以重开应用、换进程也看得到历史轮次。桌面端的弹窗读这份记录 + 正在跑的那一轮（它还没落盘，由 `ChatView` 现场传进来，`renderer/src/turn-timing.js` 只做 Codex 事件 → 通用事件的适配），视图本身（`@mica-config-ui/web` 的 `TurnTimingView`）与会话详情的「耗时」页签共用一份。没有记录时如实说「还没有记录」，不要用当前事件流空跑一份冒充。
- 输入条齿轮与时钟打开 `SessionSettingsDialog`：会话能力（Tools / Skills / MCP 三页签）/ 定时任务 / 插件。声明了 `perSession` 的插件是左侧导航「插件」下面的子项，内容区只画选中的那一个；自动压缩的阈值这类按会话可调的项就在这里，默认值仍在配置页 Plugins。插件声明 `llm` 的字段由 `LlmSettingsSection` 按会话渲染（与配置页同一组件，摘要写会话当前模型、逐字段可「跟随默认」），不要在会话设置里另写一套模型表单。
- 顶栏的「会话笔记」入口由官方插件 `session-notes` 声明（清单 `desktop.entry.placement: "header"` + 插件目录的 `desktop.jsx`），内核没有笔记专属界面：停用插件后图标与编辑器一起消失，工具与 prompt 段落也一起撤下。卡片经 `api.session.state` 读写会话快照，700ms 防抖、无保存按钮。
- 插件入口是**输入框正上方那排胶囊按钮**（`PluginQuickBar`，来自清单 `desktop.panel.shortcuts`）：`action` 类按钮点一下直接调插件动作（立即返回，不在页面里跑外部命令或等模型），`section` 类按钮打开盖在对话区右侧的抽屉并展开那一块（`PluginPanels`，宽 340、不挤窄对话），`items` / `menu` 类按钮悬停（停 140ms 才展开，划过不算）或点击展开一层子项。`menu` 的子项是本地事实、由插件现算（这个会话涉及哪些分支），所以**不能等悬停才去要**：页面挂载后先预热一次视图，条目按会话缓存在 `renderer/src/plugin-panels.js`（60s TTL、过期也先画旧的再后台刷新），抽屉复用同一份整块视图（30s）开局——点开看到的必须是内容而不是一句「正在读取」，只有真没有缓存时才画骨架（不写「正在读取」这种像在等网络的字）。请求失败重试一次再放弃；`prunePluginPanelCache(nodeId)` 在换会话时丢掉别的会话的条目（分支属于那条会话）。这一排是横向滚动容器，子项菜单因此画在 body 上（`createPortal` + 按钮矩形定位），不要塞回按钮里；抽屉折叠状态与 ChatView 的 `pluginPanelOpen` / `pluginPanelSection` 共用。哪些插件有面板、`roles` 门槛、是否停用都从 `readPluginsDetails` 拿（用户插件也在里面），规则在 `renderer/src/plugin-panels.js`；RPC 走 `window.mica.chat.pluginPanels.view|action` → `chat:plugin-panel-view|action`。host 侧返回的载荷在 `hostTaskRequest` 的信封里，必须过 `unwrapHostResult`，否则页面只看到 `{ok:true}`、视图全 undefined。
- 清单 `desktop.panel.status: true` 的插件额外给一行**常驻状态行**（视图返回 `statusBar`，画在输入框正上方、面板关着也在），用来说「这个能力此刻生效没有」。宿主里快捷栏与抽屉各存一份视图，抽屉的动作改完要经 `plugin-panels.js` 的 `notifyPluginPanelStatusChanged()` 广播一次，状态行立刻跟着变，不要等 30 秒轮询。
- 输入框动作区只有一个「+」按钮：展开后是添加附件 / By The Way / 定时任务 / 每个插件面板（按清单顺序，标签取 `desktop.panel.label`；声明了 `open` 的入口点下去是把那个动作交给插件——手机访问因此直接弹二维码，不打开抽屉）。只读的分析与详情不进这里（耗时分析、会话详情都在对话右键菜单）。面板入口在这里也有，所以配置类插件不必为「能被打开」而声明一个常驻胶囊；宿主不认识任何具体插件 id，列表来自 `readPluginsDetails`。「添加附件」是文件按钮（`host/attachments.js` 把文件存进 `$MICA_HOME/attachments/` 并插入绝对路径，图片同样走这条路），不是只选图片。
- 双击用户消息就地编辑，仅空闲且非空时提交，经 `chat:edit-message` 截断重跑；失败保留编辑文本。
- **会话详情只有一个组件**：`mica-config-ui` 的 `SessionDetailView`（头部 + 对话记录 / Context 分析 / 耗时 / 系统提示词，原始文件自动保存；「耗时」页签读会话快照里的 `turnTimings`，与「耗时分析」弹窗共用 `@mica-config-ui/web` 的 `TurnTimingView`）。配置页 Sessions 页、Stats 的会话详情弹窗（额外带「用量」页签）与状态栏上下文弹窗都渲染它，桌面端只包一层 `.mica-config-ui.is-embed` 的外壳与 `chat-modal-session-detail` 尺寸；**弹窗壳传 `bare`**，不画自己的标题 / meta——会话身份（标题、路径、事实）只由详情头部给出，两处各画一遍就是四行表头压在一屏内容上。原始 JSON 不是页签而是标签条右端那个开关（再点一次回到刚才那个视图）；对话记录 / 系统提示词 / 原始 JSON 三个 pane 共用 `.session-pane-toolbar`。不要再写第二套会话详情或上下文分组，上下文分类 / 信封 / 差额的唯一计算在 `mica-config-ui/src/server/contextBreakdown.ts`。
- 「系统提示词」页签读 `snapshot.systemPrompt`（按需 `readSessionSystemPrompt`，不跟着 2 秒轮询），用 `web/promptView.ts` 的 `analyzePrompt()` 切成「段 → markdown 标题」的大纲（顶层是角色 / 项目说明 / skills / 环境信息 / 其它注入，段内再按 `#` 递归；代码围栏里的 `#` 与 `<tag>` 不算结构，插件注入了哪个角色 / 段落由 `<injection>` 的属性标出来）。**导航只有一份**：左栏是这棵树（每行一条占全文的占比条，可按体积排序、可按节点正文搜索并标出命中次数），选中任一行即换右侧编辑器内容，工具栏显示所选模块的字符 / ≈tokens / 行数并提供复制，点行尾的定位把该节滚到编辑器对应行；不要退回「下拉 + 按模块查看 + 展开模块统计」那三件套（下拉还必须用 `SelectMenu`，原生 `<select>` 一律不写）。窄容器用 `@container session-detail` 改成上下排（同一个组件既在整页也在几百像素宽的弹窗里，不能按视口折）。刷新通过 refreshToken 更新数据，页签 key 只按 sessionId 区分，避免运行中反复卸载。对话记录与 Context 分析里那条 System 也用同一份记录（没有记录时才回落到角色提示词），三处口径一致。
- 会话详情的「用量」页签（桌面端 `stats/SessionDetailModal.jsx`）是 KPI + 来源堆叠条 + 逐次请求堆叠柱 + 逐条表格四段：柱子按「缓存输入 / 未缓存输入 / 输出」三段堆叠（颜色与图例同源 `stats/usage-series.js` 的 `USAGE_TOKEN_PARTS`，缓存用中性灰、未缓存用 info 蓝、输出用 accent，别把占比 98% 的缓存段调成最淡的 ghost，那会让柱子看起来是空的），可在「总量 / 输入 / 输出」之间切视图；请求投影、按来源归并与「每次 482」这类派生数字全部在 `stats/usage-series.js`（纯函数，有单测），组件只画。

### 统计页

- Stats 页（`renderer/src/stats/StatsView.jsx`）的图表都画在 `charts.jsx`（`CalendarHeatmap` / `BarSeries`）之上：每日柱可在 Tokens / 请求数 / 按来源三种维度间切换（按来源是堆叠柱，取 `scope.js` 的 `bucketByDaySource`），模型排行带占比条，项目排行是按来源堆叠的条，会话表在 tokens 格背后铺一条相对最大值的条。日聚合、区间裁剪的唯一实现在 `scope.js`，颜色与顺序只认 `stats/usage-series.js` 的 `USAGE_KIND_COLORS` / `USAGE_KIND_ORDER`（与「Usage by source」卡同一份），不要再写第二套配色或聚合。
- 「By source」**不分组**：所有来源摊平成一张按 token 降序的表（`stats/source-groups.js`）。每行给四件事：类型（`Type` 列的 Tag：主对话 / 子代理 / 插件 / 内核后台）、具体名称、谁派发、用途——只写 `Auto Compact`、`Implementer` 或 `delegation` 时用户看不出「这笔请求哪来的」。子代理行写成「子代理 · 实现」并注明「经 agent 工具派出」；插件行用清单里的名字加原始 id 与清单描述；内核行用中文功能名并带「（内核兜底）」后缀，好让同一功能的插件那条对得上。卡片底部一行图例解释四类各自是什么（`SOURCE_KIND_HINTS`）。不分组是因为同一个功能可能留下两条账——自动压缩的模型摘要既可以由插件经 `ctx.llm` 发（`origin: 'plugin'`），也可以在宿主不给 `llm` 时由内核起摘要子代理（`helper`）——分组会把它们塞进两张小表，看起来像记了两笔；同一个 `kind` 内的历史写法（`compact` / `auto-compact`）按 `sourceRowKey()` 归并成一行，不因为换了写法就多出一行。来源的中文名只有一份（`mica-web-shared/usage-source` 的 `USAGE_SOURCE_LABELS`），表格、图例与会话详情共用。
- 表格统一用 `@mica-config-ui/web` 的 `DataTable`（列定义、受控排序、内置翻页、窄容器退列）：统计页的 By source 与 By session 都用它，宿主负责包一层 `.mica-config-ui`。**不横向滚动**——卡片变窄时先让次要列退场（`narrow: 'secondary'` 在 ≤720px 退，`'tertiary'` 在 ≤540px 再退），表头在窄容器换 `narrowLabel`。规则按容器宽度写在 `styles.css` 的 `.data-table-scope` 下，不看视口；分页的页码夹紧与区间文案在 `dataTableModel.ts`（有单测）。

### 展示

- 主文本共用 `--chat-text-size`；用户块与回答使用不同底色。
- 自动链接唯一实现在 `mica-common/autolink.ts`：`splitAutolinkPunctuation` 管 markdown 一侧（desktop 的 remark 插件排在 `remarkGfm` / `remarkPathLinks` 之前，CLI 用 `splitTerminalLink`），`findAutolinks` 管纯文本一侧（用户消息、引用块、notice、思考经 `chat-paths.js` 的 `splitTextByLinksAndPaths` → `PathText` 渲染成 `.chat-link`；代码块不认链接）。尾部裁剪含 `*` / `_`，那两个是强调分隔符而不是地址的一部分。
- micromark 的 autolink literal 会一路吃到空白，把 URL 后面紧跟的 `**` 与其后的中文一起吞进链接，那对强调分隔符就再也配不上、页面上留下字面量 `**`（`**http://127.0.0.1:8877**（…）`）。解析阶段已经错了，mdast 上救不回来：`chat-autolink.js` 的 `protectEmphasisAutolinks` 在解析前把这种写法换成显式 autolink `<URL>`（`www.` 用 `[text](href)`），代码块与行内代码原样跳过。CLI 的 marked 不受影响。
- 路径识别在 `chat-paths.js` / `PathToken`；单击弹「在 Finder 中打开 / 在 Mica 中打开」菜单（⌘ 点击直接走 Mica），图片单击预览、失败给 notice。
- 行内代码（`inlineCode`）里的 URL 与路径同样可点：`remarkPathLinks` 把含它们的 `inlineCode` 换成 `<code>` 包着的管线节点（`data.hName`），样式仍是代码颜色。模型几乎总用反引号写 URL 和路径，这里不可点就等于「链接点不了」。围栏代码块不认 URL，路径交给 `CodeView`。
- 「在 Mica 中打开」由 `files:stat` 判类型：文件进编辑器、目录把文件树临时切到那里（`FilesView` 的 `rootOverride`，换会话即作废，树头有「返回工作区」）。任何新入口按路径打开都走 `FilesView.openPath`（第三个参数 `{ focus: true }` 只开编辑器），不要各自 read。
- 分支评审**复用编辑器**，不另写一套 diff：插件回 `openReview` 时宿主把 `cwd`/`base`/`head` 写进文件页地址（`/files?cwd=&base=&head=`，见 `app-url.js` 的 `detachedFilesUrl`），在**另一个窗口**（`REVIEW_WINDOW_NAME = 'mica-files-review'`，与顶栏那个文件窗口分开：不覆盖用户正在改文件的编辑器）里打开编辑器，页面自己就停在 Git 面板的这份对比上。外壳拦 `window.open` 按 `frameName` 开窗（`openAppPageWindow`），浏览器里就是新窗口，被拦截时才退回当前窗口。编辑器因此有个「提交对提交」模式：`useGitWorkspace` 的 `compare` 非空时改读 `git:ref-summary`、不抓 `status`、不轮询，`FilesView` 把它传给 `GitComparePanel`（标题写「目标分支 · 相对 基线」，不再出现「工作区」）与 `useGitReview`（差异按 `git:file` 的 `refs` 模式读两边提交）。页面里改基线只改地址。Git 面板顶部是**两格选择框**：**原分支**（旧的一侧，`gitCompareBase`）与**目标分支**（右侧，`gitCompareHead`，缺省「工作区」＝以前唯一的那种比较）。两格随时可换，只属于这一页——按仓库记在 ui-state 里，不写会话；目标分支选回「工作区」就退回工作区对比，选成某条分支 / 标签 / 提交时这一页就是「提交对提交」。`direct/合并` 只在工作区侧可用（提交对提交恒定按合并基点算）。`head` 允许只写在远端（`origin/<分支>`）：`git-compare.js` 的 `commitHash` 原名解析不到时会再试一次 `origin/<名字>`，标题里仍显示短名——评审别人的需求时本地没 checkout 过那条分支是最常见的情形。
- 用户消息超过 10 行默认折叠，含 `[Image]` 的不折叠；折叠态悬停用 `chat-hover-tooltip.jsx`，不用原生 `title`。
- 回合日志（`TurnLogDock`）是停靠区：挂在滚动区外面、永远贴着输入条。边界只有它自己那一行标题——整行可拖、双击回到跟内容走、箭头收起成一行（收起时高度由内容决定，不沿用拖出来的高度）。标题行右侧那句摘要（最近一条活动的原文 + 步数 / 耗时，`turnLogHeadSummary`）**只在收起时出现**：展开后下面每一行都在，标题行只留把手与标签，不重复一遍状态文案；标签在轮次运行时是「模型思考中」、跑完回「本轮」。
- 同一轮的思考合成**一块**（`mergeTurnThinking`，`chat-turn-activity.js`）：模型反复思考、只调工具不返正文时，后续思考按顺序接在同一段里持续增长，不一段一个块。**轮次之间互不顶掉**：最新一轮摊开在下面，更早的各收成一行（`groupActivityRounds`，标签「轮次N」+ 最近一条活动 + 步数 / 耗时，点开摊开整轮、带 1px 描边），只留最近 `MAX_TURN_LOG_ROUNDS` 轮。跑完的过程**不进对话**，只在这个停靠区里。工具行单行省略，点行开 `ToolDetailDialog`；思考整段折行。
- 详情弹窗统一 `chat-modal.jsx` 的 `ModalShell`；`--chat-*` 变量要能穿过 portal。
- 代码块统一 `CodeView` + `code-highlight.js`，只读着色，不引编辑器运行时。
- 「在编辑器中打开」把内容作为只读虚拟文档放进应用里唯一的 monaco 实例。
- 轻量浮层统一用 `Popover`；会话级设置是弹窗而不是浮层。
- 电脑隐藏发送/排队按钮，移动端保留；后台任务/子代理 dock 只列运行项与需要看一眼的结束（判定唯一实现在 `mica-common/backgroundTaskVisibility.ts`：`killed` 是模型 kill 或宿主退出时的统一收尾，不占位置；失败、非零退出码、进程失踪才留着）。子代理同理走 `mica-common/subagentVisibility.ts`：`completed`、模型自己 kill 的、上一轮正常结束统一收尾的都不占位置；只有 `failed` / `partial` / **被中断**的留着——记录带 `interrupted`（点停止、宿主关闭、上一轮以中止收尾）的还能看最近活动、还能重启。

### 文件、Git 与侧栏

- Files / TerminalHost 按需挂载后保留实例；ref 未就绪的打开请求暂存，挂载后补开。
- shell 由 `shell-path.js.resolveDefaultShell` 按平台与存在性解析。
- 文件树尺寸沿用 VS Code：活动栏 48px、树行 22px、缩进 8px。
- 文件操作只重读受影响的父目录；目录结果合并到最新树状态，保留未变节点、子树与展开状态。手动刷新/恢复可见时保留已有树，目录请求按根与目录校验，过期结果不能恢复已删除或折叠的分支（`renderer/src/files-tree.js`）。
- 编辑器工作区由 `EditorWorkspace.jsx` 持有自己的目录与 Git 状态，底栏目录选择只更新该页面，不写 session cwd、聊天默认目录或 workspace 节点；主窗口与独立编辑器窗口共用该入口。文件树向上导航、打开目录也通过 `onRootChange` 同步页面目录，文件搜索读取编辑器 `getRoot()`。
- 编辑器底部终端 `EditorTerminal.jsx` 复用 `TerminalHost`（`pane: 'terminal'`，一个标签页就是它的一个节点，PTY id 为 `<标签 id>:terminal`），不另写一套 xterm/PTY 装配：回放、失败重试、文件链接与对话底部终端完全同一份行为。开关与高度存 ui-state 的 `editorTerminal`（两个窗口共享），标签与 PTY 只属于页面。Ctrl+`与顶栏终端图标按视图分工——对话视图管会话终端、编辑器视图管编辑器终端，两处各装各的监听，不在同一处判断该切谁；右键文件树 / 资源管理器根节点的「在终端中打开」把目录递给面板，一个标签一个目录。关闭标签与关闭窗口前都用`terminal:foreground` 问一次前台在跑什么（`processRunning`是轮询出来的滞后标记，实时`ps`才拦得住刚起的命令），命中就二次确认。窗口关闭由外壳问页面：页面挂`window.\_\_micaConfirmClose`（`main/index.js`的`confirmWindowClose`经`executeJavaScript`调用，返回`false`或 resolve 成`false` 就不关）；外壳不认具体页面，退出应用时不问。页面卸载 / 刷新时把 PTY 一并 dispose——PTY 活在运行时里，页面没了它不会自己结束。
- Git 分暂存/工作区两段，写操作仅 stage/unstage/discard（含文件夹级 `git:discard-dir`），一律先确认；所有 Git 命令带 `GIT_OPTIONAL_LOCKS=0`。文件夹回退（`git-ops.js` 的 `discardDirectory`）让 git 自己枚举目录条目再 `restore --worktree`，所以被筛选隐藏的改动、还没进面板的未跟踪文件一并回退，删掉未跟踪的计数回给界面；恢复来源是**索引**而不是 HEAD（与单文件版一致），拒绝回退整个仓库。
- diff 编辑器的行悬停显示该行作者 / 提交 / 时间：`git:blame` 走 `git-blame.js`，`{ ref }` 查某个提交、`{ index: true }` 查索引、都不给查工作区（未提交的行如实说「未提交的更改」并给上一版提交），读不到时回 `{ error }` 而不是抛错。这一侧到底是哪份内容由 `git:file` 返回的 `blame` 说明，渲染层不按 mode 猜；模型与悬停的连接在 `renderer/src/git-blame-hover.js`（`bindBlameModel`），格式化与缓存去重在 `git-blame.js`（`buildBlameHover` / `createBlameResolver`）。
- Git 图谱是编辑器的独立整页（活动栏 `git-graph`，占满侧栏 + 编辑器）：`git:log`（提交历史，`--exclude=refs/notes/* --exclude=refs/stash` 后再 `--all`，笔记与 stash 不算历史）与 `git:commit`（元信息 + 相对第一个父提交的文件清单）在 `host/git-log.js`；泳道布局、搜索、增删统计是纯函数在 `renderer/src/git-graph.js`，页面 `GitGraphView.jsx` 只画。点文件用 `refs` 模式在页面内开 diff（根提交的基线是空树），不读工作区。
- Git 比较按仓库/基线/模式与 fingerprint 保存审阅状态；DiffEditor 统一只读，首次加载后保留实例。比较模型与滚动状态由 `renderer/src/git-diff-session.js` 按仓库/文件/基线缓存；换文件保留画面到新内容就绪，替换/释放模型前先解绑。无 fingerprint 的源代码管理轮询必须重读并比较全文，无变化保留模型，不能用增删行数判断内容未变。
- Git 轮询只在可见且聚焦时进行，不重叠：编辑器页自己的 `useGitWorkspace` 跑 `summary` + 分支对比 + `status`（3s），主窗口只为会话底栏与徽标取 `status`（10s）。编辑器页隐藏时停止轮询。- 顶栏编辑器图标右边是工作区徽标（`+1.2k` 绿 / `−840` 红，精确行数与文件数在 tooltip）：取数走 `git:change-counts`，与 `git:summary` 共用 `sumLineChanges` 和同一份文件列表（含未跟踪），所以和 CHANGES 面板的合计永远一致；按 20s TTL 取、一轮跑完立刻强制刷一次。千位以上缩写（向下取整）、为 0 的一侧不画、有文件但无行数变更退回落文件数、干净时不画，规则唯一实现在 `renderer/src/git-badge.js`。
- 全树扫描（`status -z` + `diff --numstat`）在 host 侧按仓库缓存 5s：`git-ops.js` 的 `cachedWorktreeRead`，键是 `<root, summary:<base>>`，`git:summary` 与 `git:change-counts` 共用同一份结果（徽标不再单独算一遍）。仓库身份（`git:status` 的根目录 / 分支 / 项目名）走同一条缓存，键 `workspace-status`——它每次都要 spawn 一次 `rev-parse`，而每个窗口都在轮询（编辑器 3s、主窗口 10s），开着多个窗口时实测每 4s 一次，不缓存就是纯浪费。`cachedWorktreeRead` 同时做 **in-flight 去重**：同一 `<root, key>` 在任一时刻只有一次真正在跑，并发调用共用同一个 promise（只缓存「跑完的结果」不够——轮询间隔比一次读取更快时，几个窗口会叠成 7 次全树扫描同时在跑，彼此抢 CPU 又让每次更慢）。失效只有两条——`.git/HEAD` 或其指向的 ref 变了（切换分支/提交/rebase），以及我们**自己**改过工作区（`stage/unstage/discard`、编辑器 `files:write` 都会 `noteWorktreeChange(root)`，`repositoryRootOf` 从目录往上找 `.git`）。**不要**改成看工作区 mtime：任何进程在写文件都会让整棵重算，等于不缓存。用户主动刷新的 `refresh: true` 跳过缓存，也不搭别人那次没跑完的顺风车。
- Pinned / Projects / Recent 互斥，归属经 `stats:move-session`；拖放判定在 `session-dnd.js`（`rowDropPosition` 的分档唯一实现：中间一半 = 嵌套 / 进入，上下各四分之一 = 插到前后，不认修饰键）。分组行与会话行同一套落点规则：拖到分组中间变成它的子分组、拖到会话中间成为它的子会话，拖到上下边缘排序——分组顺序在 Projects 的 groups 数组里，会话的手动顺序在 `userData/session-sort.json`（`pinned` / `project:<groupId>` 各自一份，跨工作目录也能排）。Recent 按时间排、不参与手动排序，只接嵌套与「拖去别的分区 / 分组」。落点提示不用描边或单边高亮：进入用整行浅底（`bg-info/15`），插到前后用行间一条圆角细条（`DropBar`）。
- 会话行共用操作列/图标列/名称栅格；状态优先级沿用 `session-state.js`，error 红点由后续 completed 清除。
- 每个会话行右端都显示最近结束时间，只有 Recent 额外带目录名；Recent 之外的 Pinned / Projects 只在 24 小时内活跃过时给时间（`relative-time.js` 的 `activeTimeLabel`），否则整列都是 15d / 4d 的噪声。分组行只有**折叠时**才在右端留这个 24 小时内的相对时间（展开时下面每个子行各有自己的时间），从不画条数；分区标题右端两样都不画（条数与精确时刻只进 tooltip，`collectGroupDigests` 汇总子树）。收起的分组只留那一行——不渲染子行，也不预览最近几条。
- 会话右键菜单 = 固定项（Fork / 改名 / 标记 / 删除等；Fork 复用 `chat:fork`）+ 插件动作：插件项来自清单 `desktop.sessionMenu`，由 `renderer/src/session-menu-plugins.js` 收集（读 `readPluginsDetails`，用户插件也在里面），页面只转发 `pluginId + pluginAction` 到 `window.mica.chat.sessionMenuRun` → `chat:session-menu-run` → `mica/sessionMenu/run`；插件回的 `copyText` 由页面写剪贴板（`transport.js` 的 `copyText`），`message` 进 toast。没开过标签页的会话按需起一个 app-server 取快照，不需要页面先有 chat run。
- 会话行右键与对话区右键（`ChatView` 的 `ChatContextMenu`）用的是同一份插件项和同一个执行器 `runSessionMenuPluginAction`：两处各写一遍会让同一个插件在两个入口表现不一样。对话区那一份插在「分享链接」之后、Clear 之前（危险项永远排最后），没有会话时禁用；结果在对话里落一条 notice，侧栏那处进 toast。固定项里还有一个「查看详情」，和侧栏会话行的「查看详情」是同一个弹窗（按需加载的 `stats/SessionDetailModal`，含用量页签）；两个入口渲染同一个组件，不要为其中一处另写一份详情。
- 父子关系（`parentSessionId`）是会话树的唯一事实来源，只改渲染顺序，**不区分来源**：sidecar
  子会话、fork 分支与手动拖出来的层级共用这一个字段，侧栏不给它们加标签或图标。父行在前、
  紧跟它的子树（`session-nesting.js` 的 `nestSessions`），父会话不在当前分区时子会话当顶层，环与
  自指都退化成顶层。折叠状态是页面内 Set，父行折叠时用 `mergeRowStates` 代显子行状态；子行继承
  父行的分区与搜索命中，也不参与手动排序——拖到会话行正中＝成为它的子会话（拖进自己的子树会被
  拒），拖到别处＝先解除父子关系再换分区。写盘走 `stats:set-session-parent`
  （`host/session-parent.js`）：只在没有 turn lease 时直接改文件，`parentSessionId` 固定写在
  `snapshot` 之前（头部读取靠这个位置判成环），`updatedAt` 不动，否则调整层级会把会话顶到
  Recent 最前面。
- 会话搜索共用 `mica-web-shared/session-search.ts`；正文搜索每会话最多 20k 字符，默认最近 3 日、最多 600 个候选，截断须告知。
- 上下文统计按整条消息 JSON 估算并排除媒体 payload；compact / rewind 后用 staleInput 说明。

### 侧栏入口与整页设置

- 会话侧栏顶部保持一行入口的固定顺序：New Session / Stats / Settings / 插件声明的侧栏入口 / Plugins。插件入口由清单 `desktop.entry` 声明、按清单顺序渲染（`Connections` 是浮层卡片）；`placement: "header"` 的入口不占侧栏位置，画在主区顶栏右侧那一簇的最左边（`Schedule` 是整页 + 顶栏图标——顶栏只有 32px 高，所以只画图标，窗口类图标仍贴最右），宿主只画一行与容器，不知道里面是什么；加一个桌面插件只改插件目录，不改侧栏代码。Plugins 虽然在最末，但它只是一个页面入口——点它进插件整页（目录 → 点一张卡进详情），不做下拉面板、不在侧栏里列插件。
- 设置与插件页都以覆盖整窗的一层打开（`configPage` 状态 + `fixed inset-0` + 顶部拖拽条），不在对话区右侧再开一栏：配置页自带侧栏导航，套两层侧栏只会把内容挤窄。返回走配置页侧栏顶部的「返回对话」，主区顶栏的返回只管 Files / Stats。
- `SettingsView` 每次打开重新挂载，`key` 含 section 与插件 id：入口决定落在哪一页，残留的上一页导航会让人以为点错了地方。

### 受控浏览器与终端控制

- 主进程业务例外：`src/main/browser/`、`src/main/terminal/`、`src/main/system/`；端点目录各自唯一（`browser-docs.js` / `terminal-docs.js` / `system-docs.js`），路由、文档与 MCP 操作清单同源。系统检查只服务宿主自己（`MICA_SYSTEM_SOCKET` 由运行时经 `host/system-checks.js` 直连，不做 `/remote/*` 代理、不暴露 MCP），探测用 `systemPreferences`、跳转用 `shell.openExternal`（renderer 的 `window.open` 只放行 http(s)）；配置页插件详情的「运行条件」经 `readDesktopChecks` / `openDesktopSettings` 两个桌面专有动作读它。
- 远程访问默认只有分享视图：路径分类在 `host/access-core.js` 的 `classifyRemotePath`，放行判定在 `host/remote-access-core.js` 的 `remoteAccessDecision`，接线在 `server/index.js` 的 `isLocalClient` / `shareLinkSessionId`（后者用 `chat.js` 的 `sessionExists`，且必须看原始 `req.url`——`requestPathname` 已经吃掉查询串）。分享链接即凭据：只有「指向存在会话的 `/share?session=`」才签发 `mica_share_scope` cookie，裸 `/share` 与编造 id 都换不到。要让别的机器用完整界面，用侧栏 Connections 卡片的「其他机器访问这台机器」（口令默认 `0000`，策略落 `$MICA_HOME/remote-access.json`，`secret` 由 `readRemoteAccessPolicy` 补齐落盘）；口令登录页与 cookie 签发只在 `server/index.js`。`MICA_DESKTOP_TRUSTED_CLIENTS` 仍可整段免密。
- 两者都走 Unix socket，由运行时在既有端口上代理；agent 侧各暴露一个 MCP tool `control`。
- 浏览器窗口默认隐藏；依赖显示面的操作走 `withShownWindow` + `browser-reveal.js`（`setOpacity(0)` + `showInactive`，空闲 1.5s 收起）。
- 同一 `persist:mica-browser` 分区共享 Cookie；服务保持 Origin/Host 守卫。
- 终端是一个会话一个后台窗口，`node-pty` 真实 pty + `@xterm/headless` 屏幕镜像；窗口按需创建，关窗只 hide。
- 读屏前必须等已排队输出解析完，并给该等待硬预算（读屏 2s、`wait` 用剩余超时）。
- `wait` 默认 `maskEchoedInput`（`skipEcho: false` 关闭）；`expectExitCode` 不匹配立刻返回实际退出码。
- 会话存在进程内，最多 12 条活着 shell；`sweep()` 每分钟回收，窗口可见的不回收。
- 写入类操作校验 `x-mica-owner`（防串台，不是权限边界）；读屏与 `wait` 不拦。
- 纯 Web 宿主无主进程，`/remote/terminal/*` 回 503。

### 日志与性能

- **诊断日志只有一份实现**：`@packages/mica-diagnostics`（桌面 `host/log.js` 只是转发 + Electron 两个通道）。运行时、Electron 主进程、`mica app-server`、TUI、`mica exec` 都写同一套 JSONL：落 `resolveLogDir()`（macOS `~/Library/Logs/mica`，与插件日志同目录），2s 批量 flush，留 1000 条环形缓冲；保留 7 天、总容量 256 MB，超了从最旧的删。日志**不放系统 temp**：temp 每次登录被系统清空，重启后就只剩当次运行，跨天的问题无法回头查。`MICA_LOG_DIR` 覆盖目录（测试与隔离实例用），`MICA_LOG_LEVEL` 调级别（常驻宿主默认 info，一次性命令默认 warn）。
- **每个常驻进程自报内存**：`startMemorySampler({ host, describe })` 每 30s 一条 `scope: 'mem'`（`rss` / `heap` / `ext` / `ab`，附会话 id 或宿主数）。运行时报 `host: 'runtime'` + `hosts/busy`，每个 app-server 报自己的会话 id（那才是占用大头，一个能有 1GB），主进程额外带 Electron 各进程类型的分布（`app.getAppMetrics()`），TUI 报当前会话与模型。配置页 Performance 的「进程内存」按进程列出当前 / 峰值 / 窗口内增长；`mem` 不进耗时聚合、也不进事件流。
- 崩溃现场必须有落盘的一行：会话宿主非正常退出记 `host.exit`（退出码、信号、stderr 尾部 2KB），spawn 失败记 `host.spawn-failed`，主进程听 `render-process-gone` / `child-process-gone` / `unresponsive`，app-server 的 `uncaughtException` 先写日志再通知客户端。
- 通道耗时只在 `handleInvoke` 用 `logger('invoke').timedResult()` 量一次；超过 `SLOW_MS`（默认 300ms）记 warn。它还会把「调用成功、返回体里带 `error` / `ok:false`」的那些记成 `kind:'failed'` 并在聚合表计入 `fails`——大量通道（git/stats/plugin-host）把失败包在返回值里而不抛，不这么做日志里就只剩一条耗时，分不清是超时、被取消还是真报错。新增功能不要自己再包一层计时。
- `chat:compact` 额外记一条 `compact.finished`（请求模式、子进程回报的 strategy、前后 token 估算）——只按通道计时分不出本地清理与模型摘要。
- 只读会话顶层字段（cwd、标题等）用 `host/session-file-head.js` 读文件头，不要为单个字段整份 `JSON.parse`：最大的一份会话 52MB。
- 渲染层 `perf-probe.js` 只采样、`log-probe.js` 只记错误，两者交给同一写入器。
- 采样全量记录，不做「异常才写」；隐藏窗口的 `lag` 记 null。
- 面板轮询跟可见性走（Stats 30s + 可见且聚焦；会话列表 10s，回到窗口立即补一次）；配置页 Performance 的聚合在 host 侧做完。
- **插件面板只在看得见时轮询**：`chat-cache` 保留 5 个 ChatView，每个都挂着快捷条；`PluginQuickBar` / `PluginPanels` 必须带 `visible`（`ChatView` 的 `visible` 直传），隐藏实例不轮询状态行（30s）、不预热菜单、不刷新抽屉（4s）——否则一天几千次 `chat:plugin-panel-view`，还会把没人看的会话宿主一直喂活而不被回收。host 侧再按 `id + pluginId + cwd` 合并 3 秒内的重复读（`PANEL_VIEW_REUSE_MS`），动作不做合并。
- 顶栏 Git 徽标（`git:change-counts`）是整棵工作区扫描，自己一层 20s 缓存 + **先回旧值、后台重算**；`worktreeSignature`（HEAD）变了或 `worktreeEpochOf` 变了（stage / discard / 保存文件）时不许回旧值。
- 会话列表整份返回，但内容没变时按字段指纹（`session-state.js` 的 `sameSessionSnapshot`）跳过 setState，空闲轮询不触发重渲染。
- `stats:changed` 只在**真有变化**时让页面重读：收尾那一帧由扫描器带上 `parsedFiles` / `added`，两者都是 0（这一轮没读任何文件、没有新会话）就不广播；索引补齐过程中的进度帧带 `partial: true`，侧栏（`App.jsx`）直接忽略它，统计页只在可见时跟。之前每批进度都推、页面每批都重读千人列表，一天能攒出上千次多余的全量序列化。
- 会话统计走磁盘索引：`host/stats-scanner.js` 按文件签名把每个会话的投影缓存在 `$MICA_HOME/desktop-stats-index.json`（与 `sessions/` 同级，不是会话文件），进程重启只解析变过的文件。首次构建（升级后第一次）分批让出事件循环，并经 `stats:changed` 推送进度，界面「逐渐填充」而不是空白几秒。
- `stats:read` 的载荷是「会话 × 本地日」聚合行（上千会话约 1 MB），不是逐条 usage 事件；区间切换只是对日行做加法（`renderer/src/stats/scope.js`），不要再把事件级明细塞回载荷。跨会话的用量去重靠扫描器的「身份归属表」（最早创建的会话拥有），`stats:session-detail` 与列表共用同一份归属。
- 每一次模型请求都要能在统计页上看到，所以来源只有一个口径（`mica-web-shared/usage-source` 的 `usageSourceOf`）：`main` 主对话、`delegation` 委派、`plugin`（+`pluginId`）插件、`helper` 内核后台。判定顺序是 `origin: 'delegation'` / `initiatedByCallId` → 委派、`origin: 'plugin'` / `pluginId` → 插件、其余 → 内核 helper；host 的日行聚合与会话详情都调这一份，不各算一套。插件起的子代理由宿主写 `pluginId`（`ctx.subagents.run/background` 记到插件名下，委派带 `initiatedByCallId` 记成 `delegation`）。
- 没有会话可写的请求（`mica commit` 这类一次性插件命令，含桌面右键 commit；以及 `mica plugin-action` 里真的问了一次模型的插件动作）追加进 `$MICA_HOME/usage-ledger.jsonl`（形状与解析唯一实现在 `mica-web-shared/usage-ledger`，写入在 `apps/cli/src/plugins/usageLedger.ts`）。扫描器把它读成「按 cwd 分组的无会话行」（`ledger: true`、`id: null`），并进概览 / By model / By source / By project，但不冒充会话：不进 `scanMeta`、不算进「Active sessions」、不进 By session。不要为此跨进程改写会话快照——那会绕过 turn lock。配置页的「测试连接」仍不入账（`probeModelConnection` 只是一次连通性探测，没有回答）。

## 10. UI 规范

### Ink

- `mica-ui` 只管组件/store，runtime 经 `MicaUiRuntimeBridge` 映射。
- Ink stdin 到 `parse-keypress.ts` 前保留 Buffer；Alt 两种编码都要支持。
- 编辑撤销/重做历史保存在组件 ref；`displayContent` 只改展示。
- 工具行占一行（`wrap="truncate-end"`），思考整段折行。

### 配置页

- `mica-config-ui` 是唯一实现：config-web 用 HTTP 托管，desktop SettingsView 直接嵌组件，不起 iframe 或子进程。
- 两个宿主都整页打开：桌面端点左下角设置按钮、左上角插件菜单，都以覆盖整窗的一层渲染 `<App>`（`section` 定位到 Config 或 Plugins、`pluginId` 定位到插件详情，`onClose` 渲染左上角返回）。页面内导航由侧栏切换，不做弹窗内嵌。
- 新页面只用既有积木：`PageFrame`、`Button`、`Tag`、`Switch`、`CollapsiblePanel`、`SettingsGroup`、`SettingRow`、`SplitView`、`ControlEndpointList`；文案走 `labels.ts`。
- 三块骨架：`PageFrame`（窄页头 + 内容区）、`SettingsGroup` + `SettingRow`（一页一块面，行间分隔线）、`SplitView`（左列表 + 右详情）。
- 折叠按容器宽度（`@container page (max-width: 860px)`），不按视口。
- Config 页只按字段编辑 providers；`mcpServers`、`capabilityDefaults` 只读展示并跳到各自页面。
- 服务商在分组里是一行：折叠显示 id（唯一的名称，不再另设显示名称）/协议/地址/模型数，展开接字段行；有错误强制展开并标「待修正」。
- Sessions 左栏的会话信息由 `src/server/sessionHead.ts` 只读文件头 8KB 解析，两个宿主共用。
- 浏览器侧（`web/`）只能 import 纯子模块：`mica-plugin` / `mica-common` 的包入口会顺带导出读写文件的模块，dev 下整页白屏且 tsc 与单测都看不出来（`web/browserImports.test.ts` 静态挡住）。
- 密钥类输入统一用 `web/components/SecretInput.tsx`：默认密文 + 眼睛按钮切明文，明文状态在组件内，收起或换页自动回到密文。
- 配置页不提供 effort 开关：由模型规则按模型名决定。
- 表单转换唯一实现 `web/configDraft.ts`；写入保留未知键，已知键固定顺序，可选字段留空即删键。
- Capabilities 页改 `config.capabilityDefaults`，读写实现在 `src/server/capabilityDefaults.ts`。
- 插件页是「目录 + 整页详情」：目录按官方 / 用户分组渲染卡片网格（停用的卡片压暗），每张卡显示清单 `icon`（`web/pluginIcons.tsx` 的映射表，未登记回落 `puzzle`）与一枚启停开关（卡片是「外壳 + 打开详情的按钮 + 右上角的开关」，开关不能塞进按钮里）；点开进入单插件详情页，返回走详情页自己的返回行。**开关是唯一的启停控件**：卡片脚注与详情页信息表的「加载」行只说装配结论（已加载 / 已跳过 / 加载失败 / 尚未加载，停用时是「已停用」），不要再放一枚「已启用」标签去重复开关的语义（唯一实现在 `pluginRunningStatus()`）。清单 icon 不参与内核逻辑，只在配置页呈现。
- 详情页右侧信息表只有标识 / 加载 / 目录 / 日志四行、单行省略；「日志」是路径链接（单击选「在 Finder 中打开 / 在 Mica 中打开」，⌘ 点击直接进编辑器，用的是 `PathLink` + 宿主的 `revealPath` / `openPathInEditor`），目录那行不是——官方插件的目录是仓库里的相对路径。插件里的文件清单不进界面（`PluginInspection` 不读目录），用户要的是「装没装上」而不是文件浏览器。
- 插件设置在详情页按清单渲染：开关用共享 `Switch`，数字用 `config-stepper`（−/输入/+ 共用一条边框，单位定宽）。
- 所有页面不设保存按钮：`useAutoSave`（400ms 防抖、串行写盘、卸载补发）；校验不过不写盘。
- 新建/删除/放弃用 `DialogHost` 的 confirmDialog / promptDialog。
- 改配置页后跑 `bun run build:config-web` 并提交 `generatedStaticAssets.ts`。
- 样式限定 `.mica-config-ui`；桌面 app.css 与配置页共用 Darcula 暗色 token（亮色是另一层 DSH 设计系统 token，见下条）；页面级 html/body 高度链归宿主。
- 主题是默认能力：桌面 UI 支持 浅色 / 深色 / 跟随系统，设置在 Settings → Appearance（偏好存运行时界面状态 `theme`，默认 `auto`，`apps/desktop/src/renderer/src/theme.js` 是渲染层唯一入口）。颜色只用 `--color-*` / `.mica-config-ui` 容器变量：暗色值在 `@theme`（Darcula），亮色值在 `html[data-theme='light']` 覆盖块；切换只改 `data-theme` 属性，不重载页面。xterm / monaco 读不到 CSS 变量，必须订阅 `theme.js` 的 `subscribeTheme` 同步 options/主题。
- 亮色的取值**逐档取自 DeepSeek harness 开源仓库**（`deepseek-ai/deepseek-harness` 的 `packages/client/ui-theme/src/styles/design-platform.css`：`--dsw-static-neutral-bluish-*` 调色板 + `--dsw-alias-*` 语义层；对话各层的用法看 `packages/client/ui-chat/src/client/chat/*.module.css`），不是照着截图调出来的，要核对就 `dsh web` 起一份真界面读计算样式。改亮色前先看那份文件的语义：正文、菜单、标题都是 `label-primary`（neutral-bluish-1000 近黑，不是中灰；亮色顶端两档因此并成同一个值），过程文字（工具行/思考/时间戳）是 `label-tertiary`（neutral-bluish-600），用户消息带是 `--dsw-specific-bubble`（deepseek-50 淡蓝），行内代码是 `markdown-inline-code`（浅底 + `border-l1` 描边），面板是 `neutral-bluish-50`，选中行是 `neutral-bluish-100`（= `--color-active`，会话行/导航/文件树都用它，不要用洗色层凑），洗色层是带蓝调的 `rgba(38 49 72, α)`。
- 因此亮色有五个专属 token 不能回退成通用灰阶：`--color-nav-fg`（侧栏/菜单行）、`--color-bubble`（用户消息带）、`--color-inline-code{,-bg,-border}`（行内代码药丸）、`--color-heat-empty`（热力图空格：亮色 canvas 是纯白，铺在 panel 卡片上等于没有网格）。`theme-tokens.test.js` 钉住了这些锚点，值要改就一起改测试并写明理由。

### 界面审查清单（新增页面、面板、弹窗必查）

- 控件只用 `@mica-config-ui/web` 那一套（`Button` / `Tag` / `Alert` / `Empty` / `Switch` / `Checkbox` / `SelectMenu` / `DateField` / `Segmented` / `text-input`），原生 `<select>`、`type="date"`、`type="checkbox"` 一律不用——`web/noNativeControls.test.ts` 按源码挡住，插件页面同样在范围内。
- 选中态不要用 `border-left` 或 `inset ... 0 0` 造竖直亮条，用背景、圆角边框与字重区分。
- 一行里的控件必须等高：原生 select / checkbox 要么 `appearance: none` 自绘，要么用共享组件。
- 禁用态只掉颜色，尺寸、边框与位置不变。
- 共享 `Button` 只在 `icon` / `loading` 存在时才输出图标格。
- 同一动作区的主次按钮统一高度；文字主按钮 `flex: none` + 不换行。
- 标签在控件上方，不要把说明词塞进控件行；复合控件放在同一条边框里。
- 条目列表不要靠 `padding-left` 造缩进，符号用 `li::before` 画在符号列里。
- 同一列的单位给固定宽度，避免每行步进按钮错位。
- 页签只有一种形态：统一复用 `.session-tabs` / `.session-tab` 的下划线样式。
- 开关用共享 `Switch`；枚举值经 `labels.ts` 映射成中文再上屏。
- 长文本单行省略并带 `title`（`min-width: 0` + `text-overflow: ellipsis`）。
- 说明文字只留一处；状态放到操作行或状态列。
- 页头路径由 `PageFrame` 收拢成「…/末三级目录/文件名」，完整路径留在 `title`。
- 行内动作按钮用 `variant="ghost"`，破坏性的用 `variant="danger-ghost"`（红字、不画常态边框）；列表行按钮写 `width: 100%`。
- 不要把字段逐个包成卡片；设置项用 `SettingsGroup` + `SettingRow`，列表/详情用 `SplitView`。

### 移动端

- <768px 单栏 + 会话抽屉，Files 树/编辑器切换；`?layout=mobile|desktop` 可预览。
- safe-area 处理；表单字号至少 16px（Monaco 除外）。
- 根高度取 visual viewport / innerHeight / clientHeight 中明显更小的信号，保持 `--vvh-top` 补偿。
- `TerminalKeyBar` 经 `term.input()`；xterm 使用 DOM 渲染器，字号/颜色走 options。
- xterm 软键盘补发仅覆盖空格与 A–Z，须 preventDefault；上游 #5614 仍处于 closed（未合并）状态，`@xterm/xterm` 6.0.0 仍会丢这些 input，删除前必须在真机复验。

## 11. 构建、验证与交付

### 构建

- `bun run build` 产出 `dist/mica`，默认安装到 `~/.local/lib/mica`；`~/.local/bin/mica` 是薄 launcher。
- `mica.build.env` 定义品牌键，同名环境变量优先；改键同步构建文件与本文。
- models.dev 种子用 `bun scripts/update-models-dev-seed.mjs` 刷新。
- 发布链路 `build-binaries.yml`：checks / desktop-checks 任一失败，build 与 publish 整段跳过。
- 打包按平台取 node-pty 原生产物（`scripts/stage-node-pty.mjs`）；`spawn-helper` 只属于 macOS。
- desktop 用 `scripts/run-parallel.mjs` 并行跑三份构建；Vite 8 需搭配 electron-vite 6。
- `npm run build:app` = 三份构建 + `electron-builder --dir`，只产出可运行的 `.app`；DMG + zip 是发布产物，走 `npm run build:mac`。后者省不掉：`hdiutil` 单压 277MB 的 app 就要 9s，zip 与 blockmap 再加 6s，两者串行约 20s，占整个 `build:mac` 的四分之三。
- 品牌 SVG 唯一源 `apps/desktop/resources/icon.svg`，位图由 `npm run icons:generate` 生成。
- 官网架构图只改 `apps/website/architecture/*.architecture.json`，再由 Archify 生成。

### 验证

- 局部改动跑相关测试 + `bun run typecheck` + `git diff --check`；全量测试约 90s（unit ~25-30s + process ~55-60s），仅发布、跨慢套件或 CI 要求时跑。
- `bun run test` 走 `scripts/run-tests.mjs`：先 `scripts/prune-test-temp.mjs` 清掉 `os.tmpdir()` 下过期的 `mica*` 测试目录（保留 `mica-tasks`，`MICA_TEST_TEMP_MAX_AGE_HOURS` 默认 6h），再串行跑两个 project，unit 失败即跳过 process。`test/globalSetup.ts` 用 `MICA_TEST_ROOT` 作整轮唯一的临时根并在结束时删除；worker 是被直接杀掉的，`setupFiles` 里的 exit 钩子不会触发，清理只能放在 globalSetup。
- 测试分两个 project（`vitest.config.ts`）：`unit` 是进程内单测、按文件并行；`process` 是真实子进程 / PTY / TUI 的 E2E，文件串行、文件内用例并发。慢的根源是每个用例 spawn 一次真实 `mica`（冷启动 1–1.5s），所以新增 E2E 用例要用 `it.concurrent` 语义（每用例自带 mock provider 与 `MICA_HOME`），不要把 `process` 项目丢回并行池：它和 unit 的 worker 抢 CPU 时会打挂 `btw.pty`、turn lease 这类时序敏感用例。
- `testTimeout` 显式给定而不是沿用 Vitest 默认 5s：unit 里有真实 git 仓库与文件 I/O，process 的 PTY 用例内部就按 20s 等待。机器一忙（多个 worker + 开发者自己的进程）5s 会打挂与代码无关的用例。并发上限同理：`unit` 的 `maxWorkers` 固定 4、`process` 的 `maxConcurrency` 固定 3，再往上不更快，只是把时间换成偶发超时。
- 根测试用 Vitest / Node；`PtyDriver` 仅 Node/vitest 可用，Bun 用 manager + Node helper。
- `app-server.flows.test.ts` 用本地 mock provider，无需真实 key；resume 用隔离 `MICA_HOME`。
- 允许使用用户真实 Mica 配置中的 API 做少量、与当前改动直接相关的冒烟测试、复现和验证，无需逐次征求同意；仍使用隔离的 `MICA_HOME`，不改写原配置、不输出凭据，临时凭据副本用完清理。控制实际 API 请求总量，计入工具迭代、重试及 helper/subagent 请求；大量请求（批量评测、压力测试、长循环或大规模并发）必须先说明目的、预计请求量与成本范围，并取得用户同意，不能拆成多批少量请求绕过。
- PTY 真实 provider 冒烟须显式开关并指向真实配置：单轮用 `MICA_PTY_SMOKE=1`，用户流程用 `MICA_PTY_FLOW_SMOKE=1`，两者都读 `MICA_PTY_SOURCE_HOME`（默认 `~/.mica`）。
- desktop 改动至少 `npx eslint src/` + `npm test`；新增运行时依赖另构建 server 验证自包含。
- 浏览器与终端控制必须真窗口验证，单测不能替代。
- 起测试实例要同时给 `MICA_HOME` / `MICA_DESKTOP_USER_DATA` / `MICA_DESKTOP_PORT` 与独立 `--user-data-dir`。
- 长进程放后台任务，用 `wait_for`（http / port / 文件）等就绪，不用大数字 `sleep` 硬等。
- 临时探针脚本命名 `.probe-*.mjs` 并放仓库内，用完立即删除；交付前 `git status --short` 确认无残留。
- 判断服务不可用先看证据（curl、lsof、日志 ready 行）；整页空白先查渲染期异常。

## 12. 对外文档与演示素材

- README 面向使用者；`docs/` 放稳定设计；`apps/website` 是官网；`blogs/` 是开发记录；包 README 只讲单包 API 与边界。
- 对外文案不依赖个人路径与未公开项目；不写虚构成果或无证据排行。
- 命令表必须与代码一致（`ALLOW_DURING_TURN_COMMANDS` 与 `allowDuringTurn`），新增/删除命令同步 README、命令页与 `packages/mica-builtin-commands/README.md`。
- 截图必须可复现：脚本化 mock provider（`scripts/demo-mock-provider.mjs`）→ 隔离 demo home → 运行时 → `chat:start` → 受控浏览器截图。产物固定三个，内容只用示例数据。
- 评测数据唯一来源是 `apps/website/public/benchmark-data.json`；图由 `bun scripts/generate-eval-chart.mjs` 生成，不手改 SVG；不得称 Terminal-Bench 成绩。
