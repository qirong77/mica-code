# 官方插件

这里的每个目录都是一个随产品分发的插件。`packages/mica-official-plugins` 把它们静态登记成
插件目录（清单来自各自的 `plugin.json`，入口来自各自的 `index.ts`），所以编译后的单二进制
里也能用——不需要在运行时去磁盘上找这个文件夹。

用户自己安装的插件放在 `$MICA_HOME/plugins/<id>/`，格式与这里完全一致（入口换成 `.js` / `.mjs`）。没有
`plugin.json` 的目录、散落成单个 `.js` / `.mjs` 的文件都不会被当成插件。

## 目录结构

```
plugins/<id>/
  plugin.json     清单：id / name / icon / version / description / main / assets / required / desktop
  index.ts        入口，default 导出 setup(ctx)
  ...             实现文件、README、样式等资源
```

`plugin.json`：

| 字段              | 必填 | 说明                                                                                               |
| ----------------- | ---- | -------------------------------------------------------------------------------------------------- |
| `id`              | 是   | 小写字母、数字、`.`、`_`、`-`；用户插件会在运行期加 `user.` 前缀，避免和内置插件撞名               |
| `name`            | 是   | 展示名                                                                                             |
| `version`         | 是   | `1.0.0` 形式                                                                                       |
| `description`     | 否   | 配置页与详情里显示的一句话说明                                                                     |
| `icon`            | 否   | 插件图标名（kebab-case），取值见 `packages/mica-config-ui/web/pluginIcons.tsx`；缺省用默认方块图标 |
| `author`          | 否   | 作者                                                                                               |
| `main`            | 否   | 入口文件，默认 `index.js`；必须在插件目录内                                                        |
| `assets`          | 否   | 随插件分发的资源（样式、文档、图标），同样不许跳出版块目录                                         |
| `dependencies`    | 否   | 需要先 setup 的插件 id                                                                             |
| `required`        | 否   | setup 失败是否中断启动；用户插件默认 `false`                                                       |
| `priority`        | 否   | 加载顺序，小的先执行                                                                               |
| `mica.apiVersion` | 否   | 当前只支持 `1`                                                                                     |
| `settings`        | 否   | 面向设置页的配置项声明，见下节；插件用 `ctx.settings.get()` 读、`ctx.settings.set()` 写回          |
| `llm`             | 否   | 需要自己调模型时声明一次，见「模型接口」一节；插件用 `ctx.llm` 读取与请求                          |
| `requires`        | 否   | 依赖的宿主能力，缺一个就整插件跳过，见下节                                                         |
| `desktop`         | 否   | 声明依赖的桌面端运行条件，见「运行条件」一节；用它的插件要同时声明 `requires: ["desktop"]`         |

## 设置项

插件需要用户填参数（接口地址、Key、提示词等）时，在 `plugin.json` 的 `settings` 里声明，
配置页 Plugins 页面会按声明渲染表单、自动保存，插件通过 `ctx.settings.get()` 读当前值：

```json
{
  "settings": [
    {
      "key": "baseUrl",
      "label": "接口地址",
      "type": "text",
      "default": "",
      "placeholder": "https://api.openai.com/v1"
    },
    { "key": "apiKey", "label": "Key", "type": "password", "default": "" },
    {
      "key": "protocol",
      "label": "协议",
      "type": "select",
      "default": "openai_chat_completions",
      "options": [
        { "value": "openai_chat_completions", "label": "Chat Completions" },
        { "value": "openai_responses", "label": "Responses" }
      ]
    },
    { "key": "prompt", "label": "提示词", "type": "textarea", "default": "" }
  ]
}
```

`type` 支持 `text` / `password` / `textarea` / `select` / `number` / `switch`。值统一按字符串存进
`$MICA_HOME/plugin-settings/<id>.json`，未声明的键不会被写入；`select` 必须带 `options`，
`switch` 存 `"true"` / `"false"`。插件每轮读取时会比对文件 mtime，用户改完不需要重启。

