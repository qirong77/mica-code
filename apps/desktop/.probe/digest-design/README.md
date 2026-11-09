# 长回复摘要 · Arco 外观对照

独立的 React / Vite 界面探针，仅使用虚构样例，不连接后端，不读写当前会话、配置或主题缓存。已选的方案 C 直接复用正式 `DigestNotice` 容器，A / B 保留作外观对照。

## 运行

在仓库根目录执行：

```sh
bunx --no-install vite --config apps/desktop/.probe/digest-design/vite.config.mjs
```

打开 `http://127.0.0.1:5234/?variant=c&theme=auto`（不传 `variant` 也默认 C）。端口固定，已被占用会直接报错，不会自动另选端口。

## 三种候选

- **A · 标准卡片**：真实 Arco `Card size="small"`，标准标题与中性元信息，正文只有一层；没有渐变、强调色底或阴影，摘要始终可见。
- **B · 轻量提示**：真实 Arco `Alert type="info"`，保留标准标题 / 内容结构，不显示提示图标，仅在当前候选中把蓝色背景 token 映射为中性表面。它不是错误或警告。
- **C · 可收起摘要（已选）**：正式 `DigestNotice` 通过共享 `CollapsiblePanel` 复用真实 Arco `Collapse`，默认展开；点击标题或聚焦标题后按 Enter 可以收起 / 展开，不会收起原回复。容器和正文样式都来自产品，不在探针复制。

三版使用完全相同的四条 Markdown 摘要，包含加粗、行内代码与超长虚构路径。上方工具栏可切换方案、`auto` 与全部六套真实主题；“三版并排”用于宽屏比较，窄屏自动改为纵向排列。每版均嵌在同一份模拟消息流里。

## 实现边界

- `main.jsx` 通过共享入口复用 `ArcoProvider`、`Segmented`、`SelectMenu`、`Tag`、`Button`；仅备选 Card / Alert 使用 Arco ES 深路径。C 导入 `src/renderer/src/DigestNotice.jsx`，正式组件只接受正文 children，不另建 Markdown 渲染器。
- 直接加载真实 `app.css`、共享入口样式，使用 `chat-view` / 消息 / Markdown 外壳；不加载 ChatView 和后端，也不使用旧摘要卡皮肤。
- `probe.css` 仅按需加载 Card / Alert 的组件 CSS 到 `mica-arco` layer，没有额外引入 Arco 全局 normalize；局部规则只负责探针布局和备选方案。C 的折叠样式由共享入口加载，字号、行高、元信息和窄屏换行全用 `app.css` 的正式规则。
- 字号读取真实 `--chat-text-size`，摘要与示例回复行高均为 1.65，不继承 body 默认的 16px。
- 主题由真实 `theme.js` 的 `applyThemePreference(value, { cache: false })` 应用。URL 初始化并同步 `variant` / `theme` / 可选 `compare=1`；`history.replaceState` 有异常保护。源码应由 Vite 打开，不支持直接双击 HTML 加载模块。
- 方案 C 已接入产品源码；本次未构建、启动服务或更新 `preview.html`，已有导出和 PNG 可能仍是旧版。浏览器视觉与点击 / Enter 交互验收由父流程完成。
