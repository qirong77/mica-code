# Floating Window

macOS 桌面端按 **⌘`** 显示或隐藏同一个浏览器浮窗，再次显示时保留页面。新建窗口默认显示欢迎页，主页分开展示收藏和最近访问的站点，可点击站点快速跳转，也可以用星标收藏 / 取消收藏；当前网页和主页条目都支持星标。站点卡片优先使用页面实际解析出的 favicon，重启后从已保存的安全图标地址恢复，找不到时再尝试站点自己的 `favicon.ico`，最后回退到通用图标。工具栏的欢迎页按钮可随时返回。顶部输入域名（自动补 `https://`）或完整 HTTP(S) 网址，回车导航；支持后退、前进、刷新。网页在独立的原生网页视图中显示，不修改 hosts、不启动外部浏览器。快捷键被其他应用占用时，浮窗提示注册失败并提供重试。浏览器宿主没有原生网页视图时显示空态。

只允许 HTTP(S)，不接受带用户名或密码的网址。插件最多保存最近 20 个去重站点和 20 个收藏站点；收藏按最近操作排列。仅持久化站点根地址，不保存路径、查询和片段，因为它们可能包含凭证。新建窗口不自动打开最近网址；当前窗口隐藏后再次显示仍保留完整当前页面。网站本身的浏览数据由宿主隔离上下文管理，不在插件数据中。

`launcher.js` 处理 `recent`、`remember` 和 `favorite`，通过 `ctx.readData()` / `ctx.writeData(value, { expectedVersion })` 在版本冲突时重读重试，保留其他键；`recent` 返回的 `favicons` 只保存去掉 query / fragment 的 HTTP(S) 地址，不执行网络导航。前端使用通用 `api.launcher.web.state/navigate/home/back/forward/reload/subscribe`。关闭/停用由宿主管理，订阅在组件卸载时解除。

验证（不构建、不启动桌面实例）：

```sh
bunx vitest run --project unit plugins/floatingwindow/launcher.test.ts plugins/floatingwindow/desktop.test.ts
```