插件自己拿到了值（注册换回的口令、探测到的地址）用 `ctx.settings.set({ token })` 写回去：
只改传入的键，其余保持原样，写盘前过同一份校验。**不要让用户复制粘贴插件本该自己拿到的东西**——
那是这类配置最容易出错的一步，也不会有人看得懂「口令至少 16 位」这种提示。

### 运行状态（`status`）

插件有运行态要给人看（连没连上、现在是哪台机器、链接是什么）时，在 `plugin.json` 里声明
「页面有哪几行」，值自己写进 `$MICA_HOME/plugin-data/<id>/data.json`：

```json
"status": [
  { "key": "phoneUrl", "label": "手机链接", "type": "link" },
  { "key": "relay", "label": "中转机", "type": "text" }
]
```

`data.json` 里对应的键可以是字符串，也可以是 `{ "text": "可达", "tone": "ok" }`
（`tone` 取 `ok` / `warn` / `error`）。**语义由插件判断，页面只按语气上色**——配置页不认识
任何具体插件，也不替它编造值；没写过的键显示「尚未上报」。卡片（`desktop.jsx`）读的是同一份文件。

### 模型接口（`llm`）

插件要自己问一次模型（起标题、写提交说明、整理记忆）时，不要在 `settings` 里手写那四项：

```json
"llm": {
  "label": "起标题模型",
  "description": "每轮开始前把最近对话交给它生成标题。",
  "followMain": true,
  "modelPlaceholder": "gpt-4o-mini",
  "required": true
}
```

声明会展开成 `useMainProvider`（`followMain` 为真时）/ `baseUrl` / `apiKey` / `protocol` /
`model` 这几个普通设置项（`group: "llm"`），所以存储、校验、按会话覆盖仍然只有一条路径，
页面把它们收进同一个「模型接口」面板：

- `followMain`：多一个「跟随主配置」开关，默认开。打开时地址 / Key / 协议 / 模型都取自
  当前会话的 provider（模型名带 `provider/model` 前缀时按前缀路由），关掉才用自己填的四项；
- `required`：只在关掉「跟随主配置」后要求填写，跟着主配置时留空是正常状态；
- 面板右侧有「测试连接」：发一次真实的最小请求并给出耗时或可照做的原因，用的是插件
  运行时同一条请求实现，测通了就代表能工作。

代码里只读生效值、只给提示词：

```ts
const llm = ctx.llm;                       // 清单声明了 llm 才有
if (!llm?.configured()) return;            // 没配置就别发请求
const { text } = await llm.request({ purpose: '自动起标题', system, user });
```

请求由宿主代发并记账（`origin: 'plugin'`，记进会话的 `subagentUsageHistory`），插件里不要
自己拼地址 / Key，也不要自己发 HTTP。`requires` 里同时写上 `llm`。

`number` 还可以声明 `step` 与 `unit`：页面把它画成「− 输入 +」加单位，而不是铺满整行的
原生数字框。少一次「用户不知道该填多少」的来回。

字段还能带约束，写错的值既存不进盘、也不会被插件当成有效配置：

| 键          | 作用                                                 |
| ----------- | ---------------------------------------------------- |
| `required`  | 必填；留空时页面标红，插件读到空值就知道自己没被配置 |
| `format`    | `url`（必须是 http/https 绝对地址）或 `number`       |
| `min`/`max` | 数值范围                                             |
| `step`      | 数值项的步进（页面的 −/+ 按它走），缺省 1            |
| `unit`      | 数值项的单位，显示在控件右侧（`k tokens` / `分钟`）  |
| `pattern`   | 正则，整串必须匹配                                   |

校验只有一份实现（`validatePluginSettingValues`）：页面保存前用它拒绝，插件运行时读值也用它，
所以不会出现「页面显示已保存、插件却认为配置不可用」。

