# Mica Sync 开发与部署交接文档

> 本文档总结 Mica Sync（远程会话同步）功能的本次改动、架构、协议、部署步骤与后续开发注意事项，供后续模型/开发者基于此继续工作。代码事实以源码为准，本文件与 `AGENT.md` 的「Mica Sync 远程会话同步」章节保持一致。

## 1. 本次改动总结

本次工作区改动（尚未提交）为 mica-code 增加 **Mica Sync** 远程会话同步能力：所有机器上的 Mica 会话镜像到一台中心服务器，浏览器实时查看并可回源续聊。

| 改动                              | 内容                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 新增 `packages/mica-sync-server/` | 中心聚合服务。零第三方依赖（仅 Node 内置模块）、单文件可部署、JSON 文件存储、REST + SSE、长轮询指令下发            |
| 新增 `packages/mica-sync-web/`    | Web 控制台（React + Vite），查看机器/会话并远程续聊                                                                |
| 新增 `src/daemon/`                | `mica daemon` 常驻进程：镜像本地会话 + 执行远程续聊 turn                                                           |
| 新增 Config Web Sync 页面         | `packages/mica-config-web` 侧边栏新增 `Sync` 菜单，配置服务器地址与机器名                                          |
| CLI 变更                          | `src/cli/args.ts` 新增 `mica daemon [--server <url>] [--name <name>]`；`src/index.ts` 分派到 `src/daemon/index.js` |
| 构建脚本                          | `package.json` 新增 `build:sync-web`、`build:sync-server`                                                          |
| 文档同步                          | `AGENT.md`（新增 Mica Sync 章节）、`README.md`、`packages/README.md`、两个新 package 的 README                     |

## 2. 整体架构与数据流

```text
┌────────────┐  出站(HTTP)   ┌────────────────────┐    ┌──────────────┐
│ 本地机器    │ ────────────▶ │  mica-sync-server   │◀───│ 浏览器 Web   │
│ mica daemon│ ◀──────────── │  (中心服务器)        │ ──▶│ mica-sync-web│
└────────────┘  长轮询指令    └────────────────────┘    └──────────────┘
```

- **上行（会话镜像）**：daemon 监听本地 `~/.mica/sessions`，会话文件变化（`SessionWatcher`）时把快照推送到 `/daemon/session`；turn 过程中产生的事件（`user_input`/`thinking`/`text_delta`/`tool_call`/…）按 40ms 批次推送到 `/daemon/events`。
- **下行（远程续聊）**：Web 端 POST `/api/machines/:id/sessions/:sid/run` → 服务器给该机器入队 `run` 指令 → daemon 的长轮询 `/daemon/poll`（服务器最多 hold 25s）取回指令 → `CommandExecutor` 复用 `AgentRuntime` + `SessionController` 在本地执行该会话的下一轮 → 事件实时回流到 Web（SSE）。
- **NAT 友好**：daemon 全部为主动出站连接，机器不需要开放入站端口。

## 3. 核心模块

### 3.1 `packages/mica-sync-server`（中心服务器）

- `src/main.ts`：入口，解析 `--port`（默认 5560）/`--data-dir`（默认 ./data）/`--web-dir`，也支持 `MICA_SYNC_PORT`/`MICA_SYNC_DATA_DIR`/`MICA_SYNC_WEB_DIR` 环境变量。
- `src/server.ts`：HTTP 路由 + 静态托管。关键常量：`MACHINE_ONLINE_MS = 90_000`（在线判定）、`POLL_HOLD_MS = 25_000`、`SSE_HEARTBEAT_MS = 15_000`。
- `src/store.ts`：JSON 文件存储。`data/machines.json`、`data/sessions/<machineId>/<sessionId>.json`。
- `src/events.ts`：`EventHub`，按 machine+session 订阅，每会话 500 条事件内存缓冲，SSE 断线用 `since` 序号补拉。

### 3.2 `src/daemon`（机器端）

