# mica-sync-server

Mica Sync 的中心聚合服务器：收集所有机器上 `mica daemon` 镜像的会话，并通过 REST + SSE 提供给 Web 前端（`mica-sync-web`），支持网页端浏览机器/会话并回源续聊。

## 特性

- 零第三方依赖（仅 Node 内置模块），单文件部署，Node >= 18 即可运行
- 无认证设计：daemon 用 `x-machine-id` header 标识机器，Web API 完全开放（公网部署建议用 Nginx 基本认证/防火墙自行保护）
- 会话快照 JSON 文件存储（`data/sessions/<machineId>/<sessionId>.json`）
- 长轮询指令下发（daemon 主动出站连接，NAT 友好，无需入站端口）
- SSE 实时事件流 + 每会话 500 条事件缓冲（断线用 `since` 序号补拉）
- 静态托管 `mica-sync-web` 构建产物

## API

### Daemon 端点（`x-machine-id` header 标识机器，未注册返回 404）

| 方法 | 路径               | 说明                                                      |
| ---- | ------------------ | --------------------------------------------------------- |
| POST | `/daemon/register` | 注册机器，返回 `machineId`（hostname 相同则复用原记录）   |
| POST | `/daemon/beat`     | 心跳 + 上报活跃会话状态                                   |
| POST | `/daemon/poll`     | 长轮询指令（`create` / `run` / `abort`），最多 hold 25s   |
| POST | `/daemon/session`  | 推送/删除会话快照（`session: null` + `sessionId` 为删除） |
| POST | `/daemon/events`   | 推送 turn 事件批次，可附带最新会话快照                    |

### Web 端点（无需认证）

| 方法 | 路径                                     | 说明                                                       |
| ---- | ---------------------------------------- | ---------------------------------------------------------- |
| GET  | `/api/status`                            | 健康检查                                                   |
| GET  | `/api/machines`                          | 机器列表（含在线状态）                                     |
| GET  | `/api/machines/:id/sessions`             | 会话摘要列表                                               |
| POST | `/api/machines/:id/sessions`             | 新建会话 `{ text, cwd? }`，返回 `{ sessionId, commandId }` |
| GET  | `/api/machines/:id/sessions/:sid`        | 会话详情                                                   |
| GET  | `/api/machines/:id/sessions/:sid/events` | SSE 事件流（`?since=N` 补拉）                              |
| POST | `/api/machines/:id/sessions/:sid/run`    | 下发续聊指令 `{ text }`                                    |
| POST | `/api/machines/:id/sessions/:sid/abort`  | 中止当前 turn                                              |

机器在线判定：`lastSeen` 距今 < 90s。离线机器会拒绝 `run` / `create`（409）。

新建会话：`POST /api/machines/:id/sessions` 由服务器生成 `sessionId` 并下发 `create`
指令（`{ type: 'create', sessionId, prompt, cwd? }`）；daemon 用本机配置
provider/model/effort 创建全新会话并执行首条消息，`cwd` 留空时使用 daemon 机器家目录。

## 部署

```bash
# 构建
bun run build:sync-server   # -> dist/mica-sync-server.js（Node 单文件 bundle）
bun run build:sync-web      # -> packages/mica-sync-web/web/dist

# 服务器部署（目录结构）
#   /opt/mica-sync/mica-sync-server.mjs
#   /opt/mica-sync/web/                （web dist 内容）
#   /opt/mica-sync/data/               （运行期数据，自动创建）

pm2 start node --name mica-sync -- mica-sync-server.mjs \
  --port 5560 --data-dir /opt/mica-sync/data --web-dir /opt/mica-sync/web
pm2 save
```

注意：`pm2 start mica-sync-server.mjs`（不指定解释器）不会正确运行 ESM bundle，必须用 `pm2 start node -- ...`。

重新部署时 **remote-shell 的 `upload&extract=1` 会清空 target 目录**，必须先备份再恢复运行数据：

```sh
curl -s 'http://188.253.118.143:5556/shell?shell=mv%20/opt/mica-sync/data%20/tmp/mica-sync-data-backup'
curl -X POST --data-binary @/tmp/mica-sync.tar.gz \
  'http://188.253.118.143:5556/upload?path=/tmp/mica-sync.tar.gz&extract=1&target=/opt/mica-sync'
curl -s 'http://188.253.118.143:5556/shell?shell=rm%20-rf%20/opt/mica-sync/data%20%26%26%20mv%20/tmp/mica-sync-data-backup%20/opt/mica-sync/data%20%26%26%20pm2%20restart%20mica-sync'
```

Nginx 反代（SSE 需要关闭 buffering）：

```nginx
location /mica/ {
    proxy_pass http://127.0.0.1:5560/;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

启动命令：`mica daemon --server http://HOST:PORT`（`--name` 可选，默认用机器 hostname），首次运行自动注册（无需任何密钥）。
