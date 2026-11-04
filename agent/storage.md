# 配置、会话与存储

- `MICA_HOME` 覆盖全部用户路径，默认 `~/.mica`；品牌目录经 `brand.ts` 解析。
- `PersistedMicaConfig` 只存静态字段；运行时用 `stripRuntimeFields` 去除 provider/model/effort/contextWindowSize。新会话默认值唯一来自 `config.json.defaultModel: { provider, model, effort? }`；未配置取 `providers[0].models[0]`（动态列表取返回首项），未填 effort 用模型默认档位。`micaConfig.resetSessionModelDefaults()` 重读默认值并保留已加载的动态模型列表，TUI `/new`、`/clear` 同样调用；恢复会话与显式选择保留自己的值。`storage.json` 不再读写目录模型偏好。
- 旧版本写在 `config.json` 的 `searxngUrl` 在启动时迁进 `plugin-settings/web-search.json`（已有值不覆盖）并删掉原键；搜索改成插件后只有插件设置生效。
- 配置迁移与语义校验统一在 `startup/validate-config.js`，配置页保存复用它。
- 仅当所有 provider 都没有 api_key 时，`envProvider.ts` 从 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 合成运行时 provider；环境 provider 永不写回 config.json。
- session 是 version 1 JSON；新增字段要有版本策略、默认值与 sanitize，字段类型不对按损坏拒绝。
- `parentSessionId` 是顶层元信息（与 `cwd` 同级），记录「谁派生的这条会话」：`--parent`、`thread/start`、fork（父会话换成源会话）。非法值（非字符串、id 形状不对、自指）丢弃而不是拒绝整个会话——它只影响侧栏嵌套。`$MICA_HOME/session-index.json` 的版本号跟着升，旧索引直接重建。
- `resumeAfter` 是顶层可选字段，只在「宿主为一个即将换掉的进程主动软停」时写（当前唯一取值 `build-reload`），一轮正常完成即清；它同时要求 `turnState === 'aborted'`，否则读盘时丢弃。用户自己按停止的会话没有它，不会被续跑。
- 会话级状态都在快照里：`capabilitySelection` / `capabilitiesCustomized`、`pluginState`（插件自己的 JSON）、`pluginSessionSettings`（插件设置的会话覆盖，只存改过的键）、`notes`。`startNewSession` 清空，resume/fork 沿用，rewind 随 checkpoint 回滚。`turnTimings`（最近 50 轮的耗时分解）是例外：它记录这条会话跑过的轮次，`startNewSession` 与 fork 都清空，读盘时坏掉的条目丢掉而不是判整份会话损坏。
- `snapshot.systemPrompt` 是「最近一次请求真正发出去的 system prompt」的存档（角色 + 项目说明 + skills 索引 + 环境信息 + 插件段落），只给界面看，绝不用于重建请求——下一轮仍然现场拼装。写在 `AgentRuntime` 解析 `systemPrompt` 的那一刻，随 checkpoint 落盘；旧会话没有这个字段，界面如实说「没有记录」而不重新拼一份冒充。
- `subagentUsageHistory` 独立于主 `usageHistory`；fork 清空两类历史，只保留描述继承上下文的 `lastUsage`。
- `usageHistory[*].rawUsage` 只存**标量 + 一层明细**（`mica-common/rawUsage.ts` 的 `compactRawUsage`，被裁过就带 `truncated: true`）：聚合网关会在 `usage.attribution.items` 里逐条回传 token 归因，没有消费方，却能让单条记录到 247KB、一份 1.5MB 的会话涨到 30MB。读回旧会话时按同一份规则压一次（幂等，与内存态同形），下一次落盘文件也就跟着变小。
- compact 保留 `lastUsage` / `usageHistory` 供 Stats 对账；界面 ctx 优先读 `displayUsage`。
- 无手动标题时取最后一条真实用户消息（最长 60 字符）；自动改名不得覆盖 `titleSource === 'manual'`。
- `$MICA_HOME/session-index.json` 是可重建缓存，不进 `sessions/`；索引 v3 记录读不出摘要的 `rejects`（id + size/mtime），避免每次全量重扫，并带上侧栏嵌套要用的 `parentSessionId`（v2 没有它，版本对不上就整份重建）。
- `sessions/.turn-locks/<id>.lock` 是跨进程写入的唯一事实来源（`wx` + owner pid 存活判定）；孤儿锁在 acquire 时回收。
- 垃圾占位须同时满足：默认占位标题、无对话、无 usage；`turnState === 'running'` 永不隐藏或删除。
- 只读会话顶层字段（cwd、标题、`resumeAfter` 等）用 `host/session-file-head.js` 读文件头，不要为单个字段整份 `JSON.parse`：最大的一份会话 52MB。