字段加 `perSession: true` 表示这条会话可以单独覆盖：默认值仍写在同一个设置文件里（配置页改），
会话里的改动只存**改过**的键（快照 `pluginSessionSettings`），没动过的继续跟随默认值——整份存会把
当时的默认值固化进老会话。插件用 `ctx.sessionSettings.get()` 读合并后的生效值，声明了它就同时把
`sessionSettings` 写进 `requires`；界面由内核的 `mica/pluginSettings/get|set` 驱动，桌面端在
会话设置 → 插件 里按清单渲染，内核不认识任何具体插件。

## 健康状态与失败可见

`requires` 要写全插件实际触碰的每一面 `ctx.*`：`background`、`commands`、`desktop`、`events`、`hooks`、`prompt`、
`session`、`sessionSettings`、`sessionState`、`settings`、`skills`、`subagents`、`tools`、`ui`、`git`、`runtime`、`agent`、`models`、`llm`。宿主缺哪个，
插件就整块不装配，并在 `plugin-status.json` 里记一条 `skipped`（配置页显示「已跳过」与缺的能力名）。
`agent` 是模型请求的迭代改写入口（`ctx.agent.onIterationRewrite`）。
`subagents` 是委派子代理的入口（`ctx.subagents`）：注册类型、前台/后台跑一个、管后台任务。
机制（建子代理、用量记账、路径租约、完成回注）在宿主，插件只决定有哪些类型、`agent` 工具长什么样。
需要一条能反复追问的隔离上下文（旁问、连续修订）时用 `ctx.subagents.thread()`：一次建线程、多次
`ask()`，同一线程串行、`usage()` 读请求数、`dispose()` 收尾；它不进任务列表、不拿路径租约，每次 ask
的用量同样以 `origin: 'plugin'` 记账。system prompt 是整体替换，插件要自己带上需要的上下文。
`models` 是插件自己的模型请求入口（`ctx.models.request`），见下节——**插件不要自己 `fetch` 模型接口**。
`skills` 是内置 skill 的注册面（`ctx.skills.register`），`desktop` 只有桌面端运行时才提供（见下节）。
`background` 是常驻工作的注册面（`ctx.background.register`）：周期轮询、心跳、增量同步这类
「一直在跑」的东西交给宿主调度，插件停用或宿主退出时一起停。不要用 `setInterval` 自己起循环，
也不要把它做成 launchd / systemd 单独安装的服务——那样插件关了它还在跑，用户根本不知道还有东西在外联。
间隔用 `every: number | (() => number)` 声明，函数形式每轮结束后重新取值，便于按状态退避；
单轮抛错只记该插件的健康状态与日志，不会停掉后续调度。需要跟着插件一起结束的子进程，
在 `ctx.onDispose()` 里自己杀掉（`startedAt`/`pid` 之类的状态写 `$MICA_HOME/plugin-data/<id>/`）。
少声明一项的后果是在 setup 里撞上 `undefined` 并连带算作加载失败，所以不要把可选项当默认存在。

命令结果给用户看走 `ctx.ui.notice(content, { command, status, surface })`：`surface: 'command_panel'`
是输入框上方的运行中面板（被同一个 `command` 的下一条 notice 收尾），默认写进对话的 notice；
headless 宿主把同一条 notice 落进 turn 的日志。插件不用自己画面板，也不往会话里塞假消息。

## 插件自己的模型请求

后台请求（自动起标题、写 commit message、整理记忆…）一律走 `ctx.models.request`：

```ts
const { text, usage } = await ctx.models.request({
  purpose: '自动起标题',       // Stats 里显示的用途
  system: prompt,
  user: transcript,
  baseUrl: settings.baseUrl,   // 插件自己的接口地址
  apiKey: settings.apiKey,
  protocol: settings.protocol, // openai_chat_completions | openai_responses
  model: settings.model,
  timeoutMs: 60_000,           // 可选，宿主会真的中断请求而不是只 reject
});
```

