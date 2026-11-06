# Browser Cookie Sync

让 Chrome 和 Mica 受控浏览器（`persist:mica-browser`）自动双向同步 cookie。无需全磁盘访问、钥匙串授权；后台自动同步，不在对话区显示按钮或面板。安装入口在插件设置页，连接状态、口令、立即同步与重连在扩展自己的弹窗里。

## 安装

1. 在 Mica 的 Settings → Plugins → Browser Cookie Sync 点击「安装 Chrome 扩展」，得到扩展目录与连接口令（扩展写到 `$MICA_HOME/plugin-data/browser-cookie-sync/extension-v2/`）。
2. 在 Chrome 打开 `chrome://extensions`，打开开发者模式，点击「加载已解压的扩展程序」，选择上一步给出的绝对目录。
3. 把扩展的「网站访问权限」设为「在所有网站上」，否则 Chrome 不给它读写 cookie。然后点扩展图标，在弹窗里粘贴口令并保存。弹窗显示连接状态、扩展版本与上次更新时间和「立即同步」「重新连接」两个按钮。
4. 保持 Mica 桌面端运行。插件服务只监听本机 `127.0.0.1:19387`，不对外网提供服务。连接口令保存在 `$MICA_HOME/plugin-data/browser-cookie-sync/token`（0600），请不要发给网站或他人。

## 同步方式

- Chrome 的 `chrome.cookies.onChanged` 只推送发生变化的条目，服务收到后写入 Mica 受控浏览器。
- Mica 的 Electron `cookies.changed` 向独立事件流发出 `(domain, path, name)` 身份键；服务按域增量回读该条 cookie 的最新状态，再推给 Chrome 扩展，避免把排队中的旧删除事件覆盖到新登录态。
- 扩展的 MV3 service worker 可能被 Chrome 挂起。唤醒/重连时拉一次完整快照，根据扩展本地存储的内容指纹补漏；每分钟的 alarm 只负责重新连接，不每分钟扫描两个浏览器。第一次连接时只复制单边存在的 cookie，同一身份键两边都已有但值不同则不覆盖。离线期间两边都改变且不同的条目也不覆盖。
- 「立即同步」按需跑一次完整比对，不受每分钟 alarm 的节奏限制，并回报统计：比对多少条、写入 Chrome / 写入 Mica 各多少条、因冲突跳过多少条、失败多少条。同一轮里单条写失败只记一条失败，不中断其余条目。
- Chrome 扩展抑制自身写入产生的回声，服务按顺序处理写入、事件和快照，并用递增版本防止旧事件覆盖重连后的新值。只同步默认 Chrome cookie store，不同步分区 cookie（CHIPS）和其它 Chrome Profile。服务的 HTTP 请求必须带扩展保存的 Bearer 口令；网页 Origin 被拒绝，且不返回 CORS 头。

卸载扩展或在 Mica 中停用该插件会停止同步。服务跟随 Mica 会话宿主运行、退出时关闭；宿主替换时最多等 15 秒接管。Chrome 扩展离线期间可继续正常浏览，重连后会补漏。

服务内的每条事件不记录 cookie 值；首次或重连的全量快照只在本地内存中处理，扩展的 `chrome.storage.local` 只存指纹。`extension/README.md` 记录扩展的独立安装方式及 MV3 限制。

旧版直接读写 Chrome 数据库、手动同步的形态不再支持。升级迁移把旧设置与状态改名为同目录的 `*.legacy-v1.json` 归档，不删除原设置内容。

## 自动更新

扩展资源内嵌在二进制里供单文件分发使用。插件每次加载（以及点「安装 Chrome 扩展」时）都会把内嵌资源同步到 `$MICA_HOME/plugin-data/browser-cookie-sync/extension-v2/`：只有内容真的变了才重写，`extension-meta.json` 里的 `updatedAt` 也只在那一刻推进——它表示这份扩展最近一次被更新是什么时候，不是每次启动的时间。Mica 升级后用户不需要删掉扩展重装。

Chrome 不会自己重读已加载的解压扩展，所以扩展每分钟（跟着重连 alarm）请求一次 `/health`，比对服务端回报的 `extension.fingerprint` 与自己 `version.json` 里的指纹：不一致就调用 `chrome.runtime.reload()` 重载自己。同一个目标指纹重载后仍对不上（例如加载的是手工拷贝的目录）时退避时间翻倍，最长一天一次，不会变成反复重载。运行中的 Mica 还没升级、`/health` 里没有 `extension` 字段时，扩展只记录、不重载。

弹窗常驻一行 `扩展 v<版本> · 上次更新 <时间>`；指纹不一致时那行变成「磁盘上是 vX」，并给一个「立即重载」按钮。

修改 `extension/` 后运行 `bun scripts/generate-browser-cookie-extension-sources.mjs`：它同时产出 `extension/version.json`（版本 + 内容指纹）与 `extensionSources.ts`。改了扩展却不重新生成，`index.test.ts` 的「内嵌资源与 `extension/` 一致」会直接失败。
