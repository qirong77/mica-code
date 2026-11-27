# mica-remote-protocol

远程 Agent 上下文的协议与纯逻辑层，被 CLI 控制端、执行机 Worker 和中转机共用。

## 职责

- **设备身份**：X25519 长期密钥、显示指纹、设备 id（`m_` / `c_` 前缀）。
- **端到端加密**：X25519 + HKDF 派生双向密钥，AES-256-GCM 封包；AAD 绑定方向、发送方、接收方和关联 id。
- **配对**：一次运行有效的 128-bit 配对码（PSK），机器 id 编进码里，中转机看不到明文。
- **线上协议**：hello、配对、RPC、目录、在线状态和错误码；所有帧都有大小上限。
- **投影**：把本地会话文件压成中转可接受的目录条目与历史页。自动标题、系统提示词、推理、工具原始结果、图片数据都不出本机。
- **本地状态**：`$MICA_HOME/remote/` 下的身份、relay 令牌、工作区、授权和已知机器；文件权限 `0600`。

## 边界

- 不依赖 UI、应用宿主或会话磁盘布局。
- 不打开网络连接，也不启动进程；连接与生命周期在 `apps/cli/src/remote/`。
- 不把完整 session JSON 当协议内容；只接受 `projection.ts` 构造的白名单字段。
- 工作区/会话在线上只用不透明引用（哈希），路径和 Mica 会话 id 留在本机。

## 主要导出

| 文件 | 内容 |
| --- | --- |
| `crypto.ts` | `createDeviceIdentity`、`deriveSessionKeys`、`seal` / `open`、配对码与配对信封 |
| `protocol.ts` | `RelayFrame`、RPC 载荷、目录/历史类型、`parseRelayFrame`、`RemoteProtocolError` |
| `projection.ts` | `listLocalSessions`、`buildWorkspaceSummary`、`projectHistoryPage` |
| `localState.ts` | `loadOrCreateIdentity`、relay 注册、工作区、授权与已知机器 |
| `limits.ts` | 帧、页面、目录、频率和并发的首版预算 |
