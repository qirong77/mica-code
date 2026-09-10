# mica-web-shared

`apps/desktop` renderer 与运行时共用的展示纯逻辑，只包含无副作用函数：无 React、无运行时依赖，两个构建管线（Vite + TS、electron-vite renderer）都可以直接消费。

## 内容

- `time.ts`：`relativeTimeShort`（紧凑相对时间，desktop 会话列表用）。
- `format.ts`：`formatTokens`（token 紧凑格式化，可用 `millionDecimals` 保留消费端原有的百万级精度）。
- `tools.ts`：`toolIcon` / `toolLabel`（内置工具 emoji 图标与展示名；MCP 工具统一渲染为 `[MCP:server] tool`，hash 后缀剥离）。desktop 的 turn-log 工具行与 chat 工具行共用这套词汇，保证同一工具展示一致。

## 接入方式

- `apps/desktop`：`apps/desktop/electron.vite.config.mjs` 的 renderer `resolve.alias` 已配置 `@packages` 指向仓库根 `packages/`，renderer 内直接 `import ... from '@packages/mica-web-shared'`。
