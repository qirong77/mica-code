# mica-builtin-commands

`mica-builtin-commands` 是 Mica Code 的内置命令与官方插件包。它定义全部产品命令实现（`commands/`）、运行期插件装配（`plugins/`，含 `command-*.ts`、Todo、MCP、message queue、文件 mention、session-autonomy、context-pressure、loop）、启动扩展（`startup/`，validate-config、process-diagnostics、file-plugins、model-effort-context）以及 command host 契约与运行时服务类型。运行期插件与启动扩展统一从本包 `index.ts` 导出。

## 主要能力

- 提供全部产品内置命令实现：`/cd`、`/clear`、`/compact`、`/exit`、`/fork`、`/model`、`/effort`、`/role`、`/mcp`、`/skills`、`/status`、`/task`、`/context`、`/commit`、`/new`、`/rename`、`/resume`、`/rewind`、`/loop`。
- 通过 `CommandHostService` 支持 `plugins/command-*.ts` 装配层注册全部命令（TUI 与 headless 共用）。
- 提供命令所需的服务类型与注入入口。
- 支持带 UI 面板的命令，例如 `model`、`resume`、`mcp`、`skills`、`task`。
- 支持运行时控制类命令，例如切换模型/effort、恢复会话、日志导出、上下文压缩、任务切换与分叉、定时循环任务（`/loop`，每轮执行前自动做一次本地压缩）；`/task` 会按 session 展示全部 retained subagent 与 active background shell，并可打开任务详情。
- 导出 `cycleNextRole`，供输入框 `Shift+Tab` 快捷键循环切换 role。
- 支持通过 `exclusive task` 执行耗时且会改上下文/文件的命令，避免用户并发切换配置导致状态抖动。

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
  index.ts                 公共 API：命令工厂、AgentChangeTracker、commit 分析辅助、services 类型
  commandHost.ts           单文件命令插件使用的宿主服务契约
  services.ts              命令依赖的服务接口定义
  README.md
  commands/                各内置斜杠命令实现
  shared/                  命令间共享辅助逻辑
  git/                     Git 变更追踪与提交辅助
  tests/                   包内全部测试
```

- `commands/`：全部命令工厂，`cd`、`clear`、`compact`、`commit`、`config`、`context`、`effort`、`exit`、`fork`、`loop`（含 loop 工具）、`mcp`、`model`、`new`、`rename`、`resume`、`rewind`、`role`、`skills`、`status`、`task`。
- `shared/`：
  - `commandInput.ts`：列表选择键盘导航。
  - `selectCommand.tsx`：通用选择面板。
  - `configSwitch.ts`：provider/model/effort 切换辅助。
- `git/`：
  - `agentChangeTracker.ts`：当前 agent 增量文件追踪。
  - `commitRunner.ts`：commit 命令与 headless `mica commit` 共享的确定性 git 分析/提交逻辑（变更摘要、commit message 生成、add/commit/push），公共入口由 `index.ts` 聚合导出。
- `services.ts`：`CommandRuntimeServices` 与相关类型，避免命令直接依赖应用层。
- `commandHost.ts`：向单文件命令插件暴露 active agent、session controller、runtime services 和统一注册函数。
- `index.ts`：稳定公共导出入口；应用层只应从这里引用。
