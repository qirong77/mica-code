# Browser Cookie Sync

把**本机 Chrome** 与 **Mica 受控浏览器**（`persist:mica-browser` 分区）之间的 cookie 双向同步。

装上之后在 Chrome 里登过的站点，Mica 的浏览器直接就是登录态；反过来，在 Mica 浏览器里
新登的会话也能写回真实 Chrome。默认**全量 + 双向**，两边都改过的条目**不动**，列在
「冲突」里让人选一边。

## 前提（缺一样就跑不起来，配置页的「运行条件」会显示状态）

| 条件 | 为什么 | 怎么给 |
| --- | --- | --- |
| 全磁盘访问 | Chrome 的 cookie 库在 `~/Library/Application Support/Google/Chrome/` 下，别的应用读它一律 `Operation not permitted` | 系统设置 → 隐私与安全性 → **全磁盘访问** 勾上 Mica，然后重启应用 |
| 钥匙串授权 | 值是用「Chrome Safe Storage」这条钥匙串项派生的密钥加密的 | 第一次同步时弹一次授权，点「允许」（想让以后不再问：钥匙串访问 → 这项 → 访问控制 → 始终允许） |
| 受控浏览器 | 另一侧是桌面应用主进程里的浏览器分区，插件通过 `MICA_BROWSER_URL` 访问它 | 在桌面应用里用（CLI / TUI 没有受控浏览器） |

只支持 macOS + Chromium 系浏览器（Chrome / Beta / Dev / Canary）。它们的 cookie 库格式、
`v10` 加密与钥匙串项是同一套，差别只有目录名与进程名。

## 怎么用

- **面板**：输入框上方的「Cookie 同步」→ 状态、方向开关、冲突表（每条两个按钮：以 Chrome
  为准 / 以 Mica 为准）。「试算」只算差异不写任何一侧。
- **配置页**：Settings → Plugins → Browser Cookie Sync，两个按钮「立即同步」「试算」，
  「运行条件」显示全磁盘访问是否已开。
- **自动同步**：设置里的「自动同步间隔」（分钟），默认 0 = 只手动。

## 冲突是怎么判的

cookie 上没有修改时间，只比两侧当前值回答不了「是谁变的」。所以基线文件
（`$MICA_HOME/plugin-data/browser-cookie-sync/state.json`）记的是**上一次同步完两侧各自的
内容指纹**——只存 `sha256(...)` 的前 16 位，**不存 cookie 值**。每条 cookie 于是只有四种情况：

| 情况 | 处理 |
| --- | --- |
| 两侧一样 | 不动 |
| 只有一侧变了（另一侧仍等于基线） | 变的那侧赢，写过去 |
| 两侧都变了、且不一样 | **冲突**：谁都不写，面板里列出来让人选 |
| 一侧有、另一侧没有，而基线里两侧都有 | 判定为「那一侧删了/登出了」→ 另一侧也删 |

首次同步没有基线，两侧的差异一律算冲突：那种差异说明不了方向，只能人来定。选边之后那一条
就进了基线，下一轮不再问。

## Chrome 正开着的时候

Chrome 把 cookie 常驻在内存里、只把变化写回库，所以：

- **读**没问题，但 Chrome 刚登录的站点可能要过一会儿才出现在库里；
- **写**进去要重启 Chrome 才生效，还可能被它自己的下一次提交盖掉。

默认策略是「Chrome 在运行 → 这一轮只做 Chrome → Mica 方向」，并在状态里写清原因；
设置里打开「Chrome 开着也写」才会写，写完会提示需要重启。插件**不会**替你退出浏览器。

## 数据放在哪

```
$MICA_HOME/plugin-data/browser-cookie-sync/
  state.json   基线（每条 cookie 两侧的内容指纹）+ 上一次结果
  data.json    配置页「运行状态」那几行、冲突清单、上次同步的注意事项
```

`state.json` 与面板动作、后台那一轮共用一把跨进程锁（`state.json.lock` 目录）并且先写临时
文件再 rename：两个入口同时点也不会互相覆盖，页面随时读也不会读到半份 JSON。

## 技术要点（改代码前看这里）

- **Chrome 侧自己干**：系统 `sqlite3` CLI 读写它的库（不引 native 依赖：`node:sqlite` 在
  Node 22 要实验开关、`bun:sqlite` 在 node 下没有），钥匙串经 `security find-generic-password`
  取 `Chrome Safe Storage`，再用 PBKDF2-HMAC-SHA1（`saltysalt` / 1003 轮 / 16 字节）派生
  AES-128-CBC 密钥；明文是 `SHA256(host_key)` + 值的形态（`v10` 前缀）。实现见 `chrome/`。
- **受控浏览器侧走 HTTP**：`MICA_BROWSER_URL` 上的 `GET /browser/cookies/all`、
  `POST /browser/cookies/set`、`POST /browser/cookies/remove`（这三个端点是本插件需要的
  能力，端点目录在 `apps/desktop/src/main/browser/browser-docs.js`）。
- **只碰确有的列**：写库前先 `PRAGMA table_info(cookies)`，Chrome 升级加列不会让整批失败；
  更新时不动 `creation_utc` / `priority` / `source_*`（那些属于 Chrome）。
- **不引 private 状态**：面板刷新只读本地文件（`state.json` / `data.json` / 设置），不探测
  Chrome、不问钥匙串——探测只在真正同步的那一下做，结果顺手缓存进 `data.json`（配置文件
  清单就是缓存的那份）。

## 排查

| 现象 | 看这里 |
| --- | --- |
| 「读不到 Chrome 的数据目录（Operation not permitted）」 | 全磁盘访问没给，或给了但没重启 Mica |
| 「钥匙串里没有 Chrome Safe Storage」 | 这个浏览器还没在**这台机器、这个用户**下存过任何登录态 |
| 「钥匙串访问被拒绝」 | 授权弹窗点了拒绝；到「钥匙串访问」里改这一项的访问控制，或重试一次 |
| 同步成功但 Chrome 里没变化 | Chrome 开着：重启它（或打开「Chrome 开着也写」） |
| 面板里一堆冲突 | 同一个站点在两边是两个账号。逐条选边，或关掉某个方向 |

插件日志：`~/Library/Logs/mica/plugin-browser-cookie-sync-*.jsonl`。
