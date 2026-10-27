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
npm run build:unpack       # 同上但 electron-builder --dir，本地验证用
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
2. `apps/cli/src/index.ts` 在加载 config/runtime 前分派 version、models、exec、commit、compact 与交互模式；`startup/validate-config.js` 补齐默认值。
3. `Application.start()`：Ink → 配置校验 → 必要时选初始模型 → runtime、session、registry、hooks、services、agent/session manager、UI bridge、subagent manager。
4. 设 active context → 注册内置插件 → 用户插件 `setupAll` 并写 `plugin-status.json` → 启动 UI bridge 与 runtime。
5. 失败时显示修复提示、清理资源、设置 `process.exitCode = 1`。

- `apps/cli/src/app/activeContext.ts` 是应用上下文的唯一全局入口；底层不 import `Application.ts` 取状态。
- 多 agent 命令使用 `createActiveAgentProxy` / `createActiveSessionControllerProxy`。
- 插件 `ctx.onDispose()` 登记的资源逆序回滚；新增 capability 同步登记 disposer。
- provider/model/effort/role 切换先 busy guard，完成后 `reloadConfig(false)`、保存 session、同步 UI。
- 非空会话跨协议切换由 `applyConfigSwitchUpdate` 阻止；恢复旧会话协议不匹配时降级恢复 model/effort，不静默丢历史。
- `/resume` 与 `--resume` 切到会话自己的 `cwd`（目录缺失时保留当前目录并提示）；app-server 的 resume 以客户端传入的 cwd 为准。

### Turn 与队列

- `LocalRuntimeController.submit()` 先 trim 并解析命令，再经 `input:received` guard hook 处理普通输入；未被处理的输入进入 turn。
- 每个写 session 的 turn 必须持有 turn lease，在 `refreshFromStore()` 之前获取；拿不到就拒绝。lease 必须在 `turn:after` 前释放，finally 保留幂等兜底。
- 保存顺序：`running` → 每次工具迭代 checkpoint → 成功 assistant + `completed`；失败/中止存 `error` / `aborted`。非 completed 会话在 `/resume` 标 `（uncompleted）`。
- turn 启动即保存本轮用户输入；headless 只对 `input.source === 'ui'` 写入，后续 checkpoint 不得重复追加。
- `MessageQueueService` 的每个操作都带 owner；pending input 只放 `pendingInputs`，不提前追加对话或 provider history。
- TUI 与 desktop 的 Enter / Tab / Shift+Tab 统一 `after_iteration`；`after_turn` 仅供 `/loop` 等显式请求。
- 当前 turn 没有后续迭代时由 message-queue 的 `turn:after` 兜底；仅 `completed` 自动发送，失败/中止保留输入供撤回。
- 两端都支持 Shift+← 撤回；desktop 的 host 槽走 `mica/queue/recall`。

### 重试与中止

- turn 级重试最多 5 次、间隔 10s；仅在错误可重试且本轮没有非只读工具调用时自动重试，先恢复 pre-turn snapshot。
- provider 的 `withRetry` 只在尚无文本/工具输出时重发（thinking 不算输出），退避 2/4/8/16/30s。
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
- `buildSystemPrompt()` 默认读 `mica-agent/prompt/system.md`；自定义 role 只替换 `<system>`；cwd 的 `AGENT.md` / `AGENTS.md` 合并注入，路径按 live cwd 解析。
- skills 只以索引进入 system prompt。
- `AgentRuntime.setCapabilities()` 保存会话开关；prompt、工具定义与执行校验读同一份状态。未定制的会话跟随 `config.capabilityDefaults`，`resetCapabilitiesToDefaults()` 回到跟随默认。
- effort 的档位名就是模型在 models.dev 声明的真实取值：`minimal`/`max`/`xhigh` 各是各的，不归一化、不落别名；只有开关的模型是 `none`/`on`，只声明 budget 或没有 reasoning 的模型没有档位。没有任何档位的模型不发推理参数，也不在 `/effort`、desktop 选择器里凑五档；models.dev 没收录的模型由 provider 的 `effortLevels` 声明档位。切换模型时 clamp 到该模型自己的档位并同步 context window。metadata 优先级：磁盘缓存（24h）→ 内置 models.dev 种子 → 在线刷新。
- 只有 `get_model_url` 动态 provider 查询模型列表，结果不写回 config.json。

## 5. 配置、会话与存储