请求由宿主发出，所以三件事只有一份实现：协议分支（Chat Completions / Responses）、超时与中断、
**用量记账**——这笔开销会以 `origin: 'plugin'` 记进当前会话的 `subagentUsageHistory`，在
Stats 的「By plugin」卡片与会话详情里能看到。插件自己 `fetch` 的请求没有会话写面可以记，
用户在 Stats 里就永远看不到它花了多少。

## 内置 skill

插件可以把 skill 随包分发：正文用 `import SKILL_MD from './skill/SKILL.md' with { type: 'text' }`
内嵌，元数据从 frontmatter 解析（`micaSkills.parseMarkdown`，单一来源），再注册：

```ts
const skill = micaSkills.parseMarkdown(SKILL_MD);
ctx.skills.register({ ...skill, name: skill.name!, description: skill.description!, baseDir: runtimeDir });
```

注册进来的 skill 与磁盘扫描出来的完全同权：进 system prompt 索引、`skill` 工具能加载、会话能力
页签能关掉它。差别只有两点：

- **磁盘优先**：用户在自己的 skills 目录里放了同名 skill 就覆盖内置的；被遮蔽的条目从
  `register()` 返回的 `skipped` 读出来，插件应当把它报成一条健康状态。
- **没有磁盘路径**：只落盘 `SKILL.md` 是不够的——`baseDir` 必须是宿主真能读到的目录，正文里引用的
  脚本都相对它解析。所以插件要把随包资源先写到 `$MICA_HOME/<自己的目录>`，再用落盘路径注册。
  单二进制里没有插件目录可读，内嵌 + 落盘是唯一可行路径（参考 `plugins/computer-use`）。

配置页的 Skills 页面只管磁盘上的 skill（新建 / 删除 / 编辑文件），内置 skill 出现在会话能力页签里。

## 运行条件

插件依赖桌面端的权限或外部工具时，在清单里声明（**只声明 id**，不是渲染代码、也不是探测代码）：

```json
"desktop": {
  "checks": ["accessibility", "screen-recording"]
}
```

取值来自 `DESKTOP_CHECKS` 目录（`mica-plugin/PluginDesktop.ts`）：`accessibility` /
`screen-recording` / `command-line-tools`。

声明之后，配置页 **Settings → Plugins → 该插件** 会多出一块「运行条件」：每行显示已开启 /
未开启 / 未知，以及「打开设置」按钮跳到对应的系统设置面板（探测与跳转都只有桌面应用做得了，
见 AGENT.md 第 9 节）。插件不描述状态、不拼系统设置 URL、也不渲染界面——它跑在
`mica app-server` 子进程里，本来就没有渲染面，权限状态也不属于它。

新增一种运行条件 = 在 `mica-plugin/PluginDesktop.ts` 登记 + 桌面端实现探测器，插件侧只改清单。

依赖这个能力的插件用 `requires: ["desktop"]` 声明：只有桌面端 spawn 的 app-server 才提供它，
CLI / TUI / `mica exec` 里整插件跳过（而不是装上了却永远显示不了状态）。

## 桌面入口

插件想让自己的能力出现在**桌面端侧栏**（一行入口 + 点开的卡片）时，在同一段里声明入口，
再把卡片写成插件目录里的 `desktop.jsx`：

```json
"desktop": { "entry": { "label": "Connections" } }
```

```jsx
// desktop.jsx
export default function MyCard({ api, onClose }) { … }
export function summary(api) { return api.currentHost() } // 可选：入口行右侧那一行字
```

- 入口的文案来自清单，图标用清单的 `icon`；`label` 不写就退化成插件的 `name`。
- 卡片**只画内容**：定宽、浮层定位、悬停/点击展开、Esc 与点外面收起都由宿主
  （`apps/desktop/src/renderer/src/PluginEntries.jsx`）负责。
- 宿主按插件 id 用 `import.meta.glob('@plugins/*/desktop.jsx')` 找模块，所以**不需要在宿主里
  登记**——加一个桌面入口只改插件目录。
