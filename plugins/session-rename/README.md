# 会话自动重命名（session-rename）

每轮问答**开始之前**，把最近的对话上下文（不含工具调用与工具结果）和本轮用户请求交给一个独立配置的模型，由它生成一个更贴合当前任务的中文会话标题。

- 官方插件，随 CLI / 桌面端一起编译，无需安装。
- 在配置页 **Plugins → 会话自动重命名** 的「起标题模型」面板里填写接口地址、Key、协议与模型（填完可点「测试连接」验证），提示词在下方设置组；改完即时生效，不必重开会话。
- 用户手动改过名的会话（`titleSource === 'manual'`）不会被覆盖。

## 设置项

带 `*` 的四项由清单的 `llm` 声明生成（「起标题模型」面板），见 `plugins/README.md` 的「模型接口」一节；面板里可以点「测试连接」先确认配置能通。

| 键                   | 类型   | 说明                                                            |
| -------------------- | ------ | --------------------------------------------------------------- |
| `baseUrl` *          | 文本   | OpenAI 兼容接口地址，含 `/v1`，例如 `https://api.openai.com/v1` |
| `apiKey` *           | 密码   | 该接口的 Key，可写 `${MY_KEY}` 从环境变量读                     |
| `protocol` *         | 枚举   | `openai_chat_completions`（默认）或 `openai_responses`          |
| `model` *            | 文本   | 用于起标题的模型，建议选便宜的小模型                            |
| `prompt`             | 长文本 | 生成标题的提示词，留空则用插件内置默认值                        |
| `maxMessages`        | 数字   | 最多带多少条对话作为上下文（从最近往前取），默认 `12`           |
| `minIntervalSeconds` | 数字   | 同一会话两次自动命名的间隔上限保护，默认 `0`（每轮都判一次）    |

设置落在 `$MICA_HOME/plugin-settings/session-rename.json`，插件每轮读取时会按文件 mtime 判断是否变化，所以改完不需要重启。

## 行为细节

- 只在 `turn:before` 触发：标题在用户盯着这一轮跑的时候就已经对了，不必等到结束后再改成上一件事的标题。`source === 'system'` 的内部注入（compact 边界、插件通知）不参与。
- 本轮的用户输入在 `turn:before` 时还没进 agent history（TUI 只进了 `uiState`，headless 只是 pending 消息），所以由 hook 事件补进对话；已经补过的按截断规则比对，不会算成两条。
- prompt 分成「对话记录（理解上下文）」和「用户最新请求（标题概括这一段）」两段：旧任务往往比新请求长得多，混成一段模型就会被前几轮带跑。
- 对话按 UI 视角取 `conversationMessages`，过滤掉 notice、工具消息、compact 边界与插件注入的展示文本；媒体占位符会被剥掉。
- 一条消息压成单行并截断，整体再限制总字符预算，避免把超长会话整段发给模型。
- 同一条用户请求只起一次标题：`mica exec` 在一轮结束后会再补发一次 `turn:before`，重复请求改不动标题，只白花一次调用。
- 生成的标题会去掉引号、反引号、Markdown 强调与「标题：」之类前缀，取第一行，最多 60 字。
- 标题与原值相同时不写盘，不触发改名。
- 发起后不等结果：`turn:before` 是宿主 `await` 的，等一次外部请求就是每轮都卡上一两秒。
- 任何失败（没配好、网络错误、超时、返回空）都只写日志与健康状态，绝不打断本轮对话。

## 命令

TUI 里可用 `/session-rename now` 立刻手动触发一次（例如验证 Key 是否可用），`/session-rename status` 看当前配置状态。桌面端不派发斜杠命令，设置页就是它的入口。

## 日志

插件日志和运行时日志同一个目录（`resolveLogDir()`，macOS 是 `~/Library/Logs/mica`），重启不丢：

```
~/Library/Logs/mica/plugin-session-rename-<YYYYMMDD>[-n].jsonl
```

每个文件超过 2 MB 自动换下一个分片，超过 7 天的文件在写入时被清理。`MICA_PLUGIN_LOG=0` 可整体关闭。同一会话的失败原因都会带上 `reason` 字段（`not-configured`、`manual-title`、`timeout`、`request-failed` 等），排查时先看这里；配置页的插件详情里也直接给出当前日志路径。

## 文件

```
plugin.json      清单：id / 版本 / 入口 / 面向设置页的配置项
index.ts         装配：turn:before 钩子、命令、节流与并发保护
transcript.ts    对话抽取：过滤、压缩、拼成纯文本
titleRequest.ts  调用模型并清洗标题
```