- `MICA_HOME` 覆盖全部用户路径，默认 `~/.mica`；品牌目录经 `brand.ts` 解析。
- `PersistedMicaConfig` 只存静态字段；运行时用 `stripRuntimeFields` 去除 provider/model/effort/contextWindowSize。
- 配置迁移与语义校验统一在 `startup/validate-config.js`，配置页保存复用它。
- 仅当所有 provider 都没有 api_key 时，`envProvider.ts` 从 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 合成运行时 provider；环境 provider 永不写回 config.json。
- session 是 version 1 JSON；新增字段要有版本策略、默认值与 sanitize，字段类型不对按损坏拒绝。
- 会话级状态都在快照里：`capabilitySelection` / `capabilitiesCustomized`、`pluginState`（插件自己的 JSON）、`notes`。`startNewSession` 清空，resume/fork 沿用，rewind 随 checkpoint 回滚。
- `subagentUsageHistory` 独立于主 `usageHistory`；fork 清空两类历史，只保留描述继承上下文的 `lastUsage`。
- compact 保留 `lastUsage` / `usageHistory` 供 Stats 对账；界面 ctx 优先读 `displayUsage`。
- 无手动标题时取最后一条真实用户消息（最长 60 字符）；自动改名不得覆盖 `titleSource === 'manual'`。
- `$MICA_HOME/session-index.json` 是可重建缓存，不进 `sessions/`；索引 v2 记录读不出摘要的 `rejects`（id + size/mtime），避免每次全量重扫。
- `sessions/.turn-locks/<id>.lock` 是跨进程写入的唯一事实来源（`wx` + owner pid 存活判定）；孤儿锁在 acquire 时回收。
- 垃圾占位须同时满足：默认占位标题、无对话、无 usage；`turnState === 'running'` 永不隐藏或删除。

## 6. Headless 与 app-server

- `HeadlessTurnExecutor` 不触碰 Ink/UI；每轮顺序：取 lease → `refreshFromStore()` → `reserveRunId()`；取锁失败返回 `busy-remote`。
- 每轮都发 `turn:finish`，结果只有 completed / aborted / error；排队轮次同样逐轮取 lease。
- `HeadlessPluginHost` 是 exec / app-server 共用的插件装配层；MCP 显式初始化，不注册输入框、命令 UI 与用户文件插件。
- `attachPluginLayer()` 同步替换 executor queue，避免插件写入与 loop 读取不同实例。
- `mica app-server` 是每会话常驻进程；stdin/stdout 使用 Codex v2 JSONL。framing 在 `mica-runtime/codexProtocol.ts`，事件投影在 `runtime/CodexProjector.ts`。
- `mica/*` 扩展通知直接送 renderer，不进 turn 重放缓冲：queue、tasks、BTW、history、capabilities、turn retrying。
- `mica/capabilities/get|set` 读写会话能力；运行中 set 返回 `ok:false`。
- `turn/start` / `mica/turn/editMessage` 可传 role，由 host 在启动 turn 前应用；edit 时必须在 `loadSnapshot()` 之后应用。角色缺失只 warning 并保留原角色，不为切角色重建 host。
- `mica/notes/get|set` 读写会话笔记，落盘跟随本轮 checkpoint，不在 handler 里抢占 lease。
- 改名先找常驻 host 调 `SessionController.renameCurrent`；无 host 且无其他进程 lease 时才直接写盘。
- `mica/turn/editMessage` 把 provider history 截断到目标用户消息之前，再用新文本重跑；定位共用 `mica-common/promptText.ts`。启动失败恢复原快照。
- `mica exec` 默认人读文本，`--json` 为 Codex ThreadEvent JSONL；保留 codex-family 参数兼容（`--cd`、`-c`、`--` 与裸 prompt）。
- resume / chdir / MCP 初始化失败降级继续；只有 resume 失败发 Codex error。unhandledRejection 记 warning，uncaughtException 发 error 后退出。

## 7. 扩展：插件、命令、工具、MCP、Skills

### 插件

**插件系统仍在持续迭代：实现一个插件时，把「这个插件是否需要先推动插件系统进化」当作设计的一部分，而不是只在现有能力面上将就。**