- `config.ts`：`~/.mica/sync.json`（跟随 `MICA_HOME`）读写，字段 `serverUrl`/`machineId`/`name`。
- `ensureDaemonRunning.ts`：**daemon 自启动**。交互模式启动 `mica`（`src/index.ts` fire-and-forget 调用）时，若配置了 sync.json 且 `MICA_HOME/daemon.pid` 记录的进程已死/不存在，则 detached 后台拉起 `mica daemon`（stdout/stderr 追加到 `MICA_HOME/daemon.log`）；已有存活 daemon 则跳过。`MICA_NO_DAEMON=1` 禁用（CI/headless）。
- `index.ts`：`runDaemon` 主循环。注册 → 心跳（20s）→ 长轮询（35s 超时）→ `EventPusher`（40ms/50 条批次、串行推送保证顺序）。启动时写 `daemon.pid`（已存活则退出，防双 daemon），退出时清理；SIGINT/SIGTERM 优雅退出。
- `SyncClient.ts`：HTTP 客户端，所有请求带 `x-machine-id` header。
- `SessionWatcher.ts`：`fs.watch` 监听 sessions 目录 + 30s 周期 rescan 兜底（macOS rename 事件可能丢失）。
- `CommandExecutor.ts`：远程续聊 turn 执行。每 turn 新建 `AgentRuntime` + `SessionController`，MCP 保持 daemon 生命周期常开；同一时刻只执行一个 turn，busy 时发 `run_rejected` 事件；turn 前 `chdir` 到会话记录的 `cwd`。

### 3.3 `packages/mica-sync-web`（Web 控制台）

- hash 路由（`#/m/<machineId>/s/<sessionId>`），`vite base: './'` 可部署任意子路径。
- 历史消息从会话快照 `snapshot.conversationMessages` 渲染；实时事件按 `since` 增量幂等合并。
- SSE 用 `fetch` 流式解析而非 `EventSource`。
- 页面：机器列表（左栏）→ 会话列表 → 会话详情（消息流 + 底部输入框，运行中可中止）。
- **切换性能**：detail 接口默认返回精简快照（剔除 `snapshot.messages`/`usageHistory`/`lastUsage`，`?full=1` 取全量），最大会话 payload 从 ~1.3MB 降到 ~15KB；SSE `session` 事件只带元数据（id/title/updatedAt/cwd/turnState/revision + providerId/model/effort/role），不再内嵌完整快照。切换时先拉 detail 拿到 `snapshotSeq`（最近一次 session 快照事件的 seq），SSE 从该序号续接，不重放旧缓冲事件，避免消息重复与全量渲染；消息组件已 memo 化，流式 `text_delta` 只重渲染变化的消息。
- **切换交互**：会话列表接口（`/api/machines/:id/sessions`）为每个 summary 附带 `snapshotSeq`；Web 切换会话时立即建 SSE（`since=` 列表水位，detail 返回后再校正），全程不出现"连接断开"；切换瞬间显示"加载会话中…"替代旧版 welcome 闪现，detail 完成才切换内容。连接状态三态：`实时连接` / `连接中…`（首连）/ `连接断开，自动重连中…`（真断连，2s→30s 指数退避重连）。`Conversation`/`Sidebar`/消息项均 memo，session 事件与 poll 不再导致侧栏 225 行全量重建。
- **静态缓存**：`serveStaticFile` 对 `index.html` 返回 `Cache-Control: no-cache`（每次刷新校验，保证拿到新 bundle），对 `/assets/*`（带 hash）返回 `immutable` 一年缓存。

### 3.4 Config Web Sync 页面

- `packages/mica-config-web/web/src/pages/SyncPage.tsx`（新增）、`src/server/syncDetails.ts`（新增）、`shared/types.ts` 增加 `ConfigWebSyncDetails` / `ConfigWebSyncMachine`。
- 路由：`GET /api/details/sync`（读 sync.json 并探测服务器）、`PUT /api/files/sync`（保存 serverUrl/name）。
- 探测调用中心服务器无认证 API `/api/machines`，按 machineId（缺失时按 hostname）判断本机在线。

## 4. 协议与语义

### 4.1 Daemon 端点（`x-machine-id` header 标识，未注册返回 404）

| 方法 | 路径               | 说明                                                                               |
| ---- | ------------------ | ---------------------------------------------------------------------------------- |
| POST | `/daemon/register` | 注册机器，返回 `machineId`（hostname 相同则复用原记录，丢失 sync.json 不会换身份） |
| POST | `/daemon/beat`     | 心跳 + 上报活跃会话 `{ active: { sessionId, running } }`                           |
| POST | `/daemon/poll`     | 长轮询指令（`run`/`abort`），最多 hold 25s                                         |
| POST | `/daemon/session`  | 推送会话快照；`session: null` + `sessionId` 为删除                                 |
| POST | `/daemon/events`   | 推送 turn 事件批次，可附带最新会话快照                                             |

### 4.2 Web 端点（无认证，公网需自行防护）

