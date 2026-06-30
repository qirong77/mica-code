# mica-builtin-commands

`mica-builtin-commands` 是 Mica Code 的内置斜杠命令包。它只定义命令实现与命令组装逻辑，具体运行时能力通过 command services 注入，避免直接依赖应用入口或 UI 内部状态。

## 主要能力

- 注册产品内置命令，例如 `/model`、`/provider`、`/resume`、`/mcp`、`/skills`、`/log`、`/status`、`/context`、`/compact`、`/agents`、`/fork`、`/rewind`、`/commit`、`/clear`。
- 提供命令所需的服务类型与注入入口。
- 支持带 UI 面板的命令，例如 provider、resume、mcp、skills、agents。
- 支持运行时控制类命令，例如切换模型、恢复会话、导出日志、压缩上下文、多 agent 切换与分叉。
- 支持插件命令更新左下角运行状态；耗时且会改上下文/文件的命令应通过 exclusive task 执行，避免用户并发发送对话或切换配置。

## 使用入口

```ts
import { micaBuiltinCommands } from '@packages/mica-builtin-commands/index.js';

const commands = micaBuiltinCommands.createBuiltInCommands(services);
```

## 设计约束

- 命令实现不直接导入应用层单例；需要的能力由 `services` 注入。
- 通用命令注册能力放在 `packages/mica-commands`，本包只放 Mica Code 的内置产品命令。
- 涉及 UI 的命令只负责创建面板或触发交互，不持有长期运行状态。

## 目录说明

- `index.ts`：内置命令统一导出与创建入口。
- `services.ts`：命令依赖的服务接口定义。
- `model.ts`、`provider.tsx`：模型与 provider 切换命令。
- `resume.ts`：会话恢复命令。
- `mcp.tsx`、`skills.tsx`：MCP 与 skills 管理命令。
- `agents.tsx`、`fork.ts`、`rewind.tsx`：多 agent、分叉与回退相关命令。
- `compact.ts`：上下文压缩命令。
- `log.tsx`、`status.tsx`、`context.tsx`：日志查看、日志导出、状态查看与上下文总览命令。
- `commit.ts`、`gitDiffContext.ts`：提交辅助命令。
