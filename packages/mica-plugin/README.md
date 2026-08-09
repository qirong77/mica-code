# mica-plugin

`mica-plugin` 是 Mica Code 的插件基础设施包。它提供插件基类、生命周期管理、hook 注册和服务容器，用于把可扩展能力与核心运行时解耦。

## 主要能力

- 定义 class-based plugin 的基础结构。
- 管理插件加载、启动和销毁生命周期。
- 提供 hook registry，用于扩展运行时流程。
- 提供 service container 和 service token，用于插件间共享能力。
- 定义 `PluginContext` capability，由应用注入 runtime queue、工具注册和 UI 扩展入口。

## 使用入口

```ts
import { micaPlugin } from '@packages/mica-plugin/index.js';

class ExamplePlugin extends micaPlugin.Plugin {
  constructor() {
    super({ id: 'example' });
  }

  setup(context) {
    const hook = context.hooks.on('turn:after', async () => {});
    context.onDispose(() => hook.dispose());
  }
}
```

### System prompt 扩展

`system-prompt:build` 是同步 pipeline hook，在 provider 每次解析 system prompt 时执行。handler 必须同步返回，事件结构为 `{ runtime, prompt }`：

```ts
const hook = context.hooks.on('system-prompt:build', (event: { runtime: unknown; prompt: string }) => ({
  event: {
    ...event,
    prompt: `${event.prompt}\n\nPlugin system guidance.`,
  },
}));

context.onDispose(() => hook.dispose());
```

这个 hook 只修改 system prompt，不会写入 user message 或 session provider history。显式传入自定义 system prompt 的 subagent 不经过该扩展点。

## 设计约束

- 本包只提供插件机制，不包含具体产品插件。
- 插件通过 context、hooks 和 services 与外部交互，避免直接耦合应用层单例。
- 官方运行期插件位于 `plugins/builtin`，不应反向导入 `src/**`。
- 生命周期中注册的资源需要可释放，避免长期运行中的泄漏。

## 目录说明

- `Plugin.ts`：插件基类和生命周期约定。
- `PluginManager.ts`：插件注册、激活和销毁管理。
- `PluginContext.ts`：插件运行上下文。
- `HookRegistry.ts`、`HookTypes.ts`：hook 类型与注册表。
- `ServiceContainer.ts`、`ServiceToken.ts`：服务容器与 token。
- `index.ts`：公共 API 聚合导出。
