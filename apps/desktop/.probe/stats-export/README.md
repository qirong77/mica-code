# Arco 方案离线预览

将相邻的 `stats-design` 或 `digest-design` 导出为不依赖服务的单文件 HTML。只编译隔离的方案探针，不构建桌面 App、CLI 或配置页，不启动服务，也不读取真实数据。

## Run

Use the existing desktop Node dependencies; no new package is required. From the repository root:

```sh
node apps/desktop/.probe/stats-export/export.mjs
node apps/desktop/.probe/stats-export/export.mjs digest-design
```

The command loads the selected probe's `vite.config.mjs` through Vite's JavaScript API and compiles only that probe's `index.html` entry. Its configuration loader runs in memory, `build.write` is disabled, and no temporary build directory or product `out/` directory is written. The only output is the selected probe's `preview.html`; running the command again replaces that preview.

Open the generated file directly in a browser. The probe's existing URL-search initialization remains unchanged, so links can select a candidate and theme, for example:

```text
file:///absolute/path/to/stats-design/preview.html?variant=b&theme=dark
```

The source probe is responsible for reading `variant=a|b|c` and `theme=light|dark` from `window.location.search`. Keep all UI interactions local to its React state. Neither the exporter nor the generated HTML provides or calls `window.mica`; the generated page also blocks network connections with a Content Security Policy.

The exporter keeps the source HTML body, body class and `#root`, removes its `main.jsx` script entry and stylesheet links, and reconstructs a minimal head. Compiled JavaScript and CSS are safely embedded in the file. Referenced SVG, PNG and font assets are converted to data URLs. Extra JavaScript chunks, external module imports, remaining CSS URLs/imports and unsupported or unreferenced resources cause an error rather than being silently dropped. Failures exit nonzero without replacing the preview.

## Syntax check only

```sh
node --check apps/desktop/.probe/stats-export/export.mjs
```

This check does not execute Vite or generate a preview.
