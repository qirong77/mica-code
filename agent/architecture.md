# 代码地图与依赖边界

## 应用

| 路径               | 职责                                          |
| ------------------ | --------------------------------------------- |
| `apps/cli/`        | CLI 装配、turn loop、headless、app-server     |
| `apps/desktop/`    | Web 运行时、renderer、Electron 容器           |
| `apps/config-web/` | 配置页浏览器宿主：Bun HTTP 服务与内嵌静态资源 |
| `apps/website/`    | Astro 官网                                    |

仓库根的 `plugins/` 是官方插件源码，由 `packages/mica-official-plugins` 静态登记后编译进产物；用户插件装在 `$MICA_HOME/plugins`，格式相同。

## 公共包

以下包均位于 `packages/`。

| 包                            | 职责与限制                                                              |
| ----------------------------- | ----------------------------------------------------------------------- |
| `mica-agent`                  | agent、provider adapter、prompt；不依赖 UI、session、commands 或入口    |
| `mica-runtime`                | runtime 协议、事件、状态、队列原语；不编排 turn loop                    |
| `mica-tools`                  | 唯一工具 registry，接入内置工具、插件工具与 MCP                         |
| `mica-mcp`                    | MCP server 生命周期                                                     |
| `mica-ui`                     | Ink 组件与状态 store；不调用 provider                                   |
| `mica-session`                | 会话快照持久化与 turn lock                                              |
| `mica-config`                 | 配置、本地状态、模型规则、品牌路径                                      |
| `mica-context`                | 压缩（`CompactionService`）；不直接操纵 provider adapter                |
| `mica-commands`               | 通用命令机制                                                            |
| `mica-builtin-commands`       | 产品命令、运行期插件、启动扩展                                          |
| `mica-skills` / `mica-plugin` | skills 扫描解析缓存 / 插件机制与能力面                                  |
| `mica-common`                 | 跨端纯逻辑（loop 参数、引用、消息定位、自动链接、能力开关、会话笔记等） |
| `mica-pty`                    | PTY 驱动与 Node helper；native binding 只在 Node 子进程加载             |
| `mica-web-shared`             | desktop renderer 与运行时共享的展示、状态、搜索、地址约定               |
| `mica-file-mentions`          | CLI / desktop 共用的文件补全触发、扫描、排序、插入                      |
| `mica-config-ui`              | 配置页唯一实现：页面、数据动作、共享类型                                |
| `mica-diagnostics`            | 诊断日志唯一写入器：JSONL 落盘、慢操作聚合、进程内存采样（node-only）   |
| `mica-official-plugins`       | 官方插件目录：`manifests.js` 只含清单，`index.js` 才带入口              |
| `@anthropic/ink`              | 仓库内 vendored 的 Ink 分支：终端渲染原语，`mica-ui` 的唯一 Ink 来源    |

## 边界规则

- 公共 API 从包的 `index.ts` 导出；应用层优先用 `@packages/<name>/index.js`。
- `@packages/*`、`@apps/*` alias 在根 tsconfig；包不得反向依赖 `@apps/*`。
- 底层需要上层能力时，通过类型、回调、service、hook 或 adapter 注入。
- `mica-config` 是配置与本地状态的唯一入口；UI / commands / runtime / adapter 不自行拼路径。
- TypeScript 使用 strict、isolatedModules、verbatimModuleSyntax；类型导入用 `import type`。
- 默认静态导入；进程模式分派、PTY 首次加载、renderer 重模块可按需动态 import。
- 生产代码禁止静态 import `node-pty` 或 `mica-pty/index.js`：native binding 必须保持 external。
- 只想列插件的宿主只 import `mica-official-plugins/manifests.js`，别把插件实现拖进进程。