- 模块拿到的 `api` 只有五件事：`currentHost()`（页面所在运行时的 origin）、`probe(address)`
  （探活一个地址，页面跨源读不到结果，由运行时代查）、`readData()` / `writeData(value)`
  （插件自己的 `$MICA_HOME/plugin-data/<id>/data.json`，宿主不解析结构）、`open(url)`
  （外壳里开新窗口、浏览器里开新标签页）、`access`（`get()` / `set({ enabled, password })`
  读写这台机器的远程访问策略——请求分派只存在于运行时进程，页面自己改不了）。
- **只对随包插件生效**：桌面页面是构建期打的包，只能收录打包时仓库里存在的
  `plugins/<id>/desktop.jsx`；用户插件装在运行时才出现的 `$MICA_HOME/plugins`，声明了也
  渲染不出入口，所以 `desktop.entry` 不必也不能靠 `requires: ["desktop"]` 表达——
  它不依赖 app-server 的能力面。

## 对话右侧面板

插件想在**对话界面**里放一块自己的界面（配置、状态、一列可操作的条目）时声明面板。和侧栏入口
相反，面板是**插件给数据、宿主画出来**，所以 `$MICA_HOME/plugins` 里的用户插件也能有：

```json
"desktop": {
  "panel": {
    "label": "需求开发",
    "roles": ["需求开发"],
    "shortcuts": [
      { "label": "立刻检查", "action": "check.now" },
      { "label": "频道设置", "section": "聊天频道" }
    ]
  }
}
```

```js
ctx.desktop.panel({
  // 会被反复调用（打开、每次动作之后、页面每 4 秒轮询）：只读自己缓存的状态，
  // 不要在这里跑外部命令或请求模型——那些属于动作或插件的定时器。
  view: () => ({
    title: '需求开发',
    subtitle: '角色：需求开发',
    status: { label: '2 个频道', tone: 'ok' },
    sections: [
      {
        title: '聊天频道',
        items: [{ key: 'group:需求群', label: '需求群', value: '群 · 未读', actions: [{ id: 'remove', label: '删除' }] }],
        empty: '还没有频道',
        fields: [{ key: 'target', label: '群名', placeholder: '例如 租车-需求群' }],
        actions: [{ id: 'add', label: '添加频道', tone: 'primary' }],
      },
      { title: '定期复盘', collapsed: true, rows: [{ label: '触发条件', value: '每 8 轮或每 120 分钟' }] },
    ],
  }),
  // 只回 id，视图由宿主再取一次：插件不需要回传「新视图」。
  action: async ({ action, key, values }) => { … },
});
```

- `roles` 是显示条件（会话角色名，`$MICA_HOME/role/<name>.md`）；空数组表示任何角色都显示。
  宿主按当前会话角色过滤，插件在页面里判断不了这件事。
- 一个插件只有一块面板（`ctx.desktop.panel()` 再调用会替换上一块）：对话右侧只有一条位置，
  多块就变成插件之间的版面竞争。
- `shortcuts` 是**输入框正上方那排按钮**，每个二选一：`action` 点了直接把该动作交给
  `action` 处理器（不打开面板，例如「立刻检查」）；`section` 点了打开面板并展开同名的那一块
  （例如「频道设置」）。没有常用动作插件就别声明，一条空按钮比没有更糟。
- 面板只表达「几行只读状态 + 一列条目 + 几个输入框 + 几个按钮」。宿主会裁剪长度、条目数与
  字段类型，畸形视图不会让页面崩掉；它拿到的动作只有 `{ action, key?, values? }`。
- 每个 section 是一块独立折叠卡片（`collapsed: true` 表示初始收起），抽屉盖在对话区右侧。
- 点击 `shortcut` 的 `action` 必须立刻返回：页面在等这个 invoke 的回包，外部命令与模型
  请求应当做成「投一段话进会话，让模型自己去做」，而不是在按钮回调里同步等。