- 该先重构的信号：需求要读插件拿不到的数据、要靠改别人的数据伪造界面、要依赖宿主里的私有约定、要在多个插件间共享同一份可变状态、或必须为某个插件在宿主里写死分支——出现任一条都说明能力面缺东西，先重构插件系统，再在新机制上实现该插件。
- 重构方向是通用能力面：扩展 `PluginContext` 的某一面（`agent` / `commands` / `desktop` / `events` / `hooks` / `session` / `sessionState` / `settings` / `skills` / `tools` / `ui`）或复用已有能力；宿主里不出现具体插件名词，「加个 if 兼容某插件」不算设计。
- 重构与实现同一次变更交付：插件系统改动、受影响的官方插件、`plugins/README.md` 与本文章节一并更新；按第 1 节不留旧形态兼容分支，不为过渡保留双路径。
- 插件格式或能力面变更后跑 `plugins/**` 相关测试与 `bun run typecheck`；触及工具定义或 prompt 前缀时按第 1 节确认前缀稳定。
- 插件只有一种形态：目录 + `plugin.json`（`id` / `name` / `version` / `main` / `assets` / `dependencies` / `required` / `priority` / `mica.apiVersion` / `settings` / `requires`）+ 入口（`default` 导出 `setup(ctx)`）。格式与字段以 `plugins/README.md` 为准。
- 官方插件在仓库根 `plugins/<id>/`：清单登记在 `mica-official-plugins/manifests.ts`，入口登记在 `index.ts`。用户插件在 `$MICA_HOME/plugins/<id>/`，由 `FilePluginLoader` 启动时加载，id 一律加 `user.` 前缀。
- 没有 `plugin.json` 的目录、散落成文件的 `.js` / `.mjs` 都不是插件，加载器不猜。
- 启停状态在 `$MICA_HOME/plugins-state.json`（`{ "disabled": [...] }`）；停用的插件在注册阶段跳过，改完重开会话生效。
- `requires` 必须写全插件触碰的每一面：`agent` / `commands` / `desktop` / `events` / `git` / `hooks` / `prompt` / `runtime` / `session` / `sessionState` / `settings` / `skills` / `subagents` / `tools` / `ui`。缺一项整插件跳过，原因写进 `plugin-status.json` 的 `skipped`。
- 内置 skill 用 `ctx.skills.register()`：正文随包用 `import … with { type: 'text' }` 内嵌，元数据由 `micaSkills.parseMarkdown(SKILL.md)` 解析（frontmatter 是唯一来源），注册后与磁盘 skill 同权（prompt 索引 / `skill` 工具 / 会话能力开关）。磁盘上的同名 skill 优先，被遮蔽的条目从返回值 `skipped` 读出来并 `ctx.health.report()`。`baseDir` 必须是真能读到的目录——单二进制没有插件目录，所以随包资源要先落盘到 `$MICA_HOME/<插件目录>` 再注册（`plugins/computer-use` 是完整示例，源码内嵌由 `scripts/generate-computer-use-sources.mjs` 生成，改 `runtime/**` 必须重跑）。
- 运行条件由清单 `desktop.checks` 声明，取值只能来自 `mica-plugin/PluginDesktop.ts` 的 `DESKTOP_CHECKS`；配置页 Settings → Plugins 的插件详情里渲染成「运行条件」一节（状态 + 打开系统设置），插件跑在 app-server 子进程里、探测不到也渲染不了。新增一种检查项 = 在 `DESKTOP_CHECKS` 登记 + 桌面端实现探测器（`src/main/system/`）。声明了它就写 `requires: ["desktop"]`。
- `desktop` 能力只有桌面端 spawn 的 app-server 提供：`buildSpawnEnv` 注入 `MICA_PLUGIN_DESKTOP_HOST=1`（别用 `MICA_DESKTOP_HOST`，那是运行时的绑定地址），`runAppServer` 据此传 `desktopHost` 给 `HeadlessPluginHost`。CLI / TUI / `mica exec` 里没有它，依赖插件整块跳过。
- 设置项在清单 `settings` 里声明，类型 `text` / `password` / `textarea` / `select` / `number` / `switch`；数字项可带 `step` 与 `unit`，开关值只能是 `"true"` / `"false"`。值存 `$MICA_HOME/plugin-settings/<id>.json`，读取按 mtime 判断是否变化。
- 校验只有 `validatePluginSettingValues()` 一处：写盘前拒绝，插件读值时同样过一遍；非法值既不落盘也不静默通过。
- 用户可见故障（缺配置、外部服务拒绝、请求失败）必须 `ctx.health.report({ level, message, hint })`，不能只写日志。
- `ctx.logger` 按 pluginId 注入，同时写 `os.tmpdir()/mica-logs/plugin-<id>-<day>[-n].jsonl`（2 MB 分片、3 天清理、`MICA_PLUGIN_LOG=0` 关闭）。排查插件问题先看它。
- 插件感知会话用 `ctx.session`：`describe(owner)`（含 `cwd`，按工作区归档的插件读它而不是缓存进程 cwd）、`messages(owner)`、`rename(title, { owner, source })`；`source: 'auto'` 在人工命名过时被拒绝。
- 宿主形态由 `ctx.agent.mode` 回答（`session` / `one-shot`，后者是 `mica exec`），与迭代重写句柄上的同名属性一致；会改变成本或输出的策略只在 `session` 生效。
- 影响模型请求的插件用 `ctx.agent.onIterationRewrite(handler)`：在迭代边界改写接下来要发送的历史。句柄只暴露 `sessionId`、`mode`、`lastUsage()`、`getState()` / `setState()`、`compact()`。
- 委派子代理用 `ctx.subagents`：`registerType()` 注册类型（工具白/黑名单、写策略、`maxTurns`）、`run` / `background` 跑一个、`tasks.list|get|kill|wait` 管后台任务、`caller(context)` 解出本次调用所属的委派来源。机制（建子代理、用量记账、路径租约、完成回注）在宿主，策略（有哪些类型、工具形状、什么时候委派）在插件；子代理类型挂在注册它的插件名下，插件停用即消失。
- 官方插件：`todo`（进程内待办）、`session-notes`（会话笔记）、`session-tags`（会话颜色标签）、`session-rename`（每轮前自动起标题）、`auto-compact`（自动压缩）、`memory`（跨会话记忆：`user` / `memory` / `project` 三块 markdown 文件，`ctx.prompt` 注入会话内冻结的快照、`memory` 工具维护预算内的条目、turn:after 可选整理；整理可走宿主子代理，也可配独立的接口地址 / Key / 协议 / 模型，缺 `subagents` 时降级为独立接口）、`web-search`（`web_search` 工具）、`subagent`（7 种子代理类型、`agent` 工具、委派 prompt 段落与委派倾向设置）、`computer-use`（macOS 桌面自动化 skill：AX 元素树 + CGEvent 键鼠 + 截图，随包 runtime 落盘到 `$MICA_HOME/computer-use`，首次用到时 clang 编译 helper；权限状态显示在配置页插件详情的「运行条件」里）。
- 新增插件：建目录 → 两处登记 → 测试放插件目录内（vitest 覆盖 `plugins/**`）。

