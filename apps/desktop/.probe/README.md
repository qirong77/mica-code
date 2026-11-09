# .probe

界面探针：把渲染层（或插件）的真实组件单独跑起来，配假 host / 假数据看版式与计算样式。这个目录**纳入 git 管理**——值得复用的探针留在这里，不要用一次性脚本临时搭一遍再删掉。

## 结构

每套探针一个子目录，自成一体（自己的 `index.html` + `main.jsx` + `vite.config.mjs`，必要时加一个替身模块）：

| 目录             | 看什么                                                                             |
| ---------------- | ---------------------------------------------------------------------------------- |
| `config-ui/`     | 会话设置弹窗的「插件」一节；`config-ui-shim.tsx` 替身 `@mica-config-ui/web`        |
| `config-buttons/` | 真实 ConfigPage + 示例配置，复现桌面 Tailwind 与 Arco 图标按钮的层叠布局 |
| `global-search/` | 全局搜索启动器的输入框、结果列表与焦点样式；右下 `#probe-out` 打出计算样式         |
| `reply-digest/`  | 长回复摘要插件的产出：真实对话行 + `digest` notice 卡，右侧按 `digest.ts` 实时判定 |
| `stats-design/` | Stats 图表新版：用量全景 / 来源环形分析 / 项目矩形地图，共享示例数据与主题 |
| `digest-design/` | 长回复摘要的三版 Arco 容器对照，置于模拟对话流中 |
| `stats-export/` | 将对照探针导出为不依赖服务的单文件 HTML |

## 运行

```bash
cd apps/desktop
npx vite --config .probe/global-search/vite.config.mjs   # http://127.0.0.1:5231
npx vite --config .probe/config-ui/vite.config.mjs       # http://127.0.0.1:5199
npx vite --config .probe/config-buttons/vite.config.mjs  # http://127.0.0.1:5235
npx vite --config .probe/reply-digest/vite.config.mjs    # http://127.0.0.1:5232
npx vite --config .probe/stats-design/vite.config.mjs    # http://127.0.0.1:5233
npx vite --config .probe/digest-design/vite.config.mjs   # http://127.0.0.1:5234
```

`vite.config.mjs` 里已固定 `root`，所以在哪个目录执行都能跑；端口按上面两行分配，新增探针另取一个。

`global-search/` 按 `index.html` 的真实顺序加载样式（配置页样式 → `app.css` → 插件
chunk），所以能复现「外层样式把插件控件盖住」这类问题；加 `?theme=light` 看亮色主题
下的样子。

`reply-digest/` 的对话区故意留着 `chat-view` 类名：`--chat-user`、`--chat-row-marker-width`
这组排版变量挂在它上面，去掉之后用户消息带和 gutter 宽度都是假的。判定用插件的
`digest.ts`（`shouldDigest` / `digestInput` / `cleanSummary`），只有卡片里的摘要正文是
一次固定的模型样例输出——页面不联网，所以它不随文本变化。

## 约定

- 探针只加假数据（`api`、`items`、`PLUGINS` 这类），不改真实组件去迁就探针；组件在探针里显示不对，就是真实界面有问题。
- 需要断言样式时，把计算样式写进 `#probe-out`，用 headless Chrome 读它，别靠截图肉眼看。
- 一次性的 Node 脚本（`.probe-*.mjs`，只读一次数据、跑完就没有复用价值）仍然用完即删，不进这个目录。