- 动作做不了（少了配置、频道为空）时 `return { message: '先添加频道' }`：页面会在按钮旁边
  显示这一行。`ctx.ui.notice()` 在常驻宿主里只落进 notice 记录，用户点完按钮往往看不到。
- 只有清单声明了 `desktop.panel` 时 `ctx.desktop.panel` 才存在——不声明却被静默接受注册，
  插件会以为界面已经出现，实际页面上什么都没有。所以声明 `desktop.panel` 的插件同样要写
  `requires: ["desktop"]`。
- 插件投递工作时用 `ctx.runtime.submit(text, { source: 'plugin', displayText })`：这一轮会像
  用户说的话一样进会话记录（`displayText` 是界面上那一句，`text` 是真正发给模型的提示词）。

插件自身的故障要能被用户看见，而不是只落在日志里：

- `ctx.health.report({ level: 'warn' | 'error', message, hint })` 写
  `$MICA_HOME/plugin-health/<id>.json`，配置页据此显示「待配置 / 出错」以及原因。
- 缺配置、外部服务拒绝、上一次请求失败，都属于必须上报的情况。
- hook 抛错由宿主记录并继续运行；需要某项宿主能力却没声明 `requires`，会在 setup 时抛错。

## 日志

需要观察运行的插件可以订阅只读 `agent:observe` hook（类型 `AgentObservationEvent`）：宿主提供 owner/runId、运行开始与终态、实际请求边界与工具定义、最终 prompt、工具调用与结果、用量、重试和历史改写。通过 `HookRegistry.notify()` 派发：按顺序调用但不等待异步 handler；失败或挂起不阻塞任务，观察插件自己维护 IO 队列并在 dispose 时 flush。观察者不得修改事件中的运行输入。它覆盖 `AgentRuntime.run`，直接创建的 helper 模型客户端目前不在完整观察范围内。官方 [Harness Review](harness-review/README.md) 用这个接口异步记录并生成复盘报告。

插件拿到的 `ctx.logger` 自带文件输出，写在系统临时目录，不占用户配置目录：

```
os.tmpdir()/mica-logs/plugin-<id>-<YYYYMMDD>[-n].jsonl
```

单文件超过 2 MB 自动分片，超过 3 天的文件在下次写入时清理；`MICA_PLUGIN_LOG=0` 关闭。
排查插件问题时先看这里，配置页插件详情里也会显示当前日志路径。

## 加一个新插件

1. 新建 `plugins/<id>/`，写 `plugin.json` 与 `index.ts`（`export default function setup(ctx)`）。
2. 在 `packages/mica-official-plugins/manifests.ts` 里登记清单，在 `index.ts` 里登记 setup。
3. 跑 `bun run typecheck` 与 `bun run test`；插件自己的测试放在插件目录里（`*.test.ts`）。

## 启用与停用

配置页的 Plugins 页面读写 `$MICA_HOME/plugins-state.json`：

```json
{ "disabled": ["todo"] }
```

停用的插件在启动阶段就不会被注册（工具、命令、钩子一起消失），改完需要重开会话才生效。

## 装在自己机器上的插件

`$MICA_HOME/plugins/<id>/` 下的插件与官方插件同格式（目录 + `plugin.json` + 入口，入口里
`export default function setup(ctx)`），id 一律加 `user.` 前缀。它们由 `mica app-server`
（桌面端）与 TUI 启动时加载，`mica exec` 这类一次性运行不加载——避免插件的定时器、外部命令
与额外模型请求混进一次基准运行。加载结果写 `$MICA_HOME/plugin-status.json`，配置页据此显示
「加载失败 / 缺少宿主能力」。

用户插件没有构建步骤，入口是纯 JS：只用 Node 内置模块与 `ctx`，不要 `import` 仓库里的
`@packages/*`（单二进制里没有那些路径）。要界面就用上面的 `desktop.panel`；要定时逻辑就在
`setup()` 里起定时器，并用 `ctx.onDispose()` 收尾。
