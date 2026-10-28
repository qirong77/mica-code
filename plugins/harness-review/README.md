# Harness Review

运行机制自动记录 agent 轨迹，聚合有证据的问题候选，供用户定期复盘。无需在 system prompt 中要求模型在任务结束后反思，也不增加后台模型请求。

## 使用

在插件设置里启用 Harness Review 后，新启动的 TUI、app-server 与 `mica exec` 会自动采集。

交互式终端：

```text
/harness-review list
/harness-review report
/harness-review assess <条目id> accepted 用户认可这个改进方向
/harness-review assess <条目id> validated 在相关任务和回归样本上验证，附结果和文件路径
/harness-review assess <条目id> dismissed 这是正常轮询，无需修改
```

桌面端可以直接对 agent 说“查看当前工作区的 harness 复盘并导出报告”，由 `harness_review` 工具读取或导出。桌面对话输入框不分派 TUI 斜杠命令。第一版没有专用 review 页面。

状态有 `open`（待复盘）、`accepted`（认可方向）、`dismissed`（忽略）、`validated`（人工记录验证通过）、`regressed`（人工记录回归）。`assess` 必须提供依据，并且只能操作当前工作区可见的条目。这些状态是人工评估记录，插件本身不运行评测。

## 记录与分析

- 运行开始、终态（completed / error / aborted）、模型请求数、工具调用和结果、provider 重试、历史改写、模型 token 用量。
- 最终组装的 system prompt 记录 SHA-256 和字符数，用于识别变化，正文不落盘。
- 工具失败、相同参数重复调用、provider 重试与运行失败形成候选，按模式聚合，附运行 ID、事件序号和轨迹文件。重复调用仅是复盘信号，不能证明无进展；常见轮询工具不参与该规则。
- 每项提供可能涉及的模块、建议及验证方式。工具失败不等于任务失败，运行 `completed` 不等于用户目标已验证。
- 采集范围是通过 `AgentRuntime.run` 执行的运行。直接创建的 helper/subagent 模型客户端内部请求目前没有完整轨迹；主流程委派工具的调用与返回仍会记录。最终 prompt 指纹可识别包括记忆在内的整体变化，但不能单凭指纹归因到某条记忆。
- 运行 ID 标识一次 agent 执行尝试；turn 级重试可能产生多条运行记录。

不自动修改指令、工具、loop 或记忆，不生成或执行修改 patch。第一版交付观察、聚合和人工 review 流程。

## 存储与设置

默认位置：`$MICA_HOME/plugin-data/harness-review/`。

- `runs/<uuid>/`：每次运行独立的 `events.jsonl` 与 `summary.json`。
- `decisions/`：每个问题条目独立的人工判断记录。
- 报告由 `report` 按需导出，命令和工具返回实际文件路径。

记录使用异步串行写入；正常关闭时 flush。未结束的运行会保留未完成状态，不当作成功；进程被强制杀死时可能保留 `running`，复盘时应视为未完结记录。

`list` 最多展示最近 20 次运行和 20 项聚合问题，每项 5 条证据，避免复盘内容挤占模型上下文；`report` 导出完整复盘范围。请求数按 provider 实际进入一轮请求计数，transport 重试单独统计。

插件设置支持关闭自动记录、关闭任务与工具内容采集（只留摘要与指标）、调整单条内容字符数和单次运行事件上限。超限丢弃数量保留在摘要中，运行终态仍会更新。设置变更从下一次运行开始生效。

任务与工具内容默认脱敏后截断记录，敏感键、常见凭据格式和媒体 payload 会过滤；这不是任意自由文本的完整秘密检测器。模型配置只存 provider/model/protocol/effort/role 等白名单字段，不复制接口凭据。可以关闭内容采集，仅保留元数据；文件保存在本机，由用户按需清理。

复盘按当前工作目录过滤，并有扫描与证据数量上限。完整轨迹按运行保留，第一版不自动清理历史轨迹。
