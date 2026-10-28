# Mobile Relay

手机经一台公网中转机打开这台机器上的 Mica：看到的是真实的桌面端界面（同一份会话、同样的流式输出），
不是另做的一套精简页。

## 形态

```
手机 ──HTTPS/SSE──> 中转机 ──短轮询──> 这台机器 ──回环──> Mica 运行时
```

- **中转机**（`relay/relay.mjs`）托管 `apps/desktop/out/renderer` 的构建产物，并把 `/api/invoke`、
  `/api/events`、`/api/env`、`/api/image` 实现成与桌面运行时相同的形状，所以页面一行不用改。
- **这台机器**（`agent/bridge.mjs`）只做出站短轮询：没有监听端口、没有常驻连接、不转发端口，
  只按白名单把语义 channel 转给 `127.0.0.1:8787`。
- 桥进程由插件通过 `ctx.background` 监管：**停用插件就杀掉它**，不会出现「插件关了还在外联」。

## 安全与「别太显眼」

| 措施 | 说明 |
| --- | --- |
| TLS | nginx 终结 TLS，Let's Encrypt 证书（`sslip.io` 免费域名即可），浏览器绿锁 |
| 应用层加密 | 轮询体 AES-256-GCM，密钥由 token 经 HKDF-SHA256 派生；中转机看不到明文 |
| 随机化 | 每次间隔在基准上抖动 ±N%（默认 35%），不再是固定节拍 |
| 时段门禁 | `activeHours` / `activeDays`，窗口外**完全停止外联**并以本地时区算出恢复时间 |
| 按需推送 | 没有手机在看时不攒事件；静止时每轮上行 39 字节（结果未变的只回 hash） |
| 白名单 | 只放行语义 channel；终端、文件写入、`git:stage`、`config-web:invoke` 一律拒绝 |

## 安装

1. 中转机：`node deploy.mjs --host <域名> --token <口令>`（默认经 `RELAY_ADMIN` 提供的
   HTTP 管理端点推送文件并重启 systemd；有 SSH 时直接拷 `relay/` 亦可）。
2. 配置页 → 插件 → Mobile Relay：填「中转地址」与「访问口令」。
3. 手机打开 `<中转地址>/?t=<口令>`。

桥脚本首次由插件落盘到 `$MICA_HOME/plugin-data/mobile-relay/bridge.mjs`，需要系统里有 `node`
（或用 `MICA_BRIDGE_NODE` 指定）。

## 设置项

| 键 | 说明 |
| --- | --- |
| `enabled` | 总开关；关掉会立刻杀掉桥进程 |
| `relayUrl` | 中转机地址，如 `https://xxx.sslip.io` |
| `token` | 访问口令，同时用于派生加密密钥 |
| `activeHours` | `08:30-12:00,13:30-18:30`；留空表示全天；`end < start` 视为跨午夜 |
| `activeDays` | `1-5` 表示周一到周五（0 是周日）；留空表示每天 |
| `jitter` | 间隔抖动百分比 |

## 已知边界

- 需要桌面端在运行（桥轮询的是本机 `127.0.0.1:8787`）。
- 用户插件（`$MICA_HOME/plugins`）的卡片在手机上渲染不出：页面是构建期打的包。
- 手机端不提供终端与文件编辑。

## 改桥脚本

`agent/bridge.mjs` 是唯一源码；改完跑 `bun scripts/generate-mobile-relay-sources.mjs`
重新生成 `bridgeSource.ts`（随包运行的是内嵌那份）。
