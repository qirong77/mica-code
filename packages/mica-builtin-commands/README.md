# mica-builtin-commands

`mica-builtin-commands` 是 Mica Code 的内置命令与官方插件包。它定义全部产品命令实现（`commands/`）、运行期插件装配（`plugins/`，含 `command-*.ts`、MCP、message queue、文件 mention、`command-memory.ts` 的会话记忆指引、`mica-code-app-notify.ts`、session-autonomy、loop）、启动扩展（`startup/`，validate-config、process-diagnostics、file-plugins、model-effort-context）以及 command host 契约与运行时服务类型。运行期插件与启动扩展统一从本包 `index.ts` 导出。

## 主要能力

- 提供全部产品内置命令实现：`/cd`、`/clear`、`/compact`、`/config`、`/exit`、`/fork`、`/model`、`/effort`、`/role`、`/capabilities`、`/mcp`、`/skills`、`/status`、`/task`、`/context`、`/new`、`/rename`、`/resume`、`/rewind`、`/loop`。`/commit` 由官方插件 `plugins/commit`、`/btw` 由官方插件 `plugins/btw` 提供，不在本包；本包只保留它们共用的 `shared/btwThread.ts`。
- `/harness-review list|report|assess <id> <状态> <依据>` 由官方插件 `plugins/harness-review` 提供：查看当前工作区运行复盘、导出报告、记录人工评估；运行中可用。
- 通过 `CommandHostService` 支持 `plugins/command-*.ts` 装配层注册全部命令（TUI 与 headless 共用）。
- 提供命令所需的服务类型与注入入口。
- 支持带 UI 面板的命令，例如 `model`、`resume`、`mcp`、`skills`、`task`。
- 支持运行时控制类命令，例如切换模型/effort、恢复会话、日志导出、上下文压缩、任务切换与分叉、定时循环任务（`/loop`，每轮执行前自动做一次本地压缩）；`/task` 会按 session 展示全部 retained subagent 与 active background shell，并可打开任务详情。
- 导出 `cycleNextRole`，供输入框 `Shift+Tab` 快捷键循环切换 role。
- 支持通过 `exclusive task` 执行耗时且会改上下文/文件的命令，避免用户并发切换配置导致状态抖动。
- `plugins/file-mention.ts` 只做输入框 `@` 补全的装配（预热门 + provider），触发、工作区扫描、排序与插入文本都在 `packages/mica-file-mentions`（桌面端输入框引用同一份）。

## 使用入口

```ts
import { micaBuiltinCommands } from '@packages/mica-builtin-commands/index.js';

// 示例：按需组合内置命令工厂函数。
const activeAgent = {} as never;
const activeSessionController = {} as never;
const services = {} as never;
const commands = [
  micaBuiltinCommands.createModelCommand(activeAgent, activeSessionController, services),
  micaBuiltinCommands.createEffortCommand(activeAgent, activeSessionController, services),
  micaBuiltinCommands.createStatusCommand(activeAgent),
];
```

## 设计约束

- 命令实现不直接导入应用层单例；需要的能力由 `services` 注入。
- 通用命令注册能力放在 `packages/mica-commands`，本包只放 Mica Code 的内置产品命令。
- 涉及 UI 的命令只负责创建面板或触发交互，不持有长期运行状态。

## 目录说明

```text
packages/mica-builtin-commands/
  index.ts                 公共 API：命令工厂、services 类型
  commandHost.ts           单文件命令插件使用的宿主服务契约
  services.ts              命令依赖的服务接口定义
  README.md
  commands/                各内置斜杠命令实现
  shared/                  命令间共享辅助逻辑
  tests/                   包内全部测试
```

- `commands/`：全部命令工厂，`capabilities`、`cd`、`clear`、`compact`、`config`、`context`、`effort`、`exit`、`fork`、`loop`（含 loop 工具）、`mcp`、`model`、`new`、`rename`、`resume`、`rewind`、`role`、`skills`、`status`、`task`。
- `shared/`：
  - `commandInput.ts`：列表选择键盘导航。
  - `selectCommand.tsx`：通用选择面板。
  - `configSwitch.ts`：provider/model/effort 切换辅助。
  - `btwThread.ts`：旁问线程的纯逻辑（对话记录、system prompt 拼装、子代理线程构造），`plugins/btw` 与 desktop「By The Way」抽屉共用。
  - `ScrollableCommandDialog.tsx`：命令面板共用的滚动容器与滚动控制器。
- `services.ts`：`CommandRuntimeServices` 与相关类型，避免命令直接依赖应用层。
- `subagentUsage.ts`：helper 子代理（desktop 旁问抽屉 / compact 摘要）的用量记账入口（`recordHelperSubagentUsage`），写进当前会话的 `subagentUsageHistory`；`/btw` 命令的用量由插件线程的宿主记账（`origin: 'plugin'`）。
- `commandHost.ts`：向单文件命令插件暴露 active agent、session controller、runtime services 和统一注册函数。
- `index.ts`：稳定公共导出入口；应用层只应从这里引用。
