---
name: subagent
description: 派一个独立的 mica 会话（子会话）去干活，并观测它的进度 —— 开一个、投一句、看它说到哪、等它跑完、打断、收掉、接管已有会话。子会话有自己的上下文和进程，会挂在当前会话下面出现在会话列表里；跑完/卡住会自己报到。不限迭代、不限 token、不限并发、不限嵌套层数。
when_to_use: Use when a piece of work is self-contained enough to hand off and would otherwise flood this conversation — e.g. "开个子会话去把这批测试跑一遍", "派一个去查清楚这个报错的所有调用点", "让另一个会话独立改这个模块，改完汇报", "开个新会话盯着这条构建", "并行开两个会话分别验证两个方案". Also use when the user asks to spawn / watch / drive / resume a separate Mica session.
argument_hint: [要交给子会话做的事]
---

# subagent

一个 subagent 就是一个**独立的 mica 会话**：自己的上下文、自己的进程、自己的会话文件。
你和它之间是"派活 + 读结果"，不是共享上下文——它看不到你的对话，你也只看到它回传的正文。

四个动词，一个主语（那条会话的 id，可只记唯一前缀）：**drive（给活）/ inspect（看）/ wait（等）/ stop（停）**。

每次 `subagent_drive` 新建会话时，第一条用户消息会自动包装成一个 issue：

```text
<context>
父会话：xxx
父会话 ID：...
</context>
<task>
...
</task>
```

后续消息不会重复包装；接管已有会话时也不会（那是「接着说」，不是「新派一件活」）。
子会话可以继续派生下一级，所以 A → B → C 会分别记录 B.parent=A、C.parent=B。

**为什么是工具而不是开个终端手敲**：`mica app-server` 给的是结构化事件（正文 delta、
工具调用与结果、轮次终态、用量），一个 `subagent_inspect` 就拿到全部进度；而驱动界面要读屏、
点控件，一次观测要几十个回合，界面一改就碎。

## 什么时候派

派出去比留在手里好的情况：

- **会淹没上下文**：跑一遍全量测试、读十几个文件找调用点、遍历一批文件改同样一处；
- **可以并行**：两个方案各自验证一遍、前后端各改一半；
- **需要干净环境**：试一个改动、跑一次会失败的命令，不想污染当前对话的推理链路都行；
- **用户明确要求**："开个子会话去做"、"让另一个会话盯着"。

**不要派**的情况：

- 一两步就能做完的事（派出去的开销比做完还大）；
- 必须和你共用同一份可变状态（同一个文件的连续编辑、同一条调试线索）；
- 结论依赖你刚读到的上下文，而那份上下文写不进一句话（那就先写清楚再派）。

## 一次典型的派活

```text
subagent_drive({
  prompt: "在 /repo/api 下跑 bun run test，只跑失败的用例归属哪个模块，把结论按文件列出来。不要改任何代码。",
  title: "跑测试并归类失败",
  cwd: "/repo/api",
})
→ 会话 <id>

subagent_wait({ session_id: "<id>" })                  // 默认等这一轮跑完
→ 状态 + 这一轮的正文 + 工具调用

subagent_drive({ session_id: "<id>", prompt: "再补一句" })   // 追问 / 追加，同一个工具
subagent_stop({ action: "close", session_id: "<id>" })        // 拿到结论就收掉进程
```

并行派三个之后不必一个个等：

```text
subagent_wait({ session_ids: ["<a>", "<b>", "<c>"] })        // 等全部跑完
subagent_wait({ session_ids: ["<a>", "<b>"], any: true })    // 任意一个先跑完就返回
subagent_inspect({ full: true })                              // 一屏收齐结论
subagent_stop({ action: "close", idle: true })               // 收掉跑完的
```

## 它会自己说话（不用轮询）

子会话**每一轮结束、进程退出、卡住**都会记一条动态，你下一轮开工时
会在系统提示里自动看到（"子会话动态"一段），读一次就清空。所以：

- 派完可以**先干别的**，不要为了"看着它"反复 `subagent_inspect`；
- `subagent_wait` 超时也不是白等——它会把条件登记成后台提醒，条件成立时同样跟着下一轮到达；
- 真要现在就要结果，才用 `subagent_wait` / `subagent_inspect`。

## 工具

