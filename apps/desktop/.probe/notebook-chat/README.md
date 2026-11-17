# Notebook Chat Dock · 可复用 UI 探针

挂载真实 `plugins/notebook/NotebookChatDock.jsx`，不复制其 UI，不改真实组件适配探针。
与宿主共用 `ArcoProvider`、共享控件、`body.mica-arco-theme`，样式顺序是共享配置页 / Arco →
`app.css` → `plugins/notebook/notebook.css`。Markdown 开启时用宿主 `ChatView.Markdown`，关闭时走组件自己的纯文本分支。
目录和中间编辑器**只是占位**，不读写笔记，不验证编辑器或自动保存。

## Fake 模式（默认，无运行时 / 业务网络请求）

手动启动，不构建、不重启桌面端：

```bash
cd apps/desktop
npx vite --config .probe/notebook-chat/vite.config.mjs
# http://127.0.0.1:5240/
# http://127.0.0.1:5240/?theme=darcula&width=390&markdown=off
```

工具栏切换 1440 / 1100 / 760 / 390px **容器**宽度、light / darcula 主题、Markdown 与场景。
容器宽度不大于视口；要测 `@media` 而不是 `@container`，还需把受控浏览器窗口真正设为目标宽度。
探针 CSS 只负责壳与静态占位，不覆盖 dock 尺寸 / 断点，所以它不会掩盖组件自身的溢出。

场景包括即时首帧、手动流、发送失败、异步队列拒绝、停止失败、历史 / 列表失败、长历史、空列表、缺少宿主能力。
默认发送会**在 send Promise 返回前**同步推送 step_start 与第一帧 text；不会自动跑完一轮。
停止请求只返回确认，不替代退出事件：手动发 `finish()` 后才能退出停止中状态。
队列拒绝也需在接受确认后手动触发，避免用固定计时器猜测组件进度。

### 控制 API

组件提交后有 `window.__probe`。`ready` 表示探针已挂载，不表示异步历史已就绪；
测试应等待 DOM 上真实加载提示消失 / 对应按钮可用，而不是固定 sleep。
不 hook `fetch`，fake 只是内存中的 `api.sessions`，`sent` 保存送到 API 的完整原始参数：

```js
const p = window.__probe
p.sent                           // [{ sessionId, cwd, prompt, clientMessageId? }]
p.inspect()                      // DOM 尺寸、滚动范围、按钮禁用状态、消息、订阅数、pending 与 sent
// 同时更新隐藏的 #probe-out.textContent，方便受控浏览器读取 JSON。
p.setWidth(760)
p.setTheme('darcula')
p.setOpen(false)
p.setOpen(true)
p.setMarkdown(false)
p.setScenario('immediate-text')   // 重置 fake 数据并重挂载组件；不会清理真实会话或笔记
p.setApi({})                     // 自定义内存 API；恢复用 setScenario()
```

`setScenario()` 会清空发送 / 调用记录、运行状态与策略，并拒绝旧的挂起 Promise。
不会修改组件使用的 localStorage；要保证测试独立，可仅清除本探针 origin 上的
`mica.notebook.chat-session` 再重挂载（不要操作真实桌面 origin）。

```js
// 通过真实 textarea 输入 / 发送按钮发送，不由 helper 绕过组件发送。
// 发送后检查 p.sent.at(-1).prompt 与 textarea 原文完全一致（含空格 / 换行）。
const id = 'probe-session-a'
p.text(id, '第二段文字\n')
p.event(id, { type: 'step_finish' }) // 内部模型步骤完成，不应清除整轮 running
p.event(id, { type: 'text_rollback', length: 4 })
p.event(id, { type: 'retrying' })
p.finish(id)                       // 持久化 fake 回复 + 推送 onExit；组件重新读取 history

p.setScenario('queue-error')
// 等组件重新就绪，在真实输入框发送，等待「已排队」/ send 返回后：
p.queueError()                     // 带原文与 clientMessageId 的异步拒绝；检查草稿恢复

p.setScenario('manual')
p.configure('abort', { hold: true })
// 真实发送、点击停止后：
p.fake.inspect().pending           // 找 method === 'abort' 的 id
p.release(/* pending id */)        // 请求确认，不应立刻认为整轮结束
p.finish(id)                       // 此时才退出停止中
```

