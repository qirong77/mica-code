# mica-web-shared

`apps/sync/web` 与 `apps/desktop` renderer 共用的 Web 展示纯逻辑，只包含无副作用函数：无 React、无运行时依赖，两个构建管线（Vite + TS、electron-vite renderer）都可以直接消费。

## 内容

- `time.ts`：`formatTime` / `formatRelative`（中文相对时间，sync web 用）与 `relativeTimeShort`（紧凑相对时间，desktop 会话列表用）。
- `format.ts`：`formatTokens`（token 紧凑格式化，可用 `millionDecimals` 保留消费端原有的百万级精度）与 `formatStatus`（sync turnState 徽标）。

## 接入方式

- `apps/sync/web`：通过根 tsconfig `@packages/*` alias + vite alias 引入。
- `apps/desktop`：`apps/desktop/electron.vite.config.mjs` 的 renderer `resolve.alias` 已配置 `@packages` 指向仓库根 `packages/`，renderer 内直接 `import ... from '@packages/mica-web-shared'`。
