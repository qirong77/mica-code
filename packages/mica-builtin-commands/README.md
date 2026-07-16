# mica-builtin-commands

`mica-builtin-commands` 是 Mica Code 的内置斜杠命令包。它只定义命令实现与命令组装逻辑，具体运行时能力通过 command services 注入，避免直接依赖应用入口或 UI 内部状态。

## 主要能力

- 注册产品内置命令，例如：`/cd`、`/model`、`/provider`、`/effort`、`/role`、`/resume`、`/mcp`、`/skills`、`/status`、`/task`、`/context`、`/compact`、`/fork`、`/rewind`、`/diff`、`/commit`、`/new`、`/rename`、`/clear`、`/exit`。
- 提供命令所需的服务类型与注入入口。
- 支持带 UI 面板的命令，例如 `provider`、`resume`、`mcp`、`skills`、`task`。
- 支持运行时控制类命令，例如切换模型/effort、恢复会话、日志导出、上下文压缩、任务切换与分叉；`/task` 会按 session 展示全部 retained subagent 与 active background shell，并可打开任务详情。
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
  index.ts                 公共 API：命令工厂、AgentChangeTracker、services 类型
  services.ts              命令依赖的服务接口定义
  README.md
  commands/                各内置斜杠命令实现
  shared/                  命令间共享辅助逻辑
  git/                     Git 变更追踪与 diff 展示辅助
  tests/                   包内全部测试
```

- `commands/`：`cd`、`clear`、`commit`、`compact`、`config`、`context`、`diff`、`effort`、`exit`、`fork`、`mcp`、`model`、`new`、`provider`、`rename`、`resume`、`rewind`、`role`、`skills`、`status`、`task` 等命令工厂。
- `shared/`：
  - `commandInput.ts`：列表选择键盘导航。
  - `selectCommand.tsx`：通用选择面板。
  - `configSwitch.ts`：provider/model/effort 切换辅助。
  - `agentBackground.ts`：后台 agent 提交辅助。
- `git/`：
  - `agentChangeTracker.ts`：当前 agent 增量文件追踪。
  - `gitDiff.ts`：unified/side-by-side diff 解析与加载。
- `services.ts`：`CommandRuntimeServices` 与相关类型，避免命令直接依赖应用层。
- `index.ts`：稳定公共导出入口；应用层只应从这里引用。