### 命令

- 命令实现放 `mica-builtin-commands/commands/`；装配放 `plugins/command-*.ts`，统一经 `index.ts` 导出。
- `/capabilities` 管理本会话 Tools / Skills / MCP 三页签开关（运行中拒绝提交，逐项切换）。工具分组由 `mica-tools/registry.ts` 的 `TOOL_FAMILY_LABELS` 唯一定义：只认声明过前缀的工具，至少两个成员才成组。
- 工具名一律 snake_case 全小写；历史遗留名登记在 `mica-common/toolNames.ts`，读取处统一过 `normalizeToolName`。
- 只在会话里注册的工具（`agent`、`todo_write`、`session_peers`）在配置页/设置页由 `RUNTIME_TOOL_DESCRIPTORS` 兜底列出，改描述要同步 `runtimeToolDescriptors.test.ts`。
- quick commands 另由 `apps/cli/src/plugins/commands/index.ts` 注册；新增/删除时检查两条路径与 README。
- 通过 `CommandRuntimeServices` / active proxy 注入依赖；耗时且改状态的命令走 exclusive task。
- turn 运行中是否可执行由注册时的 `allowDuringTurn` 决定；exclusive task 期间仅 status、task、agents、new。

### 工具与 PTY

- `mica-tools` 是唯一 registry，产品工具优先经插件 `ctx.tools.register()`；新增工具继承 `MicaTool`，声明 schema、展示、错误格式与 `readOnly`。
- `readOnly` 分类受 `MicaTool.test.ts` 约束：纯查询为 true；写文件、patch、shell、kill、PTY、wait 为 false。
- 执行类工具按「启动 / 等待 / 查看」拆开：`run_shell` 只跑前台命令（≤120s）；`background_tasks_start` 启动并立即返回 id；`wait_for` 只观察条件。
- `overlappable: true`（`wait_for` / `pty_wait`）或 `canOverlap(input)`（`agent` 仅 await/join）表示可与同消息其余调用重叠；加入前确认无写副作用。
- PTY 由懒启动的 Node helper（`mica-pty/src/server.mjs`）承载；改 `server.mjs` 后跑 `bun run scripts/generate-pty-server-source.mjs` 同步 `ptyServerSource.ts`。
- Todo（`plugins/todo/`）是「本轮计划」，不写 session。宿主只渲染、不改写模型给的状态：turn 结束既不把 `pending` 升成 `completed`，也不把 `in_progress` 退回写进数据，只在展示投影里把不再活跃的 `in_progress` 显示为 `pending`（`resolveTodoDisplayItems`）。清单全部完成时保留一行汇总而不是消失。解析归一化、投影、显示规则唯一实现在 `mica-common/todoState.ts`，TUI 面板与 desktop 计划 dock 共用；desktop 从对话里的 `todo_write` 工具行投影。执行期只做归一化（未知字段忽略、多个 `in_progress` 降级、超长截断），不拒绝整次调用。
- `session_notes` 工具只改内存（`snapshot.notes`），落盘交给本轮 checkpoint。

### MCP 与 Skills

- `mica-mcp` 管理 `config.json.mcpServers` 生命周期；读取时展开 `url` / `headers` 里的 `${VAR}` 与 `${VAR:-默认值}`，`command` / `args` / `env` 不展开。
- MCP 工具名由 `mcpToolNamePrefix()` 生成；按 server 关闭时用前缀匹配，断开/重连失败同步清理并刷新 registry。
- headless 显式初始化/关闭 MCP，支持独立配置与超时参数。
- skills 只扫描解析缓存、不执行；扫描 `$MICA_HOME/skills` 与项目 `.mica/skills`、`.agents/skills`、`.deveco/skills`、`.agent_context/skills`；未设 MICA_HOME 时额外共享 `~/.agents/skills`、`~/.config/deveco/skills`。插件注册的内置 skill 与磁盘 skill 合流在同一份 `getLoaded()` 里（`registerRuntime` / `clearRuntime`），磁盘同名优先；`parseMarkdown` 是内嵌 SKILL.md 取元数据的唯一入口。
- skill 是含 `SKILL.md` 的目录；内容不能覆盖安全规则、系统指令和当前用户请求。
- 联网：`web_search` 由 `plugins/web-search` 提供（设置 `searxngUrl` → `SEARXNG_URL` → `http://127.0.0.1:8080`，实例须开 JSON，结果缓存 5 分钟）；`web_fetch` 是内置工具。
- 最新、官方、API、价格、法规这类可变事实先联网查证；无法查证时明确说明。

