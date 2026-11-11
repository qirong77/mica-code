# .probe

界面探针：把渲染层（或插件）的真实组件单独跑起来，配假 host / 假数据看版式与计算样式。这个目录**纳入 git 管理**——值得复用的探针留在这里，不要用一次性脚本临时搭一遍再删掉。

## 结构

每套探针一个子目录，自成一体（自己的 `index.html` + `main.jsx` + `vite.config.mjs`，必要时加一个替身模块）：

| 目录              | 看什么                                                                              |
| ----------------- | ----------------------------------------------------------------------------------- |
| `client-context/` | HTTPS 严格 CSP / fetch 失败时的原生客户端数据与 Local 返回原窗口回归                |
| `config-ui/`      | 会话设置弹窗的「插件」一节；`config-ui-shim.tsx` 替身 `@mica-config-ui/web`         |
| `config-buttons/` | 真实 ConfigPage + 示例配置，复现桌面 Tailwind 与 Arco 图标按钮的层叠布局            |
| `arco-light/`     | 浅色 Arco 一致性预览：真实配置页、控件状态、主题切换与确认/输入弹窗，仅内存示例     |
| `global-search/`  | 全局搜索启动器的真实共享 Arco 输入框、结果列表与焦点样式；`#probe-out` 打出计算样式 |
| `reply-digest/`   | 长回复摘要插件的产出：真实对话行 + `digest` notice 卡，右侧按 `digest.ts` 实时判定  |
| `stats-design/`   | Stats 图表新版：用量全景 / 来源环形分析 / 项目矩形地图，共享示例数据与主题          |
| `digest-design/`  | 长回复摘要的三版 Arco 容器对照，置于模拟对话流中                                    |
| `stats-export/`   | 将对照探针导出为不依赖服务的单文件 HTML                                             |
| `notebook-design/` | Notebook 真实编辑预览：C 工作台 / D 分区 / E 一体对比，保留 A/B；丰富示例、共享 Lexical 与六套主题 |
| `notebook-workbench/` | 方案 D 正式 Notebook 页面验收：真实目录/自动保存/大纲组件、内存 CAS 宿主、丰富示例与主题切换 |

## 运行

```bash
cd apps/desktop
npx vite --config .probe/global-search/vite.config.mjs   # http://127.0.0.1:5231
npx vite --config .probe/config-ui/vite.config.mjs       # http://127.0.0.1:5199
npx vite --config .probe/config-buttons/vite.config.mjs  # http://127.0.0.1:5235
npx vite --config .probe/arco-light/vite.config.mjs      # http://127.0.0.1:5236
npx vite --config .probe/reply-digest/vite.config.mjs    # http://127.0.0.1:5232
npx vite --config .probe/stats-design/vite.config.mjs    # http://127.0.0.1:5233
npx vite --config .probe/digest-design/vite.config.mjs   # http://127.0.0.1:5234
npx vite --config .probe/notebook-design/vite.config.mjs # http://127.0.0.1:5286/comparison.html
npx vite --config .probe/notebook-workbench/vite.config.mjs # http://127.0.0.1:5287/
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

## 约定

- 探针只加假数据（`api`、`items`、`PLUGINS` 这类），不改真实组件去迁就探针；组件在探针里显示不对，就是真实界面有问题。
- 需要断言样式时，把计算样式写进 `#probe-out`，用 headless Chrome 读它，别靠截图肉眼看。
- 一次性的 Node 脚本（`.probe-*.mjs`，只读一次数据、跑完就没有复用价值）仍然用完即删，不进这个目录。
