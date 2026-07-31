# mica-sync-web

Mica Sync 的 Web 控制台（React + Vite），由 `mica-sync-server` 托管。用于在浏览器中查看所有机器上的 Mica 会话并远程续聊。

## 页面

- **机器列表**（左栏）：在线状态、活跃会话徽标、最后心跳；点击展开该机器的会话列表
- **新建会话**：在线机器行尾的 `+` 按钮打开新建会话弹窗（选择机器、可选工作目录、首条消息），提交后跳转到新会话并实时流式显示首个 turn
- **会话列表**：标题、状态徽标（运行中/已完成/已中止/出错）、相对时间，按更新时间排序
- **会话详情**：顶部信息栏（机器、cwd、provider/model/effort/role、实时连接状态）；消息流（用户 / 助手 / 工具调用折叠卡片 / thinking / notice）；底部输入框（Enter 发送，运行中可中止）
- **实时更新**：SSE 流式渲染 `text_delta`、工具调用与结果、turn 状态；断线自动重连并按事件序号补拉

## 技术要点

- hash 路由（`#/m/<machineId>/s/<sessionId>`），`vite base: './'` 相对资源路径，可部署在任意子路径
- 历史消息从会话快照的 `snapshot.conversationMessages` 渲染；实时事件增量幂等合并（避免与快照重复）
- SSE 通过 `fetch` 流式解析，非 `EventSource`（后者无法在跨部署场景可靠控制）

## 构建

```bash
bun run build:sync-web   # -> web/dist，由 mica-sync-server --web-dir 指向
```
