# mica-plugin

`mica-plugin` 是 Mica Code 的插件基础设施包。它提供插件基类、生命周期管理、hook 注册和服务容器，用于把可扩展能力与核心运行时解耦。

## 主要能力

- 定义 class-based plugin 的基础结构。
- 管理插件加载、启动和销毁生命周期。
- 提供 hook registry，用于扩展运行时流程。
- 提供 service container 和 service token，用于插件间共享能力。

## 使用入口

```ts
import { micaPlugin } from '@packages/mica-plugin/index.js';

class ExamplePlugin extends micaPlugin.Plugin {
  async activate(context) {
    context.hooks.register('afterTurn', async () => {});
  }
}
```

## 设计约束

- 本包只提供插件机制，不包含具体产品插件。
- 插件通过 context、hooks 和 services 与外部交互，避免直接耦合应用层单例。
- 生命周期中注册的资源需要可释放，避免长期运行中的泄漏。

## 目录说明

- `Plugin.ts`：插件基类和生命周期约定。
- `PluginManager.ts`：插件注册、激活和销毁管理。
- `PluginContext.ts`：插件运行上下文。
- `HookRegistry.ts`、`HookTypes.ts`：hook 类型与注册表。
- `ServiceContainer.ts`、`ServiceToken.ts`：服务容器与 token。
- `index.ts`：公共 API 聚合导出。