| 方法 | 路径                                             | 说明                                      |
| ---- | ------------------------------------------------ | ----------------------------------------- |
| GET  | `/api/status`                                    | 健康检查                                  |
| GET  | `/api/machines`                                  | 机器列表（含在线状态）                    |
| GET  | `/api/machines/:id/sessions`                     | 会话摘要列表                              |
| GET  | `/api/machines/:id/sessions/:sid`                | 会话详情                                  |
| GET  | `/api/machines/:id/sessions/:sid/events?since=N` | SSE 事件流，断线补拉                      |
| POST | `/api/machines/:id/sessions/:sid/run`            | 下发续聊指令 `{ text }`；机器离线返回 409 |
| POST | `/api/machines/:id/sessions/:sid/abort`          | 中止当前 turn                             |

### 4.3 事件类型

`user_input`、`thinking`、`text_delta`、`tool_call`、`tool_result`、`usage`、`status`、`turn`（state: `completed`/`aborted`/`error`）、`run_rejected`、`session`、`session_removed`。

### 4.4 关键语义

- **在线判定**：`lastSeen` 距今 < 90s（心跳 20s + 余量）。离线机器拒绝 `run`（409）。
- **abort 边界**：依赖 `AgentRuntime.abort()`（runId 失效 + signal）。正在等 provider stream 时立即生效；工具执行中或长 thinking 期间要等到当前迭代/工具结束边界才抛 `AgentAbortError`——这是 provider client 既有语义，不要另造中断机制。
- **顺序保证**：`EventPusher` 按会话串行推送，服务器按到达顺序发布 SSE 帧；会话快照带单调 `revision`，服务器拒绝迟到的旧快照。
- **幂等合并**：Web 端以会话快照为底，实时事件按序号增量合并；切换会话时会中止旧 SSE，终止事件后主动重拉快照，并以低频轮询自愈。
- **session 事件轻量化**：`/daemon/session` 与 `/daemon/events` 中的快照仍全量落盘存储，但向 SSE 发布的 `session` 事件只含元数据（Web 需要对话内容时通过 detail 接口按 `?full=1` 或默认精简取回）。本地终端 turn 完成只发轻量 session 事件时，Web 会主动重拉权威快照。
- **断点续接**：detail 响应携带 `snapshotSeq`，Web 在详情加载完成后再建立 SSE（`since=snapshotSeq`），缓冲内已反映在快照里的旧事件不重放。
- **切换即连**：列表接口的 `snapshotSeq` 让 Web 在切换瞬间就能用正确水位开 SSE，detail 只是校正水位（`useSse` 跨重启保留 `lastSeqRef`，绝不重放已见事件，避免 `text_delta` 重复追加）。
- **本地/远程交替**：本地 runtime 与 daemon 执行 turn 前获取同一个跨进程 session lease；冲突时稳定返回 busy。远程完成后，本地下一次提交会先重载磁盘最新快照再运行，避免旧内存历史覆盖远程结果。

## 5. 部署指南

### 5.1 构建

```bash
bun run build:sync-server   # -> dist/mica-sync-server.js（Node 单文件 ESM bundle）
bun run build:sync-web      # -> packages/mica-sync-web/web/dist（vite base './'）
```

### 5.2 生产服务器（188.253.118.143）

- 目录：`/opt/mica-sync/`，包含 `mica-sync-server.mjs`、`web/`（web dist 内容）、`data/`（运行期数据，自动创建）。
- pm2 进程名 `mica-sync`，监听 **5560**。
- **必须显式指定解释器**（直接 `pm2 start mica-sync-server.mjs` 不会执行 ESM bundle 入口）：

```bash
pm2 start node --name mica-sync -- mica-sync-server.mjs \
  --port 5560 --data-dir /opt/mica-sync/data --web-dir /opt/mica-sync/web
pm2 save
```

- Nginx 反代（`/mica/` → `127.0.0.1:5560`），**必须关闭 buffering** 否则 SSE 断开：

