# dock-rows · 停靠区行高

看**输入框上方那串停靠区**是不是终端式的一行一行：回合日志的标题行、思考行、工具行，
以及它下面 todo / subagent / 后台任务 / 等待那几块的行，全部落在同一条
`--chat-log-row-height`（`app.css` 的 `:root`）格子上。

思考是折行的段落，不是单行：它只要求高度是行高的整数倍（每一行都落在同一条格子上）。

```bash
cd apps/desktop
npx vite --config .probe/dock-rows/vite.config.mjs   # http://127.0.0.1:5237
```

页面顶部给出结论（`每行 20px · 每种行都落在同一条格子上` / 行高对不上的几个值），
`#probe-out` 与 `window.__probe.measure()` 是同一份逐行数据（高度 / 字号 / 行高 / 内边距）。

哪些是真实件：思考行与工具行是 `chat-tool-views.jsx` 的正式组件，行首、todo 行首那几个
按钮是正式 `ArcoAction`（`.arco-btn` 的基础样式会参与行高），样式全部来自 `app.css`。
todo / subagent / 后台三块的行是 `ChatView.jsx` 里的手写结构，这里照抄类名与层级，
只省掉 `Collapse`（展开态在 DOM 上与 `.chat-task-children` 一样）。
