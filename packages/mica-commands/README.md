# mica-commands

`mica-commands` 是 Mica Code 的斜杠命令注册与路由基础包。它提供通用命令类型、命令注册表和匹配执行能力，不包含具体产品命令。

## 主要能力

- 定义命令元信息、执行上下文和执行结果类型。
- 提供 `CommandRegistry` 用于注册、查找和执行命令。
- 支持命令别名、参数透传和命令列表查询。
- 为应用层和内置命令包提供稳定的命令系统基础。

## 使用入口

```ts
import { micaCommands } from '@packages/mica-commands/index.js';

const registry = new micaCommands.CommandRegistry();
registry.register({
  name: 'hello',
  description: '输出问候',
  handler: async () => ({ type: 'message', message: '你好' }),
});
```

## 设计约束

- 本包只包含通用命令机制，不依赖 UI、agent、session 或配置包。
- Mica Code 的内置命令实现放在 `packages/mica-builtin-commands`。
- 命令处理逻辑应通过上下文或服务注入访问外部能力。

## 目录说明

- `CommandRegistry.ts`：命令注册、查询和执行分发。
- `types.ts`：命令定义、上下文与结果类型。
- `index.ts`：公共 API 聚合导出。
- `examples/`：基础使用示例。