```nginx
location /mica/ {
    proxy_pass http://127.0.0.1:5560/;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

### 5.3 remote-shell 重部署（高危，注意数据）

**remote-shell 的 `upload&extract=1` 会清空 target 目录**。重新部署前必须先备份再恢复 `data/`，否则机器注册和会话记录丢失：

> 备份是一次性的：第 3 步把备份 `mv` 回 `data` 后，`/tmp` 里就不再保留备份。**第二次部署前先 `test -d /tmp/mica-sync-data-backup` 确认备份存在**，不存在就先 `cp -r /opt/mica-sync/data` 再删，避免误删后无法恢复。若 data 真丢了，本机 daemon 是数据源：重启 `mica daemon` 会全量重推会话，但机器会拿到新 machineId（服务器 `upsertMachine` 按 hostname 复用，记录没了就生成新 id），Web 端 URL 会变。

```sh
# 1. 备份数据
curl -s 'http://188.253.118.143:5556/shell?shell=mv%20/opt/mica-sync/data%20/tmp/mica-sync-data-backup'
# 2. 上传并解压新包到 /opt/mica-sync（此步骤清空 target）
curl -X POST --data-binary @/tmp/mica-sync.tar.gz \
  'http://188.253.118.143:5556/upload?path=/tmp/mica-sync.tar.gz&extract=1&target=/opt/mica-sync'
# 3. 恢复数据并重启
curl -s 'http://188.253.118.143:5556/shell?shell=rm%20-rf%20/opt/mica-sync/data%20%26%26%20mv%20/tmp/mica-sync-data-backup%20/opt/mica-sync/data%20%26%26%20pm2%20restart%20mica-sync'
```

服务器上的所有服务信息见 `qirong-application/Agent.md`；变更服务器配置后要同步更新该文件。

### 5.4 机器端 daemon

```bash
mica daemon --server http://HOST:PORT [--name <machine-name>]
```

- 首次运行自动注册（无需密钥），配置写入 `~/.mica/sync.json`（跟随 `MICA_HOME`）。
- 不传 `--server` 时复用 sync.json 里的 `serverUrl`；`--name` 覆盖机器显示名（默认 hostname）。

## 6. 后续开发指引

### 6.1 修改涉及的文件（改动前先看这些）

- 服务端：`packages/mica-sync-server/src/*`、`packages/mica-sync-server/README.md`
- 机器端：`src/daemon/*`、`src/cli/args.ts`、`src/index.ts`
- Web 端：`packages/mica-sync-web/web/src/*`（构建产物 `web/dist` 需重新 build）
- Config Web：`packages/mica-config-web/web/src/pages/SyncPage.tsx`、`src/server/syncDetails.ts`、`shared/types.ts`、`web/src/api.ts`、`web/src/layout/Sidebar.tsx`
- 文档：`AGENT.md`（Mica Sync 章节）、`README.md`、`packages/README.md`、本文件

### 6.2 验证

```bash
bunx tsc --noEmit                      # 类型检查
bun run build:sync-server              # 服务端 bundle
bun run build:sync-web                 # Web 构建
git diff --check
```

本地联调：起一个 `node dist/mica-sync-server.js --port 5560 --data-dir /tmp/sync-data --web-dir packages/mica-sync-web/web/dist`，再开 `mica daemon --server http://127.0.0.1:5560` 验证镜像与续聊。涉及 config/session 的测试用临时 `MICA_HOME`，不要污染真实 `~/.mica`。

交替对话回归可运行：`MICA_PTY_SOURCE_HOME="$HOME/.mica" MICA_PTY_SYNC_SMOKE=1 bunx vitest run packages/mica-pty/tests/mica-sync.smoke.test.ts`。该测试复制 provider 配置到临时 `MICA_HOME`，真实执行“本地 → 远程 → 本地”，结束后清理隔离数据。

### 6.3 已知限制与注意事项

- **无认证**：daemon 用 `x-machine-id` header 标识机器，Web API 完全开放；公网部署必须用 Nginx 基本认证或防火墙保护。
- **单 turn 串行**：daemon 同一时刻只执行一个 turn（busy 时发 `run_rejected`），不同 session 也不并发。
- **abort 粒度**：工具执行中/长 thinking 期间 abort 要等边界，不能做到立即中断。
- **同 session 不并发**：本地终端与远程续聊共享跨进程 turn lease；一端运行时另一端会被拒绝，需要等当前 turn 完成后重试。不同本地进程必须运行包含该 lease 协议的新版本。
- **push 失败不重试**：`SessionWatcher` 推送失败只记日志，无重试队列；恢复靠心跳 + 后续事件。
- **macOS fs.watch 丢事件**：rename 可能无 filename，因此保留 30s 周期 rescan 兜底。

### 6.4 扩展方向（如有需要）

- 为 `/daemon/poll` 增加多命令按 session 过滤，或支持并发 turn（当前 busy 即拒）。
- 事件存储从内存 500 条升级为持久化（重连补拉超过 500 条目前会丢更早事件）。
- 增加认证层（如 daemon 注册 token、Web 基本认证）。
- Web 端会话列表分页 / 搜索；配置页展示服务器会话统计。