可配置的方法是 `list` / `history` / `isRunning` / `send` / `abort`；策略按全局方法名或
`方法名:sessionId` 生效，后者覆盖前者。可控延迟、挂起、拒绝均通过 Promise 实现：

```js
p.configure('history:probe-session-b', { hold: true })
p.configure('isRunning', { delayMs: 150 })
p.configure('send', { fail: true, error: '受控网络错误' })
p.fake.calls                       // 方法调用与完成状态
p.fake.pending                     // Map，或 fake.inspect().pending 的纯 JSON 投影
p.release(/* call id */, /* 可选自定义返回值 */)
p.reject(/* call id */, '受控历史读取失败')
p.fake.clearPolicy('send')
p.fake.setHistory(id, [{ role: 'assistant', text: '替换的内存历史' }])
p.fake.setRows([{ id, title: '单条会话', cwd: '/example', updatedAt: new Date().toISOString() }])
p.fake.startExternal(id, '来自另一页面的一轮')
```

历史请求在调用时快照数据，支持故意让 B 的旧 history 在切回 A 后才返回。
`release(callId, rows)` 可构造更明确的旧回包；无需篡改真实 transport。
`fake.api.status` 与 `isRunning` 同义，运行快照携带 prompt 与带 sequence 的 events。

### 建议手动验收顺序（探针不会自行执行）

1. 1440 / 1100 / 760 / 390，light / darcula：标题省略、路径、按钮对齐、编辑器让位 / 覆盖、无水平溢出。
2. 会话选择与搜索（含长标题和零匹配），各会话独立草稿，关闭重开不丢当前草稿。
3. 原文发送（空格 / 多行）、Enter / Shift+Enter / 输入法组合，重复发送保护；即时首帧不丢 / 不重复。
4. 切会话前挂起 history，切回后释放旧回包，确认不串历史；运行中刷新 / 切回时不重复事件。
5. 空草稿仍能停止，停止请求确认后等待退出；停止失败后可重试。
6. send 失败与异步 queue-error 恢复原文；已有新草稿不被覆盖；列表 / 历史读取失败提示与重试。
7. long-history 滚到上方后推送新帧，不抢滚动；回到底部、复制、Markdown / 纯文本。
8. 缺少 sessions、空列表与未选中会话，不允许误发送；订阅数关闭 / 重挂载后不累积。

## Real 模式（只连显式隔离运行时）

这不是默认模式，也不会自动创建运行时。先由操作者按 `agent/build.md` 启动隔离实例，
显式设置独立 `MICA_HOME`、`MICA_DESKTOP_USER_DATA`、`MICA_DESKTOP_PORT` 与 `--user-data-dir`。
用隔离数据中的会话进行测试；真实发送可能调用模型并产生费用。

```bash
cd apps/desktop
MICA_PROBE_RUNTIME_TARGET=http://127.0.0.1:18841 \
  npx vite --config .probe/notebook-chat/vite.config.mjs
# 浏览器打开：
# http://127.0.0.1:5240/?runtime=http%3A%2F%2F127.0.0.1%3A18841&theme=light
```

要求：

- 环境变量与 URL runtime 参数都必须显式提供且匹配，只接受 `http://127.0.0.1:<port>`。
  配置拒绝 `8787`（真实默认运行时）和 `5240`（探针自身），不做任何默认地址回退。
- 该端口必须由操作者确保属于**隔离实例**；探针只能验证地址，不能证明其数据目录隔离。
- Vite 只把 `/api` 代理到该 target，包含 SSE；真实 `transport.ensureMicaApi()` 与
  `createPluginHostApi('notebook')` 动态加载，仍用原始相对 URL。没有跨源 fetch / fetch 拦截。
- 未配置 target、参数不匹配或运行时不可达均显示启动错误，**不挂载 dock、不回退 fake / 8787**。
- `window.__probe.sent` 透明记录真实 `sessions.send` 参数，调用仍走原宿主能力；
  `inspect()`、宽度 / 主题 / Markdown 控制可用，fake 场景与事件注入接口不暴露。
- Fake 只验证组件交互 / 布局，不证明 app-server 协议、宿主节点映射或真实模型链路可用；
  Real 才验证 transport → host API → app-server 的实际发送、停止、流式事件与历史持久化。

本目录不启动服务、不运行自动测试、不构建产物，也不读取真实笔记。
