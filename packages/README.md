# packages

`packages/` 存放 Mica Code 的内部可复用包。主应用装配逻辑在 `src/`，这里的包主要负责沉淀稳定的领域能力和公共 API。

## 包说明

- `mica-agent`：agent 抽象、模型 provider adapter、prompt 构建。
- `mica-tools`：内置工具、工具 registry、MCP 工具接入。
- `mica-mcp`：MCP 配置读取、server 连接管理和工具注册。
- `mica-ui`：Ink 终端 UI 组件和 UI 状态。
- `mica-runtime`：运行时协议、事件、状态、输入、消息队列和 OpenCode/DevEco-compatible run JSON schema。
- `mica-session`：会话快照的本地保存、读取和列表。
- `mica-config`：本地配置读写和 provider 模型列表加载。
- `mica-commands`：通用斜杠命令注册与分发。
- `mica-builtin-commands`：Mica Code 内置产品命令。
- `mica-context`：上下文管理能力，当前主要是 compact。
- `mica-skills`：用户 skills 的扫描、解析和缓存。
- `mica-plugin`：插件生命周期、hooks 和 service container。
- `mica-common`：跨包共享的底层工具。

## 包规范

- 每个包通过 `index.ts` 暴露公共 API，应用层优先从 `index.ts` 引用。
- 子包 README 需要说明包职责、主要能力、使用入口和目录结构。
- 包内实现应保持职责单一，不把应用装配逻辑塞进 package。
- 新增公共能力时同步更新对应包的 README 和导出入口。
- 不使用动态导入。
- import 路径风格保持与所在文件周边一致。

## 依赖边界

- `mica-common` 不依赖任何产品业务包。
- `mica-agent` 不依赖 UI、session、commands 或应用入口。
- `mica-ui` 不直接调用模型 provider，不持有 agent 运行逻辑。
- `mica-runtime` 只定义协议和状态原语，不做具体 turn loop 编排。
- `mica-commands` 只放通用命令机制，产品命令放在 `mica-builtin-commands`。
- `mica-builtin-commands` 通过 services 注入外部能力，避免直接导入应用层单例。
- `mica-tools` 统一管理工具定义和执行，MCP 工具也必须通过它注册。
- `mica-session` 只负责持久化，不调用模型、不渲染 UI。
- `mica-plugin` 只提供插件机制，不内置具体产品插件。

如果新增代码会导致底层包依赖上层包，应优先通过类型、回调、service 或 adapter 注入能力。

## 验证

修改 packages 后至少运行：

```bash
bunx tsc --noEmit
```
