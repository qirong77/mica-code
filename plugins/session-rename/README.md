# 会话自动重命名（session-rename）

每轮问答正常结束后，把用户与助手的对话文本（不含工具调用与工具结果）交给一个独立配置的模型，由它生成一个更贴合内容的中文会话标题。

- 官方插件，随 CLI / 桌面端一起编译，无需安装。
- 在配置页 **Plugins → 会话自动重命名** 里填写接口地址、Key、协议、模型与提示词；改完即时生效，不必重开会话。
- 用户手动改过名的会话（`titleSource === 'manual'`）不会被覆盖。

## 设置项

| 键                   | 类型   | 说明                                                            |
| -------------------- | ------ | --------------------------------------------------------------- |
| `baseUrl`            | 文本   | OpenAI 兼容接口地址，含 `/v1`，例如 `https://api.openai.com/v1` |
| `apiKey`             | 密码   | 该接口的 Key                                                    |
| `protocol`           | 枚举   | `openai_chat_completions`（默认）或 `openai_responses`          |
| `model`              | 文本   | 用于起标题的模型，建议选便宜的小模型                            |
| `prompt`             | 长文本 | 生成标题的提示词，留空则用插件内置默认值                        |
| `maxMessages`        | 数字   | 最多带多少条对话（从最近往前取），默认 `12`                     |
| `minIntervalSeconds` | 数字   | 同一会话两次自动命名的间隔上限保护，默认 `0`（每轮都判一次）    |

设置落在 `$MICA_HOME/plugin-settings/session-rename.json`，插件每轮读取时会按文件 mtime 判断是否变化，所以改完不需要重启。

## 行为细节

- 只在 `turn:after` 且 `outcome === 'completed'` 时触发；中止或失败的轮次不参与，避免把半截回答固化进标题。
- 对话按 UI 视角取 `conversationMessages`，过滤掉 notice、工具消息、compact 边界与插件注入的展示文本；媒体占位符会被剥掉。
- 一条消息压成单行并截断，整体再限制总字符预算，避免把超长会话整段发给模型。
- 生成的标题会去掉引号、反引号、Markdown 强调与「标题：」之类前缀，取第一行，最多 60 字。
- 标题与原值相同时不写盘，不触发改名。
- 任何失败（没配好、网络错误、超时、返回空）都只写日志，绝不打断本轮对话。

## 命令

TUI 里可用 `/session-rename now` 立刻手动触发一次（例如验证 Key 是否可用），`/session-rename status` 看当前配置状态。桌面端不派发斜杠命令，设置页就是它的入口。

## 日志

插件日志写在系统临时目录，避免长期堆积：

```
os.tmpdir()/mica-logs/plugin-session-rename-<YYYYMMDD>[-n].jsonl
```

每个文件超过 2 MB 自动换下一个分片，超过 3 天的文件在写入时被清理。`MICA_PLUGIN_LOG=0` 可整体关闭。同一会话的失败原因都会带上 `reason` 字段（`not-configured`、`manual-title`、`timeout`、`request-failed` 等），排查时先看这里；配置页的插件详情里也直接给出当前日志路径。

## 文件

```
plugin.json      清单：id / 版本 / 入口 / 面向设置页的配置项
index.ts         装配：turn:after 钩子、命令、节流与并发保护
transcript.ts    对话抽取：过滤、压缩、拼成纯文本
titleRequest.ts  调用模型并清洗标题
```
