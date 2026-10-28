# Todo

回合内的运行计划：`todo_write` 工具、`/todo` 命令和一段常驻状态面板。

## 它做什么

- `todo_write` 让模型把本轮计划写成条目（`pending` / `in_progress` / `completed`）。
  工具只改内存，不写会话文件——「本轮计划」的边界就是这一轮。
- **宿不改写模型给的状态。** 回合正常结束只是说明模型收尾了，不代表剩下的事做完了：
  未完成项仍然是未完成。唯一被修正的是展示投影——回合结束后 `in_progress` 显示为
  `pending`（已经没有东西还在进行），而 `pending` 不会被升成完成。
- **计划属于一轮，面板也属于一轮**：这一轮一结束就收起，新一轮开始时上一轮的清单
  直接作废。历史里的 `todo_write` 不算数，不会被重新显示成当前进度——这是「残留」
  的主要来源。
- 全部完成时在运行中仍显示（收成一行 `all done`），收起由轮次结束负责，不由「做完了」负责。
- `/todo [show|hide|clear]` 控制面板显隐与清空。`/todo show` 在轮次结束后也能打开，
  但那些条目已不再执行，`in_progress` 会按 `pending` 呈现，不会再出现假的进行中。
- **计划纪律跟着插件走**：什么时候该写计划、条目怎么切、状态怎么维护，作为 `plan`
  段落经 `ctx.prompt.section()` 注入 system prompt（正文在 `prompt.ts`）。停用插件后
  工具和这段指引一起消失，不会出现「提示词要求写计划、工具却不在工具表里」。所以
  清单的 `requires` 里有 `prompt`，排在委派段落（`plugins/subagent`，order 100）之前。

## 工具契约

约束放在 schema 与工具描述里，执行期只做归一化：拒绝一整个调用会让模型白跑一轮并
多烧一次上下文，换来的只是格式干净。

| 情况                            | 处理                                      |
| ------------------------------- | ----------------------------------------- |
| `todos` 不是数组 / 入参不是对象 | 报错（结构上根本不是一份清单）            |
| 未知字段                        | 忽略                                      |
| `content` 为空                  | 丢弃该条目并说明                          |
| `status` 非法                   | 按 `pending` 处理并说明                   |
| 多个 `in_progress`              | 只保留第一个，其余降级为 `pending` 并说明 |
| 超过 20 项 / 单条超过 240 字符  | 截断并说明                                |

`activeForm`（进行时文案）与 `id` 都是可选的：中文没有进行时变形，必填只会逼模型把
同一句话写两遍；`id` 缺省时由内容派生。

## 两端共用一份规则

`packages/mica-common/todoState.ts` 是解析归一化、清单投影、显示规则与回显格式的
唯一实现，TUI 面板与 desktop 的计划 dock 都读它。desktop 的计划从对话里的
`todo_write` 工具行投影（`todoSnapshotFromMessages`），所以重开先前没关掉的会话时
它还在，而关掉再打开就没有了——这与「本轮计划」的定位一致。

需要长期留存的待办请用会话笔记（`session_notes`）：它在对话历史之外，压缩动不到、
resume 带得回来。

## 文件

| 文件                 | 作用                                   |
| -------------------- | -------------------------------------- |
| `plugin.json`        | 插件清单（id / 版本 / 入口 / 资源）    |
| `index.ts`           | 入口，`default` 导出 setup             |
| `TodoPlugin.tsx`     | 面板、命令、事件与钩子接线             |
| `TodoTool.ts`        | `todo_write` 工具定义                  |
| `prompt.ts`          | `plan` prompt 段落正文（计划纪律）     |
| `TodoPlugin.test.ts` | 归一化规则、投影、面板显隐与收口的测试 |

纯逻辑在 `packages/mica-common/todoState.ts`（含自己的测试）。

## 停用它

在配置页 Plugins 里关掉，或者往 `$MICA_HOME/plugins-state.json` 的 `disabled` 里加 `todo`。
停用后 `todo_write` 工具不再注册，模型也就看不到它。
