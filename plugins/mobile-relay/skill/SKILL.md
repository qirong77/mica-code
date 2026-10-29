---
name: mobile-relay-setup
description: 让手机经一台公网中转机打开这台机器上的 Mica（真实界面、同一份会话与流式输出）。做的是部署那台中转机、把本机接上去，并验证手机真能打开；不建常驻隧道、不开入站端口，本机只做出站短轮询。
when_to_use: Use when the user wants to open this machine's Mica from a phone outside the LAN — e.g. "手机怎么访问", "在外网用手机看这台机器", "帮我配一下 mobile relay", "中转机怎么部署", "手机打开 Mica 的链接是多少". Also use for troubleshooting it (does not connect / blank page / wrong token).
argument-hint: [中转机的 SSH 目标，如 root@1.2.3.4]
---

# mobile-relay

把「这台机器上跑的 Mica」搬到手机上：中转机托管页面并开一个窄 API，本机只做出站短轮询。

```
手机 ──HTTPS/SSE──> 中转机 ──短轮询──> 这台机器 ──回环──> Mica 运行时（127.0.0.1:8787）
```

**插件本身只负责本机那座桥**（进程监管、设置、状态、`mobile_relay` 工具）。中转机的部署
不预置在插件里：脚本在仓库里，由这个 skill 现场取用，缺什么就装什么、要构建就构建。
不要试图从已安装的 App 里抠构建产物——打包后它在 `app.asar` 内，只有 Electron 读得到。

脚本地址（公开仓库，`main` 分支）：

```
https://github.com/qirong77/mica-code
plugins/mobile-relay/setup.mjs
plugins/mobile-relay/relay/{relay.mjs,nginx-site.conf,mobile-relay.service}
```

## 先确认四件事

1. **本机是桌面端在跑**（桥调 `127.0.0.1:8787`）。`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/health` 应为 200。
2. **中转机**：一台有公网 IP 的 Linux，能 `ssh` 免密登录，有 `node ≥ 18` 与 `nginx`。
   缺 certbot 可以装：`apt install -y certbot python3-certbot-nginx`。
3. **仓库**：本机没有仓库就 `git clone --depth 1 https://github.com/qirong77/mica-code`，
   后面都在这个 clone 里操作（部署脚本要读 `apps/desktop/out/renderer`）。
4. **有没有域名**：没有就用 `sslip.io` 自动域名（`1-2-3-4.sslip.io` 解析到那个 IP），
   证书由 certbot 自动申请。不要用自签证书——手机浏览器会直接白屏。

## 部署

在仓库根目录：

```bash
# 需要页面产物时先构建（这是唯一需要构建的东西）
cd apps/desktop && npm install && npx electron-vite build && cd ../..

node plugins/mobile-relay/setup.mjs --host root@<公网IP>
```

一条命令做完：生成口令 → 打包上传（`relay.mjs` + 页面产物）→ 写 systemd →
写 nginx 站点 → 申请 Let's Encrypt 证书 → 起服务 → 把地址与口令写进本机插件设置。

- 已有域名：加 `--domain mica.example.com`
- 先看它要做什么、不碰服务器：加 `--dry-run`
- 内网调试、不要证书：加 `--no-cert`（手机端会开不了，只用于验证链路）

`setup.mjs` 会自己找 `apps/desktop/out/renderer`；指向别处的构建产物用 `--renderer <dir>`。

### 中转机已经部署过（第二台以后的电脑）

**先看用户想要什么形态**：插件设置里有一个「注册到中转机」按钮，只填中转地址就能自助拿到
口令与手机链接（中转机按机器标识认领，重复注册是同一个口令）。用户能自己点就让他点，
不需要 SSH，也不需要 agent 跑命令。

只有在需要「agent 代劳」时才走命令行。**不要重新完整部署**：同一条命令即可，`setup.mjs`
会先看 `systemctl is-active mobile-relay`：

```bash
node plugins/mobile-relay/setup.mjs --host root@<同一台中转机> --ssh-port 2222
```

已部署时它只登记这台机器（往 `agents.json` 追加一条，~20 秒），不传页面、不碰 nginx、
不重签证书、不重启服务——relay 会热加载清单，已经连着的手机不受影响。

确认接入结果：

```bash
T=$(node -e "console.log(require(process.env.HOME+'/.mica/plugin-settings/mobile-relay.json').token)")
curl -s "https://<域名>/api/health?t=$T"   # label 应是你这台机器的名字
```

只有要升级 relay 本身时才用 `--redeploy` 走完整部署。

## 验证（不要跳）

```bash
# 1. 中转机起来了
curl -s https://<域名>/api/health
# → {"ok":true,"agentOnline":true,...}

# 2. 本机接上了（agentOnline 变 true 通常要等一个轮询周期）
sleep 20 && curl -s https://<域名>/api/health

# 3. 手机上真能打开
#    打开 https://<域名>/?t=<口令>，应看到会话列表与移动端布局
```

`agentOnline: false` 说明桥没跑或没连上：让模型调用 `mobile_relay action=doctor` 逐项排查。

## 日常

- **看状态 / 拿链接**：设置 → 插件 → Mobile Relay 的「手机访问」按钮打开面板（会话设置 → 插件里也有「打开面板」）；或 `mobile_relay action=link`。
- **临时关掉**：配置页 → 插件 → Mobile Relay 的「启用桥」，或停用插件。
  桥进程由 `ctx.background` 监管，关掉就真的杀了，不会留着后台还在外联。
- **换中转机**：重跑一次 `setup.mjs`，旧口令作废。

## 排查

| 现象 | 原因 |
| --- | --- |
| 手机白屏 | 证书不可信（自签）或域名解析不对 → 用 `sslip.io` 或真域名重跑 |
| `agentOnline: false` | 桥没跑（`mobile_relay doctor`）、本机桌面端没开、或地址不是 `https://` |
| 手机能开但没会话 | 运行时没在跑；或口令对不上（中转机 401） |
| `setup.mjs` 说找不到 renderer | 没构建：`cd apps/desktop && npm install && npx electron-vite build` |
| certbot 失败 | 80 端口没通 / 域名没解析到这台机器；`--no-cert` 先验证链路 |

## 边界

- 手机端不提供终端与文件编辑：`terminal:*`、`files:write*`、`git:stage`、`config-web:invoke`
  在桥的白名单里就是拒的。
- 需要桌面端在运行，关掉就没有会话可看。
- 用户插件（`$MICA_HOME/plugins`）的卡片在手机上渲染不出——页面是构建期打的包。
