# plugins/builtin

这里存放随 Mica Code 静态编译发布的官方产品插件和启动扩展。

运行期插件由 `apps/cli/src/app/builtinPlugins.ts` 注册，并通过 `PluginManager` 获得统一的 `PluginContext` 和 dispose 生命周期。Todo、MCP、message queue、文件 mention、通知和斜杠命令属于这一类。

启动扩展由进程入口在特定阶段直接调用，包括配置迁移、Config Web worker、进程诊断、模型规则和用户文件插件发现。它们不经过 `PluginManager`，应自行提供明确的清理接口。

边界约定：

- 产品策略和流程放在这里；通用协议与机制放在 `packages/*`。
- 运行期插件通过 `PluginContext` 的 commands、hooks、services、runtime、tools 和 UI capability 接入 host。
- 不从这里反向导入 `src/**`。需要的新能力先在 package 中定义协议，再由 `src/app` adapter 注入。
- 复杂插件可以使用 TypeScript/TSX；所有官方插件必须被 `builtinPlugins.ts` 静态导入，确保进入单二进制构建。
- 注册 hook、工具、UI 或 provider 后，必须通过 `ctx.onDispose()` 登记清理。