## 8. 多 Agent、压缩与循环

### Subagent

- 委派能力本身是插件 `plugins/subagent/`：`agent` 工具、7 种内置类型、委派 prompt 段落都在插件里；内核只留机制（`ctx.subagents`，实现在 `apps/cli/src/agents/PluginSubagentHost.ts` + `SubagentTaskManager.ts`）。停用该插件后既没有 `agent` 工具，也没有提示词里的委派指引。
- 内置类型：general-purpose、Explore、Implementer、Reviewer、Tester、Planner、Proposal；`maxTurns` 唯一默认值在 `plugins/subagent/definitions.ts`（100）。
- `SubagentTaskManager` 按 owner 隔离任务与 abort signal，任务记录带 `pluginId` 供 `ctx.subagents.tasks.*` 收窄；后台完成元数据回注 owner，结果显式 read/await。parent Ctrl+C 同步中止其运行中的子代理。
- 前台委派默认阻塞，同消息多个调用可并行；需要主流程继续时用 `run_in_background: true`；每 owner 合计并发上限 4。
- `context_mode` 为 none/brief/recent/files，默认 brief；Implementer / Tester / Proposal 必填 `owned_paths`，写工具与 shell cwd 校验租约（判定唯一实现在 `mica-tools/utils/pathOwnership.ts`）。
- 委派倾向由插件设置 `delegationMode` 决定（`proactive` 默认 / `on-request`），prompt 段落每轮按设置重新渲染。
- 非主请求都要记账：Agent 走 `recordSubagentUsage`；commit、BTW、摘要等走 `recordSubagentTaskUsage` / `recordHelperSubagentUsage`。

### 压缩

| 入口                                                         | 行为                                       |
| ------------------------------------------------------------ | ------------------------------------------ |
| `/compact`、桌面快速压缩、`mica compact --tool-results-only` | 本地清理，不调用模型，不丢轮次，可重复执行 |
| `/compact llm`、`mica compact --session`                     | 模型摘要 checkpoint，会重写历史            |
| `--prune-only`、loop 轮前压缩                                | 本地清理，无可清理内容时可丢最早轮次       |

- 本地清理替换工具结果、可识别媒体与工具参数正文；tool-call arguments 必须仍是合法 JSON，只裁正文/长命令，保留路径、pattern、name、offset。
- 裁剪规则集中在 `mica-context/CompactionService.ts`（正文/命令阈值 200/400），幂等标记 `[omitted `。
- 自动压缩是官方插件 `plugins/auto-compact/`：每次模型请求的迭代边界检查，先本地清理、仍超阈值再模型摘要；阈值 300k / 200k、各最多 999 次、间隔 30 分钟。设置在插件 `settings`，计数在会话 `pluginState['auto-compact']`。
- 自动压缩只在常驻会话生效：`mica exec` 是一次性运行（`agent.mode === 'one-shot'`），改变成本或输出的策略一律跳过。
- 压缩只改发给模型的历史，不改 `conversationMessages`；自动压缩失败只记 note，不中断 turn。
- 所有压缩保留 usage 记账；需要模型的 compact / review / commit 走 subagent 或 exclusive task，不污染运行中的主 turn。
- 会话笔记存在快照里，compact 改不到它，每轮由 `buildSystemPrompt()` 追加；rewind 随 checkpoint 回滚。

### 定时循环

- CLI / desktop 共用 `mica-common/loopArgs.ts`：省略间隔默认 30 分钟，最短 10 秒，最长一周。
- CLI `LoopController` 只活在 TUI 进程；每轮前 prune-only，失败提示但不中断；停止时移除 system prompt 指引。
- desktop 调度在 `host/loop-state.js` + `host/loops.js`（`userData/loops.json`），不在页面 setInterval；忙时 skip 不计次数，重启只追赶一轮。

### By The Way

- 共用纯逻辑 `mica-builtin-commands/commands/btwThread.ts`；headless 不导入 builtin commands 总出口，避免把 Ink/React 拖进进程。
- 子代理的 system prompt 是整体替换，必须显式带上：btw 规则、主会话角色名 + role prompt 全文、skills 索引、一次性主流程对话记录。工具集用 `btwToolFilter` 排除 `primaryAgentOnly`。
- desktop `BtwThreadController` 立即 ack，结果经 `mica/btw/updated` 流式推送，不堵塞 interrupt / steer / recall。
- 同线程单子代理串行，允许一条排队与撤回；不同线程可并行。线程落盘 `$MICA_HOME/btw/<sessionId>.json`，共享路径在 `mica-common/btwState.ts`。
- BTW 不进主对话上下文、不占主队列、不改 run 生命周期；用量单独记账。

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
- 页面根节点必须套 `renderer/src/ErrorBoundary.jsx`。
- 运行时启动即 `stripContainerEnv()`；受控浏览器与终端 socket 只在 `will-quit` 关闭。
- 同一时刻只起一个 Electron 实例；验证时串行。

