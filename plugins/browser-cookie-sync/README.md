# Browser Cookie Sync

让 Chrome 和 Mica 受控浏览器（`persist:mica-browser`）自动双向同步 cookie。无需全磁盘访问、钥匙串授权，也没有「立即同步」按钮。

## 安装

1. 在 Mica 的 Settings → Plugins → Browser Cookie Sync 点击「安装 Chrome 扩展」，得到扩展目录与连接口令（扩展写到 `$MICA_HOME/plugin-data/browser-cookie-sync/extension-v2/`）。
2. 在 Chrome 打开 `chrome://extensions`，打开开发者模式，点击「加载已解压的扩展程序」，选择上一步给出的绝对目录。打开扩展的「选项」，粘贴口令并保存。
3. 保持 Mica 桌面端运行。插件服务只监听本机 `127.0.0.1:19387`，不对外网提供服务。连接口令保存在 `$MICA_HOME/plugin-data/browser-cookie-sync/token`（0600），请不要发给网站或他人。

## 同步方式

- Chrome 的 `chrome.cookies.onChanged` 只推送发生变化的条目，服务收到后写入 Mica 受控浏览器。
- Mica 的 Electron `cookies.changed` 向独立事件流发出 `(domain, path, name)` 身份键；服务按域增量回读该条 cookie 的最新状态，再推给 Chrome 扩展，避免把排队中的旧删除事件覆盖到新登录态。
- 扩展的 MV3 service worker 可能被 Chrome 挂起。唤醒/重连时拉一次完整快照，根据扩展本地存储的内容指纹补漏；每分钟的 alarm 只负责重新连接，不每分钟扫描两个浏览器。第一次连接时只复制单边存在的 cookie，同一身份键两边都已有但值不同则不覆盖。离线期间两边都改变且不同的条目也不覆盖。
- Chrome 扩展抑制自身写入产生的回声，服务按顺序处理写入、事件和快照，并用递增版本防止旧事件覆盖重连后的新值。只同步默认 Chrome cookie store，不同步分区 cookie（CHIPS）和其它 Chrome Profile。服务的 HTTP 请求必须带扩展保存的 Bearer 口令；网页 Origin 被拒绝，且不返回 CORS 头。

卸载扩展或在 Mica 中停用该插件会停止同步。服务跟随 Mica 会话宿主运行、退出时关闭；宿主替换时最多等 15 秒接管。Chrome 扩展离线期间可继续正常浏览，重连后会补漏。

服务内的每条事件不记录 cookie 值；首次或重连的全量快照只在本地内存中处理，扩展的 `chrome.storage.local` 只存指纹。`extension/README.md` 记录扩展的独立安装方式及 MV3 限制。

旧版直接读写 Chrome 数据库、手动同步的形态不再支持。升级迁移把旧设置与状态改名为同目录的 `*.legacy-v1.json` 归档，不删除原设置内容。

扩展资源内嵌供单二进制使用；修改 `extension/` 后运行 `bun scripts/generate-browser-cookie-extension-sources.mjs` 更新 `extensionSources.ts`。
