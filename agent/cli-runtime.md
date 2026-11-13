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
- 所有协议共享 pi-ai 消息历史；跨协议切换保留历史，由 pi 按目标模型转换工具 ID、图片与思考签名。旧原生 OpenAI 历史只经 `evolution` 一次性迁移，运行时不保留旧格式分支。
- `/resume` 与 `--resume` 切到会话自己的 `cwd`（目录缺失时保留当前目录并提示）；app-server 的 resume 以客户端传入的 cwd 为准。

## Turn 与队列

- `LocalRuntimeController.submit()` 先 trim 并解析命令，再经 `input:received` guard hook 处理普通输入；未被处理的输入进入 turn。
- 每个写 session 的 turn 必须通过 `SessionController.acquireTurnLease()` 取得并登记 turn lease，在 `refreshFromStore()` 之前获取；拿不到就拒绝。lease 必须在 `turn:after` 前释放，finally 保留幂等兜底。空闲辅助用量写回的租约与增量规则见 `storage.md`。
- 保存顺序：`running` → 每次工具迭代 checkpoint → 成功 assistant + `completed`；失败/中止存 `error` / `aborted`。非 completed 会话在 `/resume` 标 `（uncompleted）`。
- turn 启动即保存本轮用户输入；headless 对**非 `system`** 的输入都写入（插件 `ctx.runtime.submit` 的一轮在客户端没有乐观气泡，不写就只剩回答），内容取 `displayText`，缺省用真正发给模型的输入。本轮跑完后原文进了 provider 历史，保存时用展示文本**就地替换**那一条（`mergeInFlightUserMessage`），不追加第二条；定位那条消息要按共享归一化（`comparableText`，纯媒体退回图片引用）比，不能按原文——compact 会把图片块换成 `[image omitted during compact]`，原文比对必然落空，那条副本就留在会话末尾（重开 APP 时表现为同一条用户消息渲染两遍）。
- `MessageQueueService` 的每个操作都带 owner；pending input 只放 `pendingInputs`，不提前追加对话或 provider history。
- TUI 与 desktop 的 Enter / Tab / Shift+Tab 统一 `after_iteration`；`after_turn` 仅供 `/loop` 等显式请求。
- `after_iteration` 在排队后的第一个完整工具迭代边界消费，不额外等待一轮；provider 先追加本批全部工具结果，再把输入作为 user 消息追加到末尾，保持已有 prompt cache 前缀。冻结撤回期间不消费，释放后等下一个边界；system 输入仍优先。
- 当前 turn 没有后续迭代时由 message-queue 的 `turn:after` 兜底；仅 `completed` 自动发送，失败/中止保留输入供撤回。
- 两端都支持 Shift+← 撤回；desktop 的 host 槽走 `mica/queue/recall`。

## 重试与中止

- turn 级重试最多 5 次、间隔 10s；仅在错误可重试且本轮没有非只读工具调用时自动重试，先恢复 pre-turn snapshot。
- 回滚快照只复制 provider 状态，不构建展示消息；每次恢复复制基线，避免失败尝试污染下一次回滚。禁用 turn 重试时不建立副本，发生非只读工具调用后尽早释放副本。持久化快照使用 `getSnapshot({ includeConversation: false })`，展示消息由运行时自己的展示记录提供。
- provider 的 `withRetry` 只在无不可回滚输出时重发；展示端提供文本和思考回滚能力时按尝试恢复。没有回滚能力的消费者收到正文、思考或工具输入后不重发，退避 2/4/8/16/30s。pi SDK 自动重试关闭，避免双层重试和不可见尝试。
- 4xx 一律不重试，唯一例外是网关报告请求体解析失败的 400（`invalid json: invalid character ...`、`invalid_json` 错误码或 codexgo 的「请求体必须是有效 JSON，最大 8MB」）：本地序列化的请求也可能被网关偶发拒绝，按既有次数上限重试；该错误本身不能证明传输抖动，也不能排除网关的大小限制，持续失败仍报错。识别结构化顶层 / `error.code` 和仅保留文案的错误；413 等明确的大小错误不重试。判定在 `core/retry.ts` 的 `isUpstreamBodyParseFailure`。
- 流空闲超过 60s 视为超时（`core/streamIdleTimeout.ts`）：SDK 的超时只覆盖到响应头，网关握手成功却不再吐事件时由看门狗关流并抛 `TimeoutError`，交给上面的重试判定。
- codexgo 区分读取失败后的 `400 request_incomplete` / `request_read_error` 与 `408 request_timeout` 也按既有上限重试；兼容结构化错误码和 SDK 仅保留正文的错误。413 超限与 AbortError 保持不重试。
- 重试清空 responseBuffer，按顺序重放已消费的 `after_iteration` 输入；再次失败时保留尚未重放的尾部，不能只恢复本次已消费项。等待能被 abort 立即打断。
- `turn:retrying` 不得投影为 Codex `error`，否则 desktop 会提前结束 run。
- 重试与失败写成 notice 存进 `conversationMessages`（`runtime/turnNotices.ts`），不进 provider history。
- `AgentRuntime.abort()` 递增 runId 并中止 controller；补写只传 `uncommittedResponseText`。
- `mica compact` 把进程 SIGINT / SIGTERM / SIGHUP 转成同一 `AbortSignal`，传入压缩服务与摘要子代理的 `query`；摘要中止或失败仍记实际任务状态与已产生用量，只有压缩成功且未中止才应用快照并保存会话。
- 流迭代结束后仍须 `throwIfQueryStopped`，防止 SDK 吞掉 AbortError 后提交空 assistant 消息。

