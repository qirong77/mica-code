# Task Delivery

桌面端的任务交付摘要。模型通过 `task_delivery` 保存一个会话级报告；有内容时只显示一张紧凑卡片，完整详情使用宿主标准面板。无报告时不显示卡片。

## 使用

`task_delivery` 仅向主代理注册，支持 `read`、`set`、`clear`。`set` 整份替换，并生成新的随机 UUID revision；`read` / `clear` 只接受 `action`。

```json
{
  "action": "set",
  "summary": "补齐交付摘要与回归验证",
  "changedFiles": ["src/example.ts"],
  "reports": {
    "code": "done",
    "validation": "done",
    "build": "skipped",
    "deploy": "skipped"
  },
  "validationClaims": ["运行了针对性单测，模型报告通过"],
  "deploymentReport": "模型报告：未部署",
  "evidenceIds": ["actual-tool-call-id"]
}
```

状态只能使用 `unknown` / `pending` / `done` / `failed` / `skipped`。所有四项状态、变更文件、验证声明及部署来源/结果始终标成模型报告；不提供 `VERIFIED` 状态，模型也不能提交证据对象。

## 工具证据边界

观察器只接收 `turn:before` 建立的主会话 owner，并在对应非 helper、非 delegation 的 `run:start` 后记录当前 run 的 `tool:call` 与匹配的 `tool:result`。引用必须匹配 owner、runId、调用 ID 与工具名；孤立结果、子代理结果、其他会话结果和上一轮结果均不可引用。每 owner 最多保留 128 条待返回调用和 64 条结果元数据；每份报告最多引用 12 条。缺 ID 或缺观察事件时显示“无可用工具证据”，不从模型文字推断。

保存的证据只有工具名、调用 ID、runId、时间及有限返回状态，**不保存命令、参数或原始输出**。工具返回只说明观察到结果；它可能是工具报错、启动成功或其他返回，并不代表测试通过。仅 `run_shell` 的完整已知元数据前缀可以解析退出码，超时/中断/未知格式退为“观察到工具返回”。退出码 0 只证明命令正常退出，不证明语义测试成功、覆盖充分或部署成功。SSH、后台任务及其他工具不做退出码推断。

恢复后的引用始终作为历史引用显示，不重新检查当前工作区，不自动执行任何命令。`sourceSessionId` 记录写入时的会话身份；fork 后仍可识别来源。

## 状态与界面

状态存在 `ctx.sessionState`，随会话快照、compact、resume/fork 保存。运行期输入最多 48 KiB；摘要 3000 字符、40 个文件路径（每条 320 字符）、12 条验证声明（每条 600 字符）、部署说明 1500 字符。持久状态最多 64 KiB，恢复时严格校验字段并重建纯数据，未知字段不进入视图。超长输入拒绝，不静默截断保存内容。

卡片和详情动作都携带 revision；内容更新后旧动作失效。“收起”只为当前 revision 记录 `dismissedRevision`，报告仍可从面板查看，下一次 `set` 会重新出现。清除会删除整个报告。展示通过宿主 `impressionAction` 上报，读取视图不伪造曝光。

`plugin.json` 声明桌面、会话、状态、工具、prompt、hooks 与设置能力；非桌面宿主跳过整个插件。面板使用 `dynamicShortcuts` 让宿主提前取视图，卡片数据使用共享 `PluginPanelView.cards`，插件不自带 React 页面。

## 使用日志与验证

`telemetry` 默认开启，可在插件设置关闭。共享 `createPluginExperience` 仅记录允许的事件、surface、action、outcome、随机 revision 与计数；不附正文、文件路径、URL、命令或错误文本。

```sh
bunx vitest run --project unit plugins/task-delivery
bun run typecheck
```

测试覆盖工具边界、字节配额、owner 隔离、跨轮/伪造/子代理证据拒绝、可靠退出码前缀解析、过期动作、收起和清除、隐私日志开关。无需构建、启动桌面或调用模型。
