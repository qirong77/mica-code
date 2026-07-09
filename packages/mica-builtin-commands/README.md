# mica-builtin-commands

`mica-builtin-commands` 是 Mica Code 的内置斜杠命令包。它只定义命令实现与命令组装逻辑，具体运行时能力通过 command services 注入，避免直接依赖应用入口或 UI 内部状态。

## 主要能力

- 注册产品内置命令，例如：`/model`、`/provider`、`/effort`、`/resume`、`/mcp`、`/skills`、`/log`、`/status`、`/task`、`/context`、`/doctor`、`/compact`、`/fork`、`/rewind`、`/review`、`/commit`、`/copy`、`/new`、`/recap`、`/rename`、`/memoryUsage`、`/git-diff-context`、`/clear`、`/exit`。
- 提供命令所需的服务类型与注入入口。
- 支持带 UI 面板的命令，例如 `provider`、`resume`、`mcp`、`skills`、`task`。
- 支持运行时控制类命令，例如切换模型/effort、恢复会话、日志导出、上下文压缩、任务切换与分叉。
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

- `index.ts`：内置命令创建工厂导出。
- `services.ts`：命令依赖的服务接口定义。
- `model.ts`、`provider.tsx`：模型与 provider 切换命令。
- `effort.ts`：effort 切换命令。
- `configSwitch.ts`：配置切换时的辅助函数。
- `context.tsx`：上下文汇总与展示命令。
- `exit.ts`：退出命令。
- `copy.ts`：复制当前会话文本命令。
- `new.ts`：新建会话命令。
- `rename.ts`：会话重命名命令。
- `recap.ts`：会话摘要命令。
- `gitDiffContext.ts`：基于 git diff 的上下文命令。
- `memoryUsage.tsx`：内存监控命令。
- `resume.ts`：会话恢复命令。
- `mcp.tsx`、`skills.tsx`：MCP 与 skills 管理命令。
- `task.tsx`、`fork.ts`、`rewind.tsx`：多任务、分叉与回退相关命令。
- `compact.ts`：上下文压缩命令。
- `log.tsx`、`status.tsx`、`context.tsx`、`doctor.tsx`：日志查看、日志导出、状态查看、上下文总览与环境诊断命令。
- `review.ts`、`commit.ts`：代码审查与提交辅助命令。