## Provider 与 Prompt

- `createModelClient` 为内置四协议创建 `PiModelClient`：`openai_chat_completions` / `openai_responses` / `anthropic_messages` / `google_generative_ai`。配置协议仍显式声明，不按 `api_base` 猜。
- `piTransport` 调用 pi-ai 的 API 实现，pi 负责 wire 编码、SSE、工具参数增量 JSON、签名重放、多模态结果转换与缺失工具结果修复。`PiModelClient` 只保留共享业务循环、权限/调度、重试回滚、图片字节预算和用量归属；`PiHistoryNormalizer` 提供唯一展示投影。runtime 不拼厂商请求。
- `executeProviderToolCalls` 把连续只读工具与 `Agent` 调用并发，写/执行工具作为串行屏障；结果按调用顺序回填，每组前后检查 abort。
- `readOnly: true` 同时允许并发与安全重试，工具必须无共享可变状态。
- 多模态工具结果统一存为 pi `toolResult` 的 text/image 块，目标协议转换由 pi 负责。UI、日志只取文本投影。
- 两种运行模式的 `[Image](路径)` 都先经 `parseImageRefs` 转成多模态块；headless 直接导入 `mica-ui/utils/imagePaste.js`，避免引入 React/Ink。
- 运行中改写只能经 `rewriteIterationMessages` 改共享循环的本地数组；钩子输入是 pi 消息，不含 system prompt。每次发送由 pi 组装 system 与工具声明。
- 无视觉模型由 pi 的发送转换降级图片；持久化历史保留原图。
- 图片有三道闸：**准备阶段** `prepareImageForApi`（`mica-common/image.ts`）把 PNG 的长边压到 1568 并无损重编码（够小的图原样透传，其它格式不重编码），处理完长边仍超 `IMAGE_MAX_API_LONG_EDGE`（8192）就直接抛错——DeepSeek `/responses` 实测 8192 能过、8193 起 400，报错文案却说「不支持的图片格式」，这种 400 不可重试、整个 turn 会失败，所以要在本机拦住并让模型缩小 / 裁剪 / 分段重读；**发送阶段** `applyImageBudget`（`mica-agent/providers/imageBudget.ts`）按字节而不是 token 算账——一次请求的正文（文本 + 内联图片载荷）上限 20MB、单张 6MB，超了就把最旧的图换成 `[图片已省略]…` 占位文本，最新的图优先保留。三道都要有：token 口径看不出 53MB 的请求体，实测 DeepSeek 网关 32MB 能过、48MB 回 413（openresty 的 HTML 错误页），而压缩只覆盖能解码的 PNG。
- Responses 带 reasoning 参数时请求 summary 与 encrypted content；签名、原生 item ID 和工具关联保存在 pi assistant 消息中，同模型重放由 pi 处理。思考显示按内容块 checkpoint，和协议重放数据独立。
- `buildSystemPrompt()` 始终以 `mica-agent/prompt/system.md` 构建固定的 `<system>` 默认正文，不接受 `baseSystemPrompt` 覆盖；内置 `default` 只读，Role 页面展示其正文。磁盘与插件的非默认 role 统一通过 `rolePrompt` 追加为紧接 `<system>` 的 `<role>` 段，两段同属 system prompt，默认角色不重复追加；cwd 的 `AGENT.md` / `AGENTS.md` 合并注入，路径按 live cwd 解析。会话角色名是**配置**：`loadSnapshot` 与 `resolveCurrentRole` 解析不到它时只保留默认正文、不追加 Role，但绝不把名字改写成 `default`（插件 role 由插件 setup 之后才发布，那一刻查不到很正常；改写会让下一次保存真的把角色丢掉）。`agent.role` 因此报配置里的名字。
- base prompt 只放通用协作底座：通用助手身份、指令与事实边界、工具与权限、任务推进与成果保护、验证与沟通；专业职责与工作风格由 Role 补充，不替换通用约束。计划、委派、笔记、记忆这类策略由对应插件注册 `ctx.prompt.section()` 注入，随插件停用一起消失——不要为了「提示词完整」把工具用法抄回 base。
- 工具用法（参数、超时、并发、等待语义）只写在工具 schema 描述里，base prompt 不重复：两处都写必然漂移，且每次改工具都在改 prompt cache 前缀。
- skills 只以索引进入 system prompt。
- 每次提示词注入都有 XML 边界：项目文件各用 `<document source="…">`，插件只通过 `ctx.prompt.section()` 注入，由宿主生成 `<injection source="plugin" plugin="…" section="…">`；`system-prompt:build` 不再支持。正文允许语义 XML，动态数据必须转义；外层标签由宿主保留。子代理规则、角色与插件独立模型请求也分别包装，来源属性保持稳定，不含轮次随机值。
- 段落会**每轮重渲染**，所以「随环境变化」的事实要自己控制代价与位置：没有内容就返回空串（`session-autonomy` 的 `concurrency` 段落在没有同 cwd 并发会话时是空的，平时不占 token），变化内容放 order 大的那一端，别把随进程/会话起落的内容塞进前缀，否则前面稳定的段落跟着一起让 prompt cache 失效。**并发这类事实必须由宿主主动注入，不能只留一个工具等着模型「怀疑了才查」**：真实事故里主会话全程确信那些改动是自己的子代理写的，一次都没调用过 `session_peers`。
- `AgentRuntime.setCapabilities()` 保存会话开关；prompt、工具定义与执行校验读同一份状态。未定制的会话跟随 `config.capabilityDefaults`，`resetCapabilitiesToDefaults()` 回到跟随默认。
- `AgentRuntime.inspectPrompt()` 通过单次来源渲染返回分段、完整预览与 `lastSent`，不修改真实发送存档。全局提示词控制由 `mica-config/promptControls.ts` 读取，每轮开始捕获并固定到该轮结束；空闲预览立即反映磁盘控制，工具迭代与请求重试不受轮中修改影响。无覆盖时提示词顺序和文本保持原样。

