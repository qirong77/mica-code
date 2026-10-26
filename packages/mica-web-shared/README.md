# mica-web-shared

`apps/desktop` renderer 与运行时共用的展示纯逻辑，只包含无副作用函数：无 React、无运行时依赖，两个构建管线（Vite + TS、electron-vite renderer）都可以直接消费。

## 内容

- `time.ts`：`relativeTimeShort`（紧凑相对时间，desktop 会话列表用）。
- `format.ts`：`formatTokens`（token 紧凑格式化，可用 `millionDecimals` 保留消费端原有的百万级精度）。
- `tools.ts`：`toolIcon` / `toolLabel`（内置工具 emoji 图标与展示名；MCP 工具统一渲染为 `[MCP:server] tool`，hash 后缀剥离）。desktop 的 turn-log 工具行与 chat 工具行共用这套词汇，保证同一工具展示一致。
- `runtime-port.js`：端口常量的唯一出口。`DEFAULT_RUNTIME_PORT`（8787）、`RUNTIME_PORT_ENV`（`MICA_DESKTOP_PORT`）、`parseRuntimePort`（非法值落回默认）、`loopbackRuntimeUrl` / `DEFAULT_RUNTIME_URL`（「本机」地址），外加 Config Web 的 `DEFAULT_CONFIG_WEB_PORT`（13987）与 `CONFIG_WEB_PORT_ENV`。桌面运行时、Electron 外壳、renderer、Vite dev 代理与 `scripts/*.mjs` 都从这里取，别再各写一份字面量。纯 JS 带 JSDoc：node 直跑的脚本也要 import 它。
- `app-paths.ts`：单端口上的路径约定（`/`、`/mica-web`、`/share`、`/files`、`/terminal-control`、`toAssetPath` 等），路由与页面都按它拼地址。

## 接入方式

- `apps/desktop`：`apps/desktop/electron.vite.config.mjs` 的 renderer `resolve.alias` 已配置 `@packages` 指向仓库根 `packages/`，renderer 内直接 `import ... from '@packages/mica-web-shared'`。
- `apps/config-web`：走根 `tsconfig` 的 `@packages/*` alias，`import { DEFAULT_CONFIG_WEB_PORT } from '@packages/mica-web-shared/index.js'`。
