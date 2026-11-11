# Notebook 正式页面隔离探针

在独立 Vite 页面直接挂载 `plugins/notebook/desktop.jsx` 的正式 `NotebookPage`。Notebook 的布局、样式、编辑桥和 `/editor/` 运行时全部取自生产源码；探针只提供 `ArcoProvider`、与 `PluginPage` 一致的 `mica-config-ui is-embed is-fill` 内容壳，以及顶部 40px 主题辅助条。

## 启动

```sh
cd apps/desktop
npx vite --config .probe/notebook-workbench/vite.config.mjs
```

访问 `http://127.0.0.1:5287/`，默认浅色。辅助条可即时切换项目注册表中的六套主题，也可以用 `/?theme=dark`、`/?theme=mocha`、`/?theme=latte`、`/?theme=tokyo-night`、`/?theme=tokyo-night-light` 指定主题。主题只更新本页 DOM 和 URL，不写用户偏好。

需要已安装桌面端与 `packages/mica-editor/runtime` 的开发依赖。第一次请求 `/editor/` 时调用共享 `packages/mica-editor/build.mjs`，输出到仓库的 `temp/notebook-workbench-runtime/`；后续运行时源码或共享 Arco CSS 改动会使这份隔离产物失效，并在下次请求时重建。不会覆盖安装产物，也不会触发桌面端、CLI 或配置页的正式构建。第三方编辑器依赖沿用生产运行时的 CDN 加载方式。

## 数据与边界

复用 `../notebook-design/fixture.ts` 的五篇丰富笔记，按 `folder` 生成符合正式 `model.ts` 的文件夹和笔记索引，正文单独存放在内存 Map 中。默认打开主示例“把灵感，写成下一步”。图片、表格、代码、Mermaid、任务与公式都由真实编辑器处理。

内存宿主实现索引和文档的 CAS：每个已存在资源都有不透明字符串版本，新文档为 `null`；每次写入必须显式携带匹配的 `expectedVersion`，成功后返回新版本。读取、保存及检查接口都返回独立副本。失败和冲突不改内容或版本。所有更改仅在当前页面内存中，刷新恢复样例；不接触真实 `MICA_HOME`、文件系统、宿主 RPC 或浏览器持久化存储。

`probe.css` 只负责页面高度链、内容壳和辅助条，不包含 Notebook 排版规则。服务只返回共享构建生成的运行时文件，不注入设计预览 CSS 或 `design-bridge.js`。`/editor` 和 `/editor/` 支持 GET / HEAD，其他方法返回 405；请求段解码校验和 realpath 边界校验阻止路径穿越。

## 浏览器复核接口

仅此探针暴露 `window.__notebookWorkbench`，正式页面不新增调试接口：

```js
const probe = window.__notebookWorkbench

// 当前内存索引、正文、各资源版本、成功保存次数、写入记录和关闭记录的独立快照。
probe.state
probe.documents
probe.saveCount
probe.writes

// 默认使用正式页面最近读取的笔记；也可显式指定 fixture 中的 id。
probe.snapshot() // 已保存的 NotebookDocument；不主动 flush 编辑器
probe.snapshot('idea-to-delivery')
await probe.read('idea-to-delivery') // { ok: true, value, version }
await probe.readIndex() // { ok: true, value: NotebookIndex, version }

// 只影响之后的写请求；已存正文、版本和成功保存次数保持原值。
probe.failWrites = true
probe.failWrites = false

// 按注册顺序调用真实 NotebookPage 的 page.beforeClose 处理器。
// 会执行真实 bridge.flush / 保存 / 索引刷新，返回是否允许关闭。
await probe.close()
```

`close()` 只验证生产页面的关闭守卫，保留页面供继续检查，不导航或卸载页面。`state.saveCount` / `saveCount` 统计成功的索引与文档写入总数，`state.documentSaveCount` 只统计成功的正文写入；`writes` 记录每次尝试的资源、文档 id、期望版本、原版本、结果、新版本和请求正文，包含失败与冲突。

可复核：编辑后等待正式页面自动保存并读取 `snapshot(id)`；切换笔记后核对上一份正文；开启 `failWrites` 后继续编辑并调用 `close()`，应保留草稿并拒绝离开，关闭失败开关后重试。`snapshot()` 只反映宿主已接收的保存内容，待保存草稿仍由正式页面管理。