### 共享状态与路由

- 运行时只有一份 workspace / drafts / layout / rightTerms / terminalOpenByChat / cwd / Git 偏好，落盘 `userData/ui-state.json`；语义在 `mica-web-shared/ui-state.ts`。
- 条目补丁用 `setUiStateEntries`，null 表示删除；回声在 store 的 `applyRemote` 认领一次，组件不得各自认领。
- 同一 session 在所有页面是同一 node、run、终端；`dedupeSessionNodes` 合并重复页签。
- 默认 `0.0.0.0:8787`，运行时无认证；README 保留风险说明。
- 端口常量唯一出口 `mica-web-shared/runtime-port.js`；页面路径约定唯一出口 `app-paths.ts`。
- 单端口路由：`/`、`/mica-web`、`/share`、`/files`、`/terminal-control`、`/mcp/browser`、`/mcp/terminal`、`/api/*`、`/remote/control/*`、`/remote/terminal/*`。
- 受控浏览器与终端服务走 `userData` 下的 Unix socket；`apps/config-web` 是独立宿主（默认 13987）。
- `shareView` 只影响呈现，不是权限边界；`access-core.js` 校验 Origin / Host 防跨站与 DNS rebinding。
- 分享地址用 `access:info.shareBaseUrl`，不以本机 `location.origin` 兜底；链接形如 `/share?session=<id>`。
- 切换服务器：页面 origin 即当前服务器；由 host 探活后开新窗口/标签页，不做代理或跨源 API 层。
- 运行时里的用户终端面板与主进程终端控制是两套，不复用会话。

### 对话与输入

- chat run 按 nodeId 存于 `host/chat.js`；请求级发送错误走 `chat:queue-error`，回滚乐观消息并恢复草稿。
- 队列唯一投影 `chat-queue.js.mergeQueuedItems`：host after_iteration 在前，本地 after_turn 在后。
- `mica/queue/hold` 冻结待撤回条目，结果由 `chat-recall.js.resolveQueueRecall` 判定为回输入框 / 已发送 / 保留。
- `run.events` / `run.prompt` 每轮重置；恢复先用 `historyBeforeRunReplay` 裁掉本轮已保存回答再重放。
- 每次模型请求后立即转发 usage；实时 usage 不改 turnState / updatedAt。
- 阶段文案与计时读 `statusLinePhase`；`mica/turn/retrying` 让状态行显示 `retrying n/5`。
- 文件补全 CLI / desktop 共用 `mica-file-mentions`；`@` 与 `/` skill 补全只在词首触发，选中只插文本（文件插 `@路径`，skill 插 `SKILL.md` 绝对路径）。
- `/` 浮层混排 skill 与 MCP server；插入 MCP 时只写 server 名与已知工具名。
- desktop composer 不分派斜杠命令；输入历史只由 Alt+↑/↓（CLI 另支持 Ctrl+P/N）翻。
- 粘贴共用 `composer-paste.js`：图片转 `[Image](路径)`，文件插绝对路径。
- 角色入口在输入条箭头，随下一次发送/编辑的 role 参数持久化。
- 输入条齿轮与时钟打开 `SessionSettingsDialog`：会话能力（Tools / Skills / MCP 三页签）/ 定时任务。自动压缩不在这里，它在配置页 Plugins。
- 顶栏「会话笔记」图标打开 `SessionNotesDialog`（Monaco，700ms 防抖，无保存按钮）。
- 双击用户消息就地编辑，仅空闲且非空时提交，经 `chat:edit-message` 截断重跑；失败保留编辑文本。

### 展示

- 主文本共用 `--chat-text-size`；用户块与回答使用不同底色。
- 自动链接唯一实现在 `mica-common/autolink.ts`；desktop 的 remark 插件在 `remarkGfm` / `remarkPathLinks` 之前，CLI 用 `splitTerminalLink`。
- 路径识别在 `chat-paths.js` / `PathToken`；图片单击预览，失败给 notice。
- 用户消息超过 10 行默认折叠，含 `[Image]` 的不折叠；折叠态悬停用 `chat-hover-tooltip.jsx`，不用原生 `title`。
- 回合日志工具行单行省略，点行开 `ToolDetailDialog`；思考整段折行。
- 详情弹窗统一 `chat-modal.jsx` 的 `ModalShell`；`--chat-*` 变量要能穿过 portal。
- 代码块统一 `CodeView` + `code-highlight.js`，只读着色，不引编辑器运行时。
- 「在编辑器中打开」把内容作为只读虚拟文档放进应用里唯一的 monaco 实例。
- 轻量浮层统一用 `Popover`；会话级设置是弹窗而不是浮层。
- 电脑隐藏发送/排队按钮，移动端保留；后台任务/子代理 dock 只列运行项。

### 文件、Git 与侧栏