### 模型档位（effort）与上下文

- 档位名就是模型在 models.dev 声明的真实取值：`minimal`/`max`/`xhigh` 各是各的，不归一化、不落别名；只有开关的模型是 `none`/`on`，只声明 budget 或没有 reasoning 的模型没有档位。没有任何档位的模型不发推理参数，也不在 `/effort`、desktop 选择器里凑五档；models.dev 没收录的模型由 provider 的 `effortLevels` 声明档位。切换模型时 clamp 到该模型自己的档位并同步 context window。metadata 优先级：磁盘缓存（24h）→ 内置 models.dev 种子 → 在线刷新。
- 档位/上下文跟着「谁在服务这次请求」查：`getModelRule` / `ensureModelRule` 接受 provider 作用域（`{ id, api_base }`），缓存键带上 provider。同一个模型在网关（OpenRouter 的 `moonshotai/kimi-k3` 有 `none`）与厂商原生条目（没有 `none`）下的档位可以不同，只按模型名匹配会用错那一份。服务商在 models.dev 里收录了这个模型就以它为准（先认 `id`、再认 `api_base` 的主机名），否则仍按模型厂商的条目。
- 发给模型的是 `getModelRule(model, provider)` 的那份规则，界面显示的也必须是同一份：状态行按「模型声明的档位 + 模型默认档位」收敛（`resolveDisplayedEffort`），没有档位显示 `—`，不属于该模型的档位显示它自己的默认值——界面不能显示一个不会发出去的值。
- 档位解析分两条策略（`resolveRuntimeConfigOverride` 的 `effortPolicy`）：`mica exec --variant` 这类命令行显式参数走 `strict`，档位不合法就报错；客户端带上来的 model+effort（desktop 选择器、Codex 驱动的 thread/\* 字段）走 `clamp`，收敛到目标模型的档位或丢掉它没声明的档位，由 host 用 warning 说明实际发了什么。app-server 因此绝不能因为一个客户端档位起不来。
- 解析档位之前必须先 `ensureModelRule(model)`：档位集合来自 models.dev，磁盘缓存异步读，先算会把「只在缓存里、随包种子里没有」的模型判成没有档位。
- 档位的**字段名**跟着「谁在服务这次请求」走（`isGatewayEntry`）：厂商直连的条目（`deepseek-flash`）用 `thinking` / `reasoning_effort`，聚合网关的条目（`z-ai/glm-4.6` 这类带前缀的键）只能用 `reasoning.effort`——网关会静默忽略 `thinking`，推理照跑。两边一起发更糟，网关会先命中 `thinking` / `reasoning_effort` 而把 `none` 顶掉。
- models.dev 的档位是社区数据，未必等于某台网关的真实枚举（`openai/gpt-6.1-terra` 在一处声明 `none`，某台 codex 网关只认 low…max）。provider 用 400/422 明确拒绝本次带上的推理参数时，客户端丢掉推理参数重发一次，并经 `markEffortLevelRejected` 记住「这台服务商的这个模型不收这一档」，`resolveEffortParams` 之后直接不发——压缩摘要、起标题、子代理这些每次新建客户端、effort 又不是用户选的路径因此不会反复撞同一个 400。
- 模型列表全部来自 `config.json` 里手填的 `providers[].models`：没有任何探测 / 拉取路径，配置页也不再提供「模型列表地址」。
