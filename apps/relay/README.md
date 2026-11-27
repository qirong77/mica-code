# mica remote relay

远程 Agent 上下文的中转机。只做设备注册、配对授权、在线状态、目录索引和密文转发；
不挂载工作区、不执行命令、不解析或保存会话正文。

## 运行

```bash
bun apps/relay/src/entry.ts --host 127.0.0.1 --port 8787 --data ./relay-data/relay.json
```

启动后打印邀请码。首次在一个新设备上执行 `mica remote ... --relay <url> --invite <code>`
即可注册设备；之后凭本地保存的设备口令重连。

生产部署必须放在提供 TLS 的反向代理后面（`wss://`），不要直接把明文 `ws://` 暴露到公网。
relay 自己只监听 `127.0.0.1`，由 nginx 终止 TLS 并转发 WebSocket；服务可以用 systemd 常驻：

```ini
[Service]
ExecStart=/opt/mica-relay/relay --host 127.0.0.1 --port 8787 --data /var/lib/mica-relay/relay.json
User=mica-relay
Restart=always
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/mica-relay
MemoryMax=128M
```

nginx 侧只需要转发 `Upgrade` / `Connection`，并关闭 `proxy_buffering`、把读写超时放大到
长连接所需的值。relay 不记录请求正文，nginx 的 `access_log` 可以对这个 vhost 关掉。

## 数据

`relay.json` 里只有：

- 设备：不透明设备 id、类型、显示名、公开密钥、口令哈希；
- 授权：`(machineId, controllerId, permissions)`；
- 目录：每台执行机最近一次发布的机器名、工作区/会话的不透明引用与状态。

消息正文经端到端加密，relay 只转发 `n` / `c` 两个字段，不落盘。
