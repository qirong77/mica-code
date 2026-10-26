# mica-plugin

`mica-plugin` 是 Mica Code 的插件基础设施包。它提供插件基类、生命周期管理、hook 注册和服务容器，用于把可扩展能力与核心运行时解耦。

## 主要能力

- 定义 class-based plugin 的基础结构。
- 管理插件加载、启动和销毁生命周期。
- 提供 hook registry，用于扩展运行时流程。
- 提供 service container 和 service token，用于插件间共享能力。
- 定义 `PluginContext` capability，由应用注入 runtime queue、工具注册和 UI 扩展入口。
- 定义插件包格式：`plugin.json` 清单（id / name / version / main / assets / dependencies / required / apiVersion）、目录加载器与只读扫描（配置页用）。
- 维护启停状态（`$MICA_HOME/plugins-state.json`），停用的插件在启动阶段就不注册。
- 插件设置：清单里声明 `settings` 字段，值存 `$MICA_HOME/plugin-settings/<id>.json`，插件用 `ctx.settings.get()` 读。
- 插件日志：`ctx.logger` 自带文件输出，落在系统临时目录并按天分片、按大小轮转。

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
- 官方运行期插件位于 `packages/mica-builtin-commands/plugins` 与仓库根 `plugins/`，都不应反向导入 `src/**`。
- 插件包格式见仓库根 `plugins/README.md`：一个插件是一个目录，入口 `default` 导出 `setup(ctx)`。
- 生命周期中注册的资源需要可释放，避免长期运行中的泄漏。

## 目录说明

- `Plugin.ts`：插件基类和生命周期约定。
- `PluginManager.ts`：插件注册、激活和销毁管理。
- `PluginContext.ts`：插件运行上下文。
- `HookRegistry.ts`、`HookTypes.ts`：hook 类型与注册表。
- `ServiceContainer.ts`、`ServiceToken.ts`：服务容器与 token。
- `PluginManifest.ts`：`plugin.json` 的类型、解析与路径越界校验。
- `FilePluginLoader.ts`：扫描 `$MICA_HOME/plugins/<id>/`，以及不执行代码的 `inspectPlugins`。没有 `plugin.json` 的目录和散落的 `.js` / `.mjs` 都不算插件。
- `PluginState.ts`：启停状态文件的读写。
- `PluginSettings.ts`：设置项的声明类型、规范化读写与按 mtime 刷新的 store，供配置页与插件共用。
- `PluginLog.ts`：插件文件日志（`os.tmpdir()/mica-logs/plugin-<id>-<day>[-n].jsonl`），带分片与过期清理。
- `index.ts`：公共 API 聚合导出。