| 工具               | 做什么                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_drive`   | 给它活：**只给 `prompt`** = 新建一条并投第一件事（返回会话 id）；**给 `session_id`** = 接管一条已落盘会话或追加一句话（在跑就排到下一迭代边界，空闲就开新一轮）。 |
| `subagent_inspect` | 看它（只读）：不带 `view` = 状态（一条的进度 / 全部一行 / `full: true` 收尾汇总）；`view: turns / grep / transcript` = 读内容三档。                        |
| `subagent_wait`    | 等它：`idle`（默认）/ `text`（正文匹配）/ `turn`（新一轮结束）；可多个（`any`）。                                                                          |
| `subagent_stop`    | 停它：`action: "interrupt"` 打断当前这一轮（进程与会话都在，会等到真的停下才回报），`action: "close"` 收掉进程（历史保留，可 drive 接回）；`all` / `idle` 批量，`idle` 是过滤条件（只收跑完的），给了 id 就只在那几条里挑。 |

**不限额**：想开多少个就开多少个（每个都是一个完整进程，内存自己看着办）。

**它有多贵**：每个子会话是一个完整的 mica 进程（空闲时 RSS ≈ 200 MB，启动 2–3s），
每一轮请求都带着它自己的完整 system prompt 与工具定义（实测约 4 万 input token，
`subagent_drive` 追加的那一句同样如此）。所以「一两步能做完的事」派出去是纯亏：
8 个挂着不关的子会话就是 1.6 GB 常驻内存。

**没有任何自动限制**：不限迭代轮数、不限 token、不限并发、不限嵌套层数。`subagent_drive`
没有 `max_turns` / `max_tokens` 这类参数——要它干多久就干多久。插件里**没有任何机制会在
会话干到一半时按下停止键**：预算没有、超时打断没有，停滞检测只发一条提醒。真要停只能显式
`subagent_stop`（`interrupt` 打断这一轮 / `close` 收进程）。

## 怎么读结果

`subagent_wait` / `subagent_inspect` 回的是**投影**：这一轮的正文、工具行（标题 + 状态）、
上一轮结论、用量。原文在子会话自己的对话记录里，需要全文时传 `full: true`。

投影是按「够你决定下一步」裁过的：只留最近一轮、正文截断到几千字符、工具只列最近 8 条
（只有失败的才带输出片段）。所以查进度很便宜——而且自上次查看后没有新输出时，
`subagent_inspect` 只回一行。**不要为了保险多查几次**：真没进展时它也只会告诉你没进展。

### 收尾：先看状态，再按需读正文

```text
subagent_inspect({ full: true })                 // 一屏：每个子会话的状态、结论、失败的工具、用量
subagent_stop({ action: "close", idle: true })  // 顺手收掉已经跑完的进程
```

结论不够清楚时再用 `subagent_inspect` 往下读，**按成本从低到高走**，不要跳级：

```text
subagent_inspect({ session_id, view: "turns" })                        // 几行：它一共几轮、每轮问了什么答了什么
subagent_inspect({ session_id, view: "grep", pattern: "Cannot find" }) // 几行：这句话在哪一轮说过
subagent_inspect({ session_id, view: "grep", pattern: "FAIL", scope: "tools" })  // 命令输出/测试报错里有没有
subagent_inspect({ session_id, view: "transcript", last_turns: 2 })    // 正文：默认只读最近 1 轮
```

一次读多条就传 `session_ids`（不必一条一条来，预算按条分摊）：

```text
subagent_inspect({ view: "transcript", session_ids: ["<a>", "<b>"], max_chars: 6000 })
```

`transcript` 的预算按字符算（默认 8000 ≈ 4k token），超了就丢最早的轮次并写明丢了几轮。
要读更多就必须显式传 `last_turns` 与 `max_chars`——默认值不会自己变大。

判断"它到底做成了没有"，看三样，不要只看正文语气：

1. 这一轮的 `status`（`completed` / `failed` / `interrupted`）；
2. 工具行的状态与输出——失败的命令会带 `[error]` 和输出片段；
3. 它自己写的验证结果（跑了什么、输出是什么）。没验证就让它补一次：

```text
subagent_drive({ session_id, prompt: "把刚才那条命令的实际输出贴出来，并说明改动的文件列表。" })
subagent_wait({ session_id })
```

## 接管一条已有会话

```text
subagent_drive({ session_id: "<会话 id>" })
→ 历史从会话文件补进来（工具调用只有名字），之后 subagent_drive / subagent_wait 照常用
```

`drive` 传 `session_id` 认的是**会话 ID**，不限于本进程派生的：三种场合用它——**收掉的子会话想接着干**、
**父会话重启后接回之前的子会话**、**把用户另一条会话拉进来当执行体**。它不新建会话、不产生
空壳；会话文件不存在（第一轮还没落盘）时直接报错；接管不到当前会话自己。
接管时带上 `prompt` 就省一次调用：接完直接把那句话投过去。

接管之后和其它子会话一样：`subagent_drive` 交给它下一句（空闲就开新一轮，跑着就排到下一迭代
边界），`subagent_stop({ action: "interrupt" })` 打断当前轮（中断，不是冻结进程），
`subagent_stop({ action: "close" })` 收进程，`subagent_inspect` 读它的进度与历史。
目标正在桌面端或其它 app-server 里运行时会被跨进程 turn lease 拒绝，不会抢写同一份会话历史。

## 边界

- **子会话看不到你的对话**。目标、约束、相关路径、验收方式必须写在 `prompt` 里；它不会自己猜你的意图。
- **子会话会污染工作区**。多个 subagent 同时改同一个仓库等于没人在管：`Implementer` 式的改动一次只派一个，并且 `cwd` 写到具体目录。
- **角色默认跟你一样**：不传 `role` 就继承你当前的会话角色（同一个 agent 换个上下文干活）；要它按另一套规则做事才显式给 `role`。角色名写错不会让子会话起不来，会退化成默认角色并给一条 warning。模型与档位默认沿用当前配置，用 `model` / `effort` 覆盖。接管已有会话时这三项不生效（它按会话文件里的配置继续）。
- **会话级 MCP 随委派继承**：父 CLI 显式传入的 `--mcp-config`（空格或 `=` 形式）、
  `--strict-mcp-config` 与 `--mcp-init-timeout-ms` 会传给子会话；配置路径按父进程启动时的
  `--dir`（省略时为启动 cwd）绝对化，不受之后父会话换目录或子会话 cwd 影响。
  只引用原配置，不复制凭据、不写用户配置，控制归属保留原配置里的父 owner。
  这是父任务的委派，不是另建授权或独立控制空间；并行子会话使用同一控制资源时要协调。
  子进程仍是纯 headless 宿主，不继承 `MICA_PLUGIN_DESKTOP_HOST`，也不会因此获得桌面插件宿主能力。
- **它会出现在会话列表**。子会话自动跟随父会话所在的置顶、项目分组或最近会话，父会话可折叠展开它；子会话不能独立拖动或移动分组。会话文件要等第一轮结束才落盘，所以刚 drive 完还看不到；父会话不存在时子会话仍可单独查看。
- **不要用 `subagent_drive` 轮询进度**。看进度是 `subagent_inspect`，等结果是 `subagent_wait`，长期盯着交给自动动态。
- **嵌套不设层数上限**：子会话里可以继续派子会话，想套几层套几层。代价自己判断——每层都是完整的 mica 进程（各自加载 MCP 与插件），层数一多就是指数级的进程树。
- **子进程跟着父会话走**：父会话关掉、app 退出、父进程被强杀，它们都会一起收掉。不要指望跨会话复用，也不要试图让它们活过父进程；想"以后接着干"就在会话列表里找它并 `subagent_drive({ session_id })` 接回来。
- **默认不自动回收**：子会话跑完也待在那儿，像一条正常会话一样可以随时接着问。要省内存就在
  插件设置里填「空闲自动回收」的分钟数（只在结果已经被读过之后才收），收掉的是进程，
  会话历史不丢，`subagent_drive({ session_id })` 接回来即可。
- **卡住会被告知**：在跑但长时间没有新输出（默认 5 分钟）记一条"可能卡住"，并指出当前那条
  工具已经跑了多久。这时先 `subagent_inspect` 看，必要时 `subagent_stop({ action: "interrupt" })`。
- **进程自己退出后条目还在**：`subagent_inspect` 会显示 `已退出` 与退出原因，最后一轮仍能读；不再需要时用 `subagent_stop({ action: "close" })` 清掉，别让它一直挂在列表里。
- **`full: true` 会让投影大好几倍**（正文、工具输出、思考、更早几轮一起给）。只在确实要读
  原文时用一次，别把它当默认值。
- **`cwd` 可以是相对路径或 `~`**：相对路径按当前会话的目录解析，最终一律落成绝对路径。
  目录不存在会直接报错（而不是起一个跑不起来的孩子会话）。
- **投出去的话可能落进当前轮的下一迭代，也可能变成新的一轮**——取决于这一轮还有没有后续迭代。
  `subagent_inspect({ view: "turns" })` 显示的是实际落点，不用自己推断。
  `subagent_drive` 的启动握手与第一句话投递会随父调用取消而收掉尚未交付的子进程；
  已经成功返回的子会话继续独立运行，不受任何迭代或 token 上限约束。
  `subagent_wait` 取消时立即释放等待资源；`until` 只接受 `idle`、`text`、`turn`，
  非法条件或非正数 `timeout_ms`、未知的 `view` / `action` 会直接说明参数问题。
  父会话切换时已经开始退出的子进程仍由插件追踪，插件卸载会等它们真正退出后再完成。
- **界面上也能操作**：桌面端对话右侧的 Subagent 面板列出每个子会话（状态、最近动静、用量），
  可以打断、收掉、看详情；在跑的时候输入框上方有一条"N 个在跑"。用户手动按下这些按钮时，
  你会看到对应的状态变化（子会话不再属于你，但结论仍在）。
