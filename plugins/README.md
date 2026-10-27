# 官方插件

这里的每个目录都是一个随产品分发的插件。`packages/mica-official-plugins` 把它们静态登记成
插件目录（清单来自各自的 `plugin.json`，入口来自各自的 `index.ts`），所以编译后的单二进制
里也能用——不需要在运行时去磁盘上找这个文件夹。

用户自己安装的插件放在 `$MICA_HOME/plugins/<id>/`，格式与这里完全一致（入口换成 `.js` / `.mjs`）。没有
`plugin.json` 的目录、散落成单个 `.js` / `.mjs` 的文件都不会被当成插件。

## 目录结构

```
plugins/<id>/
  plugin.json     清单：id / name / version / description / main / assets / required / desktop
  index.ts        入口，default 导出 setup(ctx)
  ...             实现文件、README、样式等资源
```

`plugin.json`：

| 字段              | 必填 | 说明                                                                                 |
| ----------------- | ---- | ------------------------------------------------------------------------------------ |
| `id`              | 是   | 小写字母、数字、`.`、`_`、`-`；用户插件会在运行期加 `user.` 前缀，避免和内置插件撞名 |
| `name`            | 是   | 展示名                                                                               |
| `version`         | 是   | `1.0.0` 形式                                                                         |
| `description`     | 否   | 配置页与详情里显示的一句话说明                                                       |
| `author`          | 否   | 作者                                                                                 |
| `main`            | 否   | 入口文件，默认 `index.js`；必须在插件目录内                                          |
| `assets`          | 否   | 随插件分发的资源（样式、文档、图标），同样不许跳出版块目录                           |
| `dependencies`    | 否   | 需要先 setup 的插件 id                                                               |
| `required`        | 否   | setup 失败是否中断启动；用户插件默认 `false`                                         |
| `priority`        | 否   | 加载顺序，小的先执行                                                                 |
| `mica.apiVersion` | 否   | 当前只支持 `1`                                                                       |
| `settings`        | 否   | 面向设置页的配置项声明，见下节；插件用 `ctx.settings.get()` 读取                     |
| `requires`        | 否   | 依赖的宿主能力，缺一个就整插件跳过，见下节                                           |
| `desktop`         | 否   | 声明依赖的桌面端运行条件，见「运行条件」一节；用它的插件要同时声明 `requires: ["desktop"]` |

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

## 健康状态与失败可见

`requires` 要写全插件实际触碰的每一面 `ctx.*`：`commands`、`desktop`、`events`、`hooks`、`prompt`、
`session`、`sessionState`、`settings`、`skills`、`subagents`、`tools`、`ui`、`git`、`runtime`、`agent`。宿主缺哪个，
插件就整块不装配，并在 `plugin-status.json` 里记一条 `skipped`（配置页显示「已跳过」与缺的能力名）。
`agent` 是模型请求的迭代改写入口（`ctx.agent.onIterationRewrite`）。
`subagents` 是委派子代理的入口（`ctx.subagents`）：注册类型、前台/后台跑一个、管后台任务。
机制（建子代理、用量记账、路径租约、完成回注）在宿主，插件只决定有哪些类型、`agent` 工具长什么样。
`skills` 是内置 skill 的注册面（`ctx.skills.register`），`desktop` 只有桌面端运行时才提供（见下节）。
少声明一项的后果是在 setup 里撞上 `undefined` 并连带算作加载失败，所以不要把可选项当默认存在。

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

插件自身的故障要能被用户看见，而不是只落在日志里：

- `ctx.health.report({ level: 'warn' | 'error', message, hint })` 写
  `$MICA_HOME/plugin-health/<id>.json`，配置页据此显示「待配置 / 出错」以及原因。
- 缺配置、外部服务拒绝、上一次请求失败，都属于必须上报的情况。
- hook 抛错由宿主记录并继续运行；需要某项宿主能力却没声明 `requires`，会在 setup 时抛错。

## 日志

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
