# Floating Window

macOS 桌面端按 **⌘`** 显示或隐藏同一个浏览器浮窗，再次显示时保留页面。新建窗口默认显示欢迎页，主页分开展示收藏和最近访问的地址，可点击条目快速跳转，也可以用星标收藏 / 取消收藏；当前网页和主页条目都支持星标。工具栏的欢迎页按钮可随时返回，拖动按钮可移动窗口。顶部输入域名（自动补 `https://`）或完整 HTTP(S) 网址，回车导航；支持后退、前进。网页在独立的原生网页视图中显示，不修改 hosts、不启动外部浏览器。快捷键被其他应用占用时，浮窗提示注册失败并提供重试。浏览器宿主没有原生网页视图时显示空态。

## 最近访问什么时候记账

访问一个地址就有记录，不依赖外壳随后推来什么状态：回车 / 点条目走 `open()` 时立刻 `remember` 一次，回到主页时再读一遍列表，窗口重新获得焦点或从隐藏恢复时也读一遍。外壳的网页状态推送（`subscribe`）补上页面内部跳转、重定向和 favicon 的更新——它要是慢了或者没到，这次访问照样进列表，欢迎页也不会停在第一次挂载时的样子。

记的是**完整地址**：路径、查询和片段都保留，从最近访问点回一条深链接落到的就是当时那个页面。站点跳转（`http→https`、补 `www`、短链展开）不会留下两条：`open()` 记下用户输入的地址后留一个种子，这次导航落地到别的地址时前端把种子作为 `replaces` 交给 `remember`，后端把它从列表里换掉；种子在一次导航结束（推送 `loading: false`）或换了导航方向（前进 / 后退 / 回主页）时作废，所以之后点链接进的页面不会顶掉上一条。

回到主页必须重新读：原生网页视图被收起后欢迎页才露出来，这一步没有状态推送也不能假设自己是最新的。`remember` / `favorite` 写入前重读、带 `expectedVersion` 比较，并在版本冲突时退避重试（15ms 起递增），因为别的窗口、中转机或数据迁移可能正握着同一个 `data.json` 的锁；瞬时冲突不该让这次访问无声消失。真的写不进去时卡片上方会显示可读的失败原因，而不是假装保存成功。

## 图标

条目优先用页面解析出的 favicon，没有就试站点根目录的 `favicon.ico`，都没有才回退到通用图标。浮窗页面本身只允许 `img-src 'self' data: file:`，远端图标地址在渲染层一定加载不出来，所以由外壳取回字节并内联：`api.launcher.web.favicon(url)` 返回 `{ dataUrl }`（只认图片类型、上限 128 KiB、4s 超时，成功结果按 URL 缓存在启动器记录里），页面只画这个 `data:` URL。

图标按站点（origin）存一份，随最近访问 / 收藏一起保存：页面自己用 `<link rel="icon" href="data:image/…">` 声明图标时（单文件站点、不少 SPA 都是这样，且它们通常没有 `/favicon.ico`），外壳把这条 `data:` URL 直接透传，插件按站点存下它，于是重启后不用回到那个页面也有图标。远端图标仍然只存 HTTP(S) 地址，不存图片字节。

## 边界

只允许 HTTP(S)，不接受带用户名或密码的网址。插件最多保存最近 20 条去重地址和 20 条收藏地址；收藏按最近操作排列。保存的是完整地址，所以查询串里的 token 之类也会落进 `plugin-data/floatingwindow/data.json`（本机文件，不上传）。新建窗口不自动打开最近网址；当前窗口隐藏后再次显示仍保留完整当前页面。网站本身的浏览数据由宿主隔离上下文管理，不在插件数据中。

`launcher.js` 处理 `recent`、`remember` 和 `favorite`，通过 `ctx.readData()` / `ctx.writeData(value, { expectedVersion })` 在版本冲突时重读重试，保留其他键；`recent` 返回的 `favicons` 按站点 origin 存一份 HTTP(S) 图标地址（保留 query、去掉 fragment），只为最近访问和收藏里还在的站点保留，不执行网络导航。前端使用通用 `api.launcher.web.state/navigate/home/back/forward/subscribe`，加上外壳内联图标用的 `favicon(url)`。关闭/停用由宿主管理，订阅在组件卸载时解除。

验证（不构建、不启动桌面实例）：

```sh
bunx vitest run --project unit plugins/floatingwindow/launcher.test.ts plugins/floatingwindow/desktop.test.ts
cd apps/desktop && bun test src/main/launcher-favicon.test.js
```
