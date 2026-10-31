# mica-web-shared

`apps/desktop` renderer 与运行时共用的展示纯逻辑，只包含无副作用函数：无 React、无运行时依赖，两个构建管线（Vite + TS、electron-vite renderer）都可以直接消费。

## 内容

- `time.ts`：`relativeTimeShort`（紧凑相对时间，desktop 会话列表用）。
- `format.ts`：`formatTokens`（token 紧凑格式化，可用 `millionDecimals` 保留消费端原有的百万级精度）。
- `tools.ts`：`toolIcon` / `toolLabel`（内置工具 emoji 图标与展示名；MCP 工具统一渲染为 `[MCP:server] tool`，hash 后缀剥离）。desktop 的 turn-log 工具行与 chat 工具行共用这套词汇，保证同一工具展示一致。
- `session-search.ts`：侧栏会话搜索的匹配、打分与片段切片，运行时（会话文件内容搜索）和页面（标题/目录匹配 + 高亮）共用一份；折叠是长度保持的，所以高亮区间能直接切原文。
- `ui-state.ts`：界面状态补丁的键合法性、合并与「值是否真的变化」判定，运行时持久化广播与页面共用一份，避免一侧认为没变、另一侧却按新值重渲染。
- `runtime-port.js`：端口常量的唯一出口。`DEFAULT_RUNTIME_PORT`（8787）、`RUNTIME_PORT_ENV`（`MICA_DESKTOP_PORT`）、`parseRuntimePort`（非法值落回默认）、`loopbackRuntimeUrl` / `DEFAULT_RUNTIME_URL`（「本机」地址），外加 Config Web 的 `DEFAULT_CONFIG_WEB_PORT`（13987）与 `CONFIG_WEB_PORT_ENV`。桌面运行时、Electron 外壳、renderer、Vite dev 代理与 `scripts/*.mjs` 都从这里取，别再各写一份字面量。纯 JS 带 JSDoc：node 直跑的脚本也要 import 它。
- `app-paths.ts`：单端口上的路径约定（`/`、`/mica-web`、`/share`、`/files`、`/terminal-control`、`toAssetPath` 等），路由与页面都按它拼地址。
- `usage-source.ts`：一次模型请求的来源分类（`main` 主对话 / `delegation` 委派 / `plugin` 插件 / `helper` 内核后台）与展示名。`usageSourceOf(record)` 是唯一判定入口，desktop 运行时的日行聚合（`host/stats-core.js`）和会话详情弹窗都调它。
- `usage-ledger.ts`：无会话模型请求账本（`$MICA_HOME/usage-ledger.jsonl`）的条目形状与 `parseUsageLedger`。CLI 写入（`mica commit` 这类一次性命令）、desktop 运行时读取，两边共用一份解析。

## 接入方式

- `apps/desktop`：`apps/desktop/electron.vite.config.mjs` 的 renderer `resolve.alias` 已配置 `@packages` 指向仓库根 `packages/`，renderer 内直接 `import ... from '@packages/mica-web-shared'`。
- `apps/config-web`：走根 `tsconfig` 的 `@packages/*` alias，`import { DEFAULT_CONFIG_WEB_PORT } from '@packages/mica-web-shared/index.js'`。
