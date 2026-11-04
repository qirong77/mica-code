# CLI 运行链路

## 启动

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

## Turn 与队列

- `LocalRuntimeController.submit()` 先 trim 并解析命令，再经 `input:received` guard hook 处理普通输入；未被处理的输入进入 turn。
- 每个写 session 的 turn 必须持有 turn lease，在 `refreshFromStore()` 之前获取；拿不到就拒绝。lease 必须在 `turn:after` 前释放，finally 保留幂等兜底。
- 保存顺序：`running` → 每次工具迭代 checkpoint → 成功 assistant + `completed`；失败/中止存 `error` / `aborted`。非 completed 会话在 `/resume` 标 `（uncompleted）`。
- turn 启动即保存本轮用户输入；headless 对**非 `system`** 的输入都写入（插件 `ctx.runtime.submit` 的一轮在客户端没有乐观气泡，不写就只剩回答），内容取 `displayText`，缺省用真正发给模型的输入。本轮跑完后原文进了 provider 历史，保存时用展示文本**就地替换**那一条（`mergeInFlightUserMessage`），不追加第二条；定位那条消息要按共享归一化（`comparableText`，纯媒体退回图片引用）比，不能按原文——compact 会把图片块换成 `[image omitted during compact]`，原文比对必然落空，那条副本就留在会话末尾（重开 APP 时表现为同一条用户消息渲染两遍）。
- `MessageQueueService` 的每个操作都带 owner；pending input 只放 `pendingInputs`，不提前追加对话或 provider history。
- TUI 与 desktop 的 Enter / Tab / Shift+Tab 统一 `after_iteration`；`after_turn` 仅供 `/loop` 等显式请求。
- 当前 turn 没有后续迭代时由 message-queue 的 `turn:after` 兜底；仅 `completed` 自动发送，失败/中止保留输入供撤回。
- 两端都支持 Shift+← 撤回；desktop 的 host 槽走 `mica/queue/recall`。

## 重试与中止

- turn 级重试最多 5 次、间隔 10s；仅在错误可重试且本轮没有非只读工具调用时自动重试，先恢复 pre-turn snapshot。
- provider 的 `withRetry` 只在尚无文本/工具输出时重发（thinking 不算输出），退避 2/4/8/16/30s。
- 流空闲超过 60s 视为超时（`core/streamIdleTimeout.ts`）：SDK 的超时只覆盖到响应头，网关握手成功却不再吐事件时由看门狗关流并抛 `TimeoutError`，交给上面的重试判定。
- 重试清空 responseBuffer，重放已消费的 `after_iteration` 输入，等待能被 abort 立即打断。
- `turn:retrying` 不得投影为 Codex `error`，否则 desktop 会提前结束 run。
- 重试与失败写成 notice 存进 `conversationMessages`（`runtime/turnNotices.ts`），不进 provider history。
- `AgentRuntime.abort()` 递增 runId 并中止 controller；补写只传 `uncommittedResponseText`。
- 流迭代结束后仍须 `throwIfQueryStopped`，防止 SDK 吞掉 AbortError 后提交空 assistant 消息。
- 换进程的软停走另一个错误（`AgentPausedError`）：`throwIfTurnPaused` 与 `throwIfQueryStopped` 相邻，只在迭代边界触发，理由见 `headless.md` 的「drain 与续跑」。

## Provider 与 Prompt

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

### 模型档位（effort）与上下文

- 档位名就是模型在 models.dev 声明的真实取值：`minimal`/`max`/`xhigh` 各是各的，不归一化、不落别名；只有开关的模型是 `none`/`on`，只声明 budget 或没有 reasoning 的模型没有档位。没有任何档位的模型不发推理参数，也不在 `/effort`、desktop 选择器里凑五档；models.dev 没收录的模型由 provider 的 `effortLevels` 声明档位。切换模型时 clamp 到该模型自己的档位并同步 context window。metadata 优先级：磁盘缓存（24h）→ 内置 models.dev 种子 → 在线刷新。
- 档位/上下文跟着「谁在服务这次请求」查：`getModelRule` / `ensureModelRule` 接受 provider 作用域（`{ id, api_base }`），缓存键带上 provider。同一个模型在网关（OpenRouter 的 `moonshotai/kimi-k3` 有 `none`）与厂商原生条目（没有 `none`）下的档位可以不同，只按模型名匹配会用错那一份。服务商在 models.dev 里收录了这个模型就以它为准（先认 `id`、再认 `api_base` 的主机名），否则仍按模型厂商的条目。
- 发给模型的是 `getModelRule(model, provider)` 的那份规则，界面显示的也必须是同一份：状态行按「模型声明的档位 + 模型默认档位」收敛（`resolveDisplayedEffort`），没有档位显示 `—`，不属于该模型的档位显示它自己的默认值——界面不能显示一个不会发出去的值。
- 档位解析分两条策略（`resolveRuntimeConfigOverride` 的 `effortPolicy`）：`mica exec --variant` 这类命令行显式参数走 `strict`，档位不合法就报错；客户端带上来的 model+effort（desktop 选择器、Codex 驱动的 thread/\* 字段）走 `clamp`，收敛到目标模型的档位或丢掉它没声明的档位，由 host 用 warning 说明实际发了什么。app-server 因此绝不能因为一个客户端档位起不来。
- 解析档位之前必须先 `ensureModelRule(model)`：档位集合来自 models.dev，磁盘缓存异步读，先算会把「只在缓存里、随包种子里没有」的模型判成没有档位。
- 档位的**字段名**跟着「谁在服务这次请求」走（`isGatewayEntry`）：厂商直连的条目（`deepseek-flash`）用 `thinking` / `reasoning_effort`，聚合网关的条目（`z-ai/glm-4.6` 这类带前缀的键）只能用 `reasoning.effort`——网关会静默忽略 `thinking`，推理照跑。两边一起发更糟，网关会先命中 `thinking` / `reasoning_effort` 而把 `none` 顶掉。
- models.dev 的档位是社区数据，未必等于某台网关的真实枚举（`openai/gpt-6.1-terra` 在一处声明 `none`，某台 codex 网关只认 low…max）。provider 用 400/422 明确拒绝本次带上的推理参数时，客户端丢掉推理参数重发一次，并经 `markEffortLevelRejected` 记住「这台服务商的这个模型不收这一档」，`resolveEffortParams` 之后直接不发——压缩摘要、起标题、子代理这些每次新建客户端、effort 又不是用户选的路径因此不会反复撞同一个 400。
- 只有 `get_model_url` 动态 provider 查询模型列表，结果不写回 config.json。