- Files / TerminalHost 按需挂载后保留实例；ref 未就绪的打开请求暂存，挂载后补开。
- shell 由 `shell-path.js.resolveDefaultShell` 按平台与存在性解析。
- 文件树尺寸沿用 VS Code：活动栏 48px、树行 22px、缩进 8px。
- Git 分暂存/工作区两段，写操作仅 stage/unstage/discard，discard 点名文件并确认；所有 Git 命令带 `GIT_OPTIONAL_LOCKS=0`。
- Git 比较按仓库/基线/模式与 fingerprint 保存审阅状态；DiffEditor 统一只读，换文件先 `setModel(null)`。
- Git 轮询只在可见且聚焦时进行（Files 3s / 其他 10s），不重叠；会话视图只取仓库根与分支（`git:status` 一次 `rev-parse`），`git:summary` 的全树 status + numstat 与分支对比只在文件视图跑。
- Pinned / Projects / Recent 互斥，归属经 `stats:move-session`；拖放判定在 `session-dnd.js`。
- 会话行共用操作列/图标列/名称栅格；状态优先级沿用 `session-state.js`，error 红点由后续 completed 清除。
- 会话搜索共用 `mica-web-shared/session-search.ts`；正文搜索每会话最多 20k 字符，默认最近 3 日、最多 600 个候选，截断须告知。
- 上下文统计按整条消息 JSON 估算并排除媒体 payload；compact / rewind 后用 staleInput 说明。

### 受控浏览器与终端控制

- 主进程业务例外：`src/main/browser/`、`src/main/terminal/`、`src/main/system/`；端点目录各自唯一（`browser-docs.js` / `terminal-docs.js` / `system-docs.js`），路由、文档与 MCP 操作清单同源。系统检查只服务宿主自己（`MICA_SYSTEM_SOCKET` 由运行时经 `host/system-checks.js` 直连，不做 `/remote/*` 代理、不暴露 MCP），探测用 `systemPreferences`、跳转用 `shell.openExternal`（renderer 的 `window.open` 只放行 http(s)）；配置页插件详情的「运行条件」经 `readDesktopChecks` / `openDesktopSettings` 两个桌面专有动作读它。
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

- `host/log.js` 是运行时唯一日志写入器：JSONL 落 `os.tmpdir()/mica-logs/`，2s 批量 flush，留 1000 条环形缓冲。
- 通道耗时只在 `handleInvoke` 用 `logger('invoke').timed()` 量一次；超过 `SLOW_MS`（默认 300ms）记 warn。新增功能不要自己再包一层计时。
- `chat:compact` 额外记一条 `compact.finished`（请求模式、子进程回报的 strategy、前后 token 估算）——只按通道计时分不出本地清理与模型摘要。
- 只读会话顶层字段（cwd、标题等）用 `host/session-file-head.js` 读文件头，不要为单个字段整份 `JSON.parse`：最大的一份会话 52MB。
- 渲染层 `perf-probe.js` 只采样、`log-probe.js` 只记错误，两者交给同一写入器。
- 采样全量记录，不做「异常才写」；隐藏窗口的 `lag` 记 null。
- 面板轮询跟可见性走（Stats 30s + 可见且聚焦；会话列表 10s，回到窗口立即补一次）；配置页 Performance 的聚合在 host 侧做完。
- 会话列表整份返回，但内容没变时按字段指纹（`session-state.js` 的 `sameSessionSnapshot`）跳过 setState，空闲轮询不触发重渲染。

## 10. UI 规范

### Ink

- `mica-ui` 只管组件/store，runtime 经 `MicaUiRuntimeBridge` 映射。
- Ink stdin 到 `parse-keypress.ts` 前保留 Buffer；Alt 两种编码都要支持。
- 编辑撤销/重做历史保存在组件 ref；`displayContent` 只改展示。
- 工具行占一行（`wrap="truncate-end"`），思考整段折行。

### 配置页

- `mica-config-ui` 是唯一实现：config-web 用 HTTP 托管，desktop SettingsView 直接嵌组件，不起 iframe 或子进程。
- 新页面只用既有积木：`PageFrame`、`Button`、`Tag`、`Switch`、`CollapsiblePanel`、`SettingsGroup`、`SettingRow`、`SplitView`、`ControlEndpointList`；文案走 `labels.ts`。
- 三块骨架：`PageFrame`（窄页头 + 内容区）、`SettingsGroup` + `SettingRow`（一页一块面，行间分隔线）、`SplitView`（左列表 + 右详情）。
- 折叠按容器宽度（`@container page (max-width: 860px)`），不按视口。
- Config 页只按字段编辑 providers；`mcpServers`、`capabilityDefaults` 只读展示并跳到各自页面。
- 服务商在分组里是一行：折叠显示名称/协议/地址/模型数，展开接字段行；有错误强制展开并标「待修正」。
- Sessions 左栏的会话信息由 `src/server/sessionHead.ts` 只读文件头 8KB 解析，两个宿主共用。
- 配置页不提供 effort 开关：由模型规则按模型名决定。
- 表单转换唯一实现 `web/configDraft.ts`；写入保留未知键，已知键固定顺序，可选字段留空即删键。
- Capabilities 页改 `config.capabilityDefaults`，读写实现在 `src/server/capabilityDefaults.ts`。
- 插件设置在 Plugins 页按清单渲染：开关用共享 `Switch`，数字用 `config-stepper`（−/输入/+ 共用一条边框，单位定宽）。
- 所有页面不设保存按钮：`useAutoSave`（400ms 防抖、串行写盘、卸载补发）；校验不过不写盘。
- 新建/删除/放弃用 `DialogHost` 的 confirmDialog / promptDialog。
- 改配置页后跑 `bun run build:config-web` 并提交 `generatedStaticAssets.ts`。
- 样式限定 `.mica-config-ui`；桌面 app.css 与配置页共用 Darcula token；页面级 html/body 高度链归宿主。

