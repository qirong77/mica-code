# By The Way

`/btw <问题>`：在主流程旁边开一条隔离子代理回答一句，不打断主流程，也不写回主对话上下文。

```
/btw 这里的乐观锁和互斥锁分别适用于什么情况？
/btw -continue 那并发写的时候呢？
```

- **不插队**：主流程正在跑也能问（`allowDuringTurn`），答案走 notice，不进主流程的队列；
- **不进上下文**：旁问线程有自己的一份消息数组，主对话的 provider history 一个字都不动；
- **可追问**：`-continue` 复用同一个子代理，所以它记得上一轮读过什么文件、查过什么；
- **有背景**：system prompt 里带上主流程的文字对话记录、当前角色与 skills 索引（与主流程同一份
  提示词构造器），模型知道自己在给谁做旁注；
- **只读边界**：主会话专属工具（`session_*`、loop 等 `primaryAgentOnly`）不进旁问线程，其余工具
  （读文件 / 搜索 / 联网 / 执行命令）照常可用——回答本来就要靠它们。

用量按每一次提问记进当前会话的 `subagentUsageHistory`（`origin: 'plugin'`，`subagentType: btw`），
在 Stats 的「By plugin」里能看到；`-continue` 只记新增的请求，不会把前面几轮重复计费。

桌面端的 By The Way 抽屉是同一个能力的另一副界面（走 `mica/btw/*` 协议，由 app-server 托管），
两边共用 `mica-builtin-commands/shared/btwThread.ts` 的提示词与背景记录取法。

## 能力面

| 能力            | 用途                                                              |
| --------------- | ----------------------------------------------------------------- |
| `ctx.commands`  | 注册 `/btw`（`allowDuringTurn: true`）                            |
| `ctx.session`   | 读主流程的对话记录、会话 id（线程按会话保存）与当前角色名          |
| `ctx.subagents` | `thread()` 开一条可复用的隔离子代理；用量记账在宿主                |
| `ctx.ui`        | `notice()`：运行中固定在输入框上方，完成后落进对话并随会话保存      |

## 文件

| 文件         | 职责                                                     |
| ------------ | -------------------------------------------------------- |
| `index.ts`   | 注册命令、按会话持有旁问线程、把结果写成 notice          |
| `message.ts` | `/btw` 的参数解析与结果排版                              |
| `btw.test.ts` | 命令行为：进度 → 答案、`-continue` 复用线程、失败可见   |
