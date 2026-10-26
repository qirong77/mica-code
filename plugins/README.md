# 官方插件

这里的每个目录都是一个随产品分发的插件。`packages/mica-official-plugins` 把它们静态登记成
插件目录（清单来自各自的 `plugin.json`，入口来自各自的 `index.ts`），所以编译后的单二进制
里也能用——不需要在运行时去磁盘上找这个文件夹。

用户自己安装的插件放在 `$MICA_HOME/plugins/<id>/`，格式与这里完全一致（入口换成 `.js` / `.mjs`）。没有
`plugin.json` 的目录、散落成单个 `.js` / `.mjs` 的文件都不会被当成插件。

## 目录结构

```
plugins/<id>/
  plugin.json     清单：id / name / version / description / main / assets / required
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

`type` 支持 `text` / `password` / `textarea` / `select` / `number`。值统一按字符串存进
`$MICA_HOME/plugin-settings/<id>.json`，未声明的键不会被写入；`select` 必须带 `options`。
插件每轮读取时会比对文件 mtime，用户改完不需要重启。

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
