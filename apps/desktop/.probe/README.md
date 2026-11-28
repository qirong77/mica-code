# .probe

界面探针：把渲染层（或插件）的真实组件单独跑起来，配假 host / 假数据看版式与计算样式。这个目录**纳入 git 管理**——值得复用的探针留在这里，不要用一次性脚本临时搭一遍再删掉。

## 结构

每套探针一个子目录，自成一体（自己的 `index.html` + `main.jsx` + `vite.config.mjs`，必要时加一个替身模块）：

| 目录              | 看什么                                                                              |
| ----------------- | ----------------------------------------------------------------------------------- |
| `client-context/` | HTTPS 严格 CSP / fetch 失败时的原生客户端数据与 Local 返回原窗口回归                |
| `config-ui/`      | 会话设置弹窗的「插件」一节；`config-ui-shim.tsx` 替身 `@mica-config-ui/web`         |
| `config-buttons/` | 真实 ConfigPage + 示例配置，复现桌面 Tailwind 与 Arco 图标按钮的层叠布局            |
| `capabilities/`   | 真实 Capabilities 页面：插件贡献、工具参数、提示词开关与编辑，仅内存示例             |
| `arco-light/`     | 浅色 Arco 一致性预览：真实配置页、控件状态、主题切换与确认/输入弹窗，仅内存示例     |
| `global-search/`  | 全局搜索启动器的真实共享 Arco 输入框、结果列表与焦点样式；`#probe-out` 打出计算样式 |
| `reply-digest/`   | 长回复摘要插件的产出：真实对话行 + `digest` notice 卡，右侧按 `digest.ts` 实时判定  |
| `stats-design/`   | Stats 图表新版：用量全景 / 来源环形分析 / 项目矩形地图，共享示例数据与主题          |
| `digest-design/`  | 长回复摘要的三版 Arco 容器对照，置于模拟对话流中                                    |
| `stats-export/`   | 将对照探针导出为不依赖服务的单文件 HTML                                             |
| `dock-rows/`       | 停靠区：用真组件 + 示例数据摆出运行中 / 中断 / 完成三种场面（回合日志、todo、子代理、后台任务、等待、输入条），并打出三行结论——每行是否同高、收起箭头是否共线且行首齐平、四列是否各成一列 |
| `ask-dock/`        | `ask` 插件的提问卡：真实 `AskDock` 的四种形态 × 六套主题，看它是不是一屏里最先被看见的那个（选项 + 永远在的自由输入框 + 确认条） |
| `plugin-panel/`    | 插件面板弹窗（SSH 的 `desktop.panel.display: "modal"`）：真实 `ModalShell` + `SplitView` + `PluginPanelSection`，看弹窗宽高、左栏宽度、表格列与勾选列 |
| `maccy/`           | 剪贴板浮窗：真实 `Launcher` + 假 launcher，按清单的 760×560 看搜索行、列表与预览、右键菜单、暂停胶囊；`#probe-out` 打出头部/行内/预览的按钮数与行高 |

## 运行

```bash
cd apps/desktop
npx vite --config .probe/global-search/vite.config.mjs   # http://127.0.0.1:5231
npx vite --config .probe/config-ui/vite.config.mjs       # http://127.0.0.1:5199
npx vite --config .probe/config-buttons/vite.config.mjs  # http://127.0.0.1:5235
npx vite --config .probe/capabilities/vite.config.mjs    # http://127.0.0.1:15973
npx vite --config .probe/arco-light/vite.config.mjs      # http://127.0.0.1:5236
npx vite --config .probe/reply-digest/vite.config.mjs    # http://127.0.0.1:5232
npx vite --config .probe/stats-design/vite.config.mjs    # http://127.0.0.1:5233
npx vite --config .probe/digest-design/vite.config.mjs   # http://127.0.0.1:5234
npx vite --config .probe/maccy/vite.config.mjs          # http://127.0.0.1:5240/?theme=light
npx vite --config .probe/dock-rows/vite.config.mjs      # http://127.0.0.1:5237
npx vite --config .probe/ask-dock/vite.config.mjs       # http://127.0.0.1:5238
npx vite --config .probe/plugin-panel/vite.config.mjs   # http://127.0.0.1:5239/?theme=light
```

`vite.config.mjs` 里已固定 `root`，所以在哪个目录执行都能跑；端口按上面两行分配，新增探针另取一个。

`global-search/` 使用真实 `ArcoProvider` / 共享 `Input` 和 `body.mica-arco-theme`，按
宿主 `main.jsx` 的真实顺序加载样式（共享配置页 / Arco 样式 → `app.css` → 插件 chunk），所以能复现
「外层样式把插件控件盖住」这类问题；加 `?theme=light` 看亮色主题下的样子。
组件提交、结果列表完成加载且字体 ready 后，`window.__probe.ready` 为 `true`，
`#probe-out` 的 `states` 输出普通态与键盘焦点态的真实 input 字体、宽高、padding、边框 / outline /
阴影、背景和 placeholder 色。建议同时测 720px（真实浮窗，触发窄屏规则）和 900px 宽度。
真实指针悬停后调用 `window.__probe.measure()` 可更新输出；
`window.__probe.beginOpen()` 通过真实点击结果挂起假打开请求，待 input 的 `disabled`
属性出现后再 `measure()` 检查禁用态尺寸，`window.__probe.finishOpen()` 解除挂起。
打开时搜索行会按现有交互增加 busy 图标，输入框的可用宽度随之收缩；禁用前后应比较
高度、padding、字体和描边，不能把这段已有的布局变化误判为禁用皮肤改变尺寸。
这些 API 只使用假数据，不打开本机文件。探针没有固定延时、轮询或 sleep。

`reply-digest/` 的对话区故意留着 `chat-view` 类名：`--chat-user`、`--chat-row-marker-width`
这组排版变量挂在它上面，去掉之后用户消息带和 gutter 宽度都是假的。判定用插件的
`digest.ts`（`shouldDigest` / `digestInput` / `cleanSummary`），只有卡片里的摘要正文是
一次固定的模型样例输出——页面不联网，所以它不随文本变化。

`digest-design/` 默认展示摘要结果；加 `?status=running` 预览正式组件的运行中文案与呼吸动效，
`?status=warning` 预览未生成时的收尾，均不发模型请求。

`plugin-panel/` 的面板内容不是手写的：`bun .probe/plugin-panel/fixture.mjs`（在 `apps/desktop`
下跑）调真实插件的 `view()` 生成 `ssh-view.json`，SSH 面板改了字段或列就重新生成一次。
它验的是弹窗外壳（宽度 1040px、定高、始终左右分栏），改 `app.css` 里 `.chat-plugin-modal`
那几条规则后用它看效果；加 `?theme=light` 看亮色。

## 约定

- 探针只加假数据（`api`、`items`、`PLUGINS` 这类），不改真实组件去迁就探针；组件在探针里显示不对，就是真实界面有问题。
- 需要断言样式时，把计算样式写进 `#probe-out`，用 headless Chrome 读它，别靠截图肉眼看。
- 一次性的 Node 脚本（`.probe-*.mjs`，只读一次数据、跑完就没有复用价值）仍然用完即删，不进这个目录。