### 界面审查清单（新增页面、面板、弹窗必查）

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
- 行内动作按钮用 `variant="ghost"`；列表行按钮写 `width: 100%`。
- 不要把字段逐个包成卡片；设置项用 `SettingsGroup` + `SettingRow`，列表/详情用 `SplitView`。

### 移动端

- <768px 单栏 + 会话抽屉，Files 树/编辑器切换；`?layout=mobile|desktop` 可预览。
- safe-area 处理；表单字号至少 16px（Monaco 除外）。
- 根高度取 visual viewport / innerHeight / clientHeight 中明显更小的信号，保持 `--vvh-top` 补偿。
- `TerminalKeyBar` 经 `term.input()`；xterm 使用 DOM 渲染器，字号/颜色走 options。
- xterm 软键盘补发仅覆盖空格与 A–Z，须 preventDefault；升级含上游 #5614 的版本后删除并复验。

## 11. 构建、验证与交付

### 构建

- `bun run build` 产出 `dist/mica`，默认安装到 `~/.local/lib/mica`；`~/.local/bin/mica` 是薄 launcher。
- `mica.build.env` 定义品牌键，同名环境变量优先；改键同步构建文件与本文。
- models.dev 种子用 `bun scripts/update-models-dev-seed.mjs` 刷新。
- 发布链路 `build-binaries.yml`：checks / desktop-checks 任一失败，build 与 publish 整段跳过。
- 打包按平台取 node-pty 原生产物（`scripts/stage-node-pty.mjs`）；`spawn-helper` 只属于 macOS。
- desktop 用 `scripts/run-parallel.mjs` 并行跑三份构建；Vite 8 需搭配 electron-vite 6。
- 只验证功能时用 `npm run build:unpack`。
- 品牌 SVG 唯一源 `apps/desktop/resources/icon.svg`，位图由 `npm run icons:generate` 生成。
- 官网架构图只改 `apps/website/architecture/*.architecture.json`，再由 Archify 生成。

### 验证

- 局部改动跑相关测试 + `bun run typecheck` + `git diff --check`；全量测试约 90s（unit ~25-30s + process ~55-60s），仅发布、跨慢套件或 CI 要求时跑。
- `bun run test` 走 `scripts/run-tests.mjs`：先 `scripts/prune-test-temp.mjs` 清掉 `os.tmpdir()` 下过期的 `mica*` 测试目录（保留 `mica-tasks` / `mica-logs`，`MICA_TEST_TEMP_MAX_AGE_HOURS` 默认 6h），再串行跑两个 project，unit 失败即跳过 process。`test/globalSetup.ts` 用 `MICA_TEST_ROOT` 作整轮唯一的临时根并在结束时删除；worker 是被直接杀掉的，`setupFiles` 里的 exit 钩子不会触发，清理只能放在 globalSetup。
- 测试分两个 project（`vitest.config.ts`）：`unit` 是进程内单测、按文件并行；`process` 是真实子进程 / PTY / TUI 的 E2E，文件串行、文件内用例并发。慢的根源是每个用例 spawn 一次真实 `mica`（冷启动 1–1.5s），所以新增 E2E 用例要用 `it.concurrent` 语义（每用例自带 mock provider 与 `MICA_HOME`），不要把 `process` 项目丢回并行池：它和 unit 的 worker 抢 CPU 时会打挂 `btw.pty`、turn lease 这类时序敏感用例。
- `testTimeout` 显式给定而不是沿用 Vitest 默认 5s：unit 里有真实 git 仓库与文件 I/O，process 的 PTY 用例内部就按 20s 等待。机器一忙（多个 worker + 开发者自己的进程）5s 会打挂与代码无关的用例。并发上限同理：`unit` 的 `maxWorkers` 固定 4、`process` 的 `maxConcurrency` 固定 3，再往上不更快，只是把时间换成偶发超时。
- 根测试用 Vitest / Node；`PtyDriver` 仅 Node/vitest 可用，Bun 用 manager + Node helper。
- `app-server.flows.test.ts` 用本地 mock provider，无需真实 key；resume 用隔离 `MICA_HOME`。
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
