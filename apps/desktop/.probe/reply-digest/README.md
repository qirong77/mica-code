# 长回复摘要 · 触发条件探针

用固定回复和摘要样例展示插件的阈值判定，不连接后端或模型，不读写真实会话。摘要容器直接复用正式 `src/renderer/src/DigestNotice.jsx`，与产品的方案 C 一致：真实 Arco Collapse 默认展开，点击标题或聚焦后按 Enter 收起 / 展开，不影响原回复。

## 运行

在仓库根目录执行：

```sh
bunx --no-install vite --config apps/desktop/.probe/reply-digest/vite.config.mjs
```

打开 `http://127.0.0.1:5232/`。右侧可切换长回复、短回复和行数过线样例，也可手动编辑文本查看触发判定。

## 实现边界

- 阈值和裁剪调用插件自身 `digest.ts` 的 `shouldDigest` / `digestInput` / `cleanSummary`，摘要正文是固定样例，不会随输入重新生成。
- 摘要容器、元信息、聊天字号、1.65 行高和窄屏换行由正式组件与 `app.css` 负责，不复制旧卡片结构，也不加探针专用摘要皮肤。
- 页面加载共享 `ArcoProvider` 和主题映射；对话正文保留本探针的轻量 Markdown 渲染器，不加载整个 ChatView。
- 本次未启动服务、构建、更新导出 HTML 或截图；交互和主题视觉验收尚需在源码探针中完成。
