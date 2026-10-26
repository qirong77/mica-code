# Todo

回合内的待办清单：`todo_write` 工具、`/todo` 命令和一段常驻状态面板。

## 它做什么

- `todo_write` 让模型把计划写成条目（`pending` / `in_progress` / `completed`）。工具只改内存，
  不写会话文件。
- 回合正常完成时，遗留的 `pending` / `in_progress` 一起标记为完成；中止或失败只把
  `in_progress` 退回 `pending`，因为「停了」不等于「做完了」。
- `/todo [show|hide|clear]` 控制面板显隐与清空。
- 面板按 agent 归属隔离，多 agent 各自一份清单。

## 文件

| 文件                 | 作用                                   |
| -------------------- | -------------------------------------- |
| `plugin.json`        | 插件清单（id / 版本 / 入口 / 资源）    |
| `index.ts`           | 入口，`default` 导出 setup             |
| `TodoPlugin.tsx`     | 面板、命令、事件与钩子接线             |
| `TodoTool.ts`        | `todo_write` 工具与输入解析（纯逻辑）  |
| `TodoPlugin.test.ts` | 工具解析、面板显隐、回合收口规则的测试 |

## 停用它

在配置页 Plugins 里关掉，或者往 `$MICA_HOME/plugins-state.json` 的 `disabled` 里加 `todo`。
停用后 `todo_write` 工具不再注册，模型也就看不到它。
