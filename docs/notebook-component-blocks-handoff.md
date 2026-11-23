# Notebook 组件块交接 · 2026-11-23（已完成）

**状态：代码、文档、构建、隔离实例验收与图鉴发布都已完成。** 唯一剩下的是重启用户当前的桌面实例，让运行中的插件服务从 `1.5.0` 升到 `1.6.0`；新构建已落在 `apps/desktop/dist/mac-arm64/mica-code-app.app`，重启后生效。没有提交。

## 已完成

| 部分 | 结果 | 入口 |
| --- | --- | --- |
| AI 发现模板 | `GET /modules/blocks` 返回带 `capabilities` 的七项模板目录；按条目 `path` 取 `source`（直接写块）或 `markdown`（可与正文混排）。 | `packages/mica-editor/componentCatalog.ts`、`plugins/notebook/api.ts` |
| AI 单块读写 | `GET /notes/:id/blocks` 列出含嵌套的块与版本；`POST` 用 `template_id` 或 `type + source` 插入；`PATCH /notes/:id/blocks/:block_id` 只改目标源码。写入都带 `expected_version`，409 要重读。 | `plugins/notebook/component-blocks.ts` |
| 七种模板 | 计数器、指标卡、筛选列表、参数计算器、SVG 趋势图、可排序对比表、分步流程；全部用 React 样式对象，渲染与交互有测试。 | `componentCatalog.ts`、`runtime/tests/componentCatalog.render.test.ts` |
| 插入体验 | 插入弹窗有「源码 / 运行预览」两个视图，预览走同一沙箱、不写回；切换模板遇到草稿在弹窗内确认。 | `…/plugins/ComponentExtension/index.tsx` |
| 错误与主题 | 错误边界可读；普通资源加载失败不再当成整块失败；iframe 只认当前 frame，主题消息只接受 `parent`。 | `nodes/{ComponentNode,sandboxBlock}.tsx` |
| 文档 | Notebook README 增加「AI 直接操作块」，角色说明增加「只改一个块」，编辑器与插件 README 同步七种模板。 | 见各 README |
| 图鉴脚本 | 生成《Mica 组件块图鉴：从读数到做决策》，7 节、7 个组件块、约 10.1k 字符，只打印 `POST /notes` 的 JSON。 | `plugins/notebook/examples/component-gallery.ts` |

## 本轮验证

- 单测：Notebook API + Markdown **50/50**；编辑器渲染 / 插入 / 沙箱 **20/20**（含七种模板的挂载与交互断言）。
- 类型检查：仓库根 `bun run typecheck` 与 `packages/mica-editor/runtime` 的 `npm run typecheck` 均通过。
- 构建：`cd apps/desktop && npm run build:app` 成功，产物时间 19:01；`sign:app` 因本机未找到 `mica-codesign` 身份而跳过，保持 adhoc 签名（本机运行可用，首次启动可能需重新授予本地网络权限）。
- 隔离实例（新构建、独立 `MICA_HOME` / user-data / 8791 端口）：
  - `GET /modules/blocks` 返回 **7 个模板**与 `block_id` 文档，版本显示 `1.6.0`。
  - 用 `POST /notes` 写入图鉴：`warnings: []`，`statistics.component_blocks: 7`。
  - 逐一打开七个模板的单独笔记并截图确认渲染：计数器、指标卡（三个数字 + 进度条 + 标签）、筛选列表（4 项）、计算器（128 × 3 × 90% = 345.60 元）、趋势图（7 个点、7 天/8 周按钮）、对比表（按评分降序 A/C/B）、分步流程（第 1/3 步、上一步禁用）。
  - 深色主题：设置 `data-appearance=dark` 后页面与块内 Arco 组件同步变暗，块未重建。
  - 演示模式：顶栏「演示」生效，编辑器工具栏隐藏、底栏显示「方向键翻页 · Esc 退出」，组件仍可见且编辑入口消失。
- 受控浏览器的坐标点击只能落在编辑器 iframe 元素本身，无法驱动 iframe 内部的组件按钮/输入框；因此组件交互以渲染测试为准，真实实例的交互点按仍需人工点一次确认。
- 发布：图鉴已写入用户真实 Notebook 顶层，`node_id = 446286fc-4d71-469a-9709-45c430649d65`，标题《Mica 组件块图鉴：从读数到做决策》，`warnings: []`，7 个 component 节点；旧服务 `1.5.0` 写入，读回结构正确。

## 剩余动作

1. 重启桌面端（用户自己触发）。重启后 `GET /plugin/notebook/api/overview` 的 `notebook.version` 应为 `1.6.0`，`/modules/blocks` 应出现 `templates`；届时 AI 才能用单块端点。
2. 重启后打开 `http://127.0.0.1:8787/plugins/pages/notebook?note=446286fc-4d71-469a-9709-45c430649d65`，手工点一次计数器、筛选输入、计算器输入与趋势切换，确认交互；演示模式下确认组件可操作、源码入口不可用。
3. 若 macOS 首次启动提示本地网络权限，重新允许即可（本次签名被跳过）。

## 注意

- 工作区仍有并行会话的 subagent / 聊天界面改动与未跟踪文件（`apps/desktop/src/renderer/src/editor-activity-bar.js` 等），不属于本任务，不要还原或提交。
- 保留未跟踪的 `componentCatalog.ts`、`component-blocks.ts`、`componentCatalog.render.test.ts`、`examples/`。
- 不要直接改 `$MICA_HOME/plugin-data/notebook/` 下的 JSON；需要写笔记走 HTTP 接口。
