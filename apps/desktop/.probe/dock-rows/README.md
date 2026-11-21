# dock-rows · 停靠区（版式预览 + 量取）

输入框上方那串停靠区的**版式页面**：用真组件配**写死的示例数据**，摆出三种场面，随时打开都能看，
不连运行中的会话、不发起模型或工具请求。

- ① 运行中 · 停靠区收起：模型思考中 + todo（含子项）+ 子代理（含嵌套与活动行）+ 两个后台任务 + 一个等待条件 + 输入条
- ② 中断（可回看）：日志保留、上一轮收成一行、计划标成未完成
- ③ 正常完成：停靠区只剩计划（三条全完成收成一行），日志按设计隐藏

```bash
cd apps/desktop
npx vite --config .probe/dock-rows/vite.config.mjs   # http://127.0.0.1:5237
```

## 页面上量什么

顶部三行结论，`#probe-out` 与 `window.__probe.measure()` 是同一份数据：

1. **行高**：回合日志的标题 / 思考 / 工具行与各任务行都落在同一条 `--chat-log-row-height` 格子上
   （思考是折行段落，只要求高度是行高的整数倍）；
2. **轨道**：带收起箭头的行（回合日志标题、todo、输入条行首标记）箭头中心共线，
   每一行的第一个图形（箭头或种类图标）贴同一条左边缘——**没有箭头的行不占那一格**；
3. **表头列**：状态 / 数值 / 标识 / 描述各只有一列（四块任务行共用 `.chat-task-grid` 的 subgrid，
   `max-content` 只在整张表上算一次）。

左上角「展开回合日志」是整页开关：停靠区的展开态在产品里是一份全局 `ui-state`，一处点开处处摊开，
所以整页只有这一种状态。探针给了一个空实现的 `window.mica.uiState`，点法与用户一致。

## 哪些是真的

块本身全部是 `ChatView.jsx` 导出的正式组件（`TurnLogDock` / `TodoDock` / `SubagentStatusDock` /
`BackgroundTasksDock` / `WaitTasksDock`），示例数据也走正式的判断函数（`todoPanelForTurn`、
`keepsSubagentTaskRow`、`keepsBackgroundTaskRow`），摆不出产品摆不出的样子。样式全部来自 `app.css`。

只照抄了一处：输入条那一行（产品里这段标记同时存在于 `ChatView.jsx` 的可点版与 `BtwDrawer.jsx` 的只读版，
这里照抄只读版的三个类名），它只是让一行看起来完整，不参与行高判断。
