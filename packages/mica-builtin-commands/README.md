# mica-builtin-commands

`mica-builtin-commands` 是 Mica Code 的内置斜杠命令基础包。它定义共享命令实现、command host 契约与运行时服务类型；已经插件化的命令实现位于仓库根目录的 `buildin-plugins/*.mjs`。

## 主要能力

- 提供尚未迁移的产品内置命令实现，例如：`/model`、`/effort`、`/role`、`/mcp`、`/skills`、`/status`、`/task`、`/context`、`/commit`。
- 通过 `CommandHostService` 支持 `buildin-plugins` 中的 `/cd`、`/clear`、`/compact`、`/exit`、`/fork`、`/new`、`/rename`、`/resume`、`/rewind` 单文件插件。
- 提供命令所需的服务类型与注入入口。
- 支持带 UI 面板的命令，例如 `model`、`resume`、`mcp`、`skills`、`task`。
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
  index.ts                 公共 API：命令工厂、AgentChangeTracker、commit 分析辅助、services 类型
  commandHost.ts           单文件命令插件使用的宿主服务契约
  services.ts              命令依赖的服务接口定义
  README.md
  commands/                各内置斜杠命令实现
  shared/                  命令间共享辅助逻辑
  git/                     Git 变更追踪与提交辅助
  tests/                   包内全部测试
```

- `commands/`：`commit`、`config`、`context`、`effort`、`mcp`、`model`、`provider`、`role`、`skills`、`status`、`task` 等尚未迁移的命令工厂。
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
