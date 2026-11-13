# Mica Code Desktop 与 Web 运行时

Desktop 和独立浏览器工作区共用一份 React 页面与 Node HTTP/SSE 运行时。Electron 提供原生窗口、受控浏览器、终端控制与系统权限检查；浏览器入口提供对话、文件、Git、设置和工作区终端。会话与 CLI 共用 `$MICA_HOME/sessions/`，默认位于 `~/.mica`。

使用指南见 [桌面与浏览器](https://qirong77.github.io/mica-code/docs/desktop/)；开发前阅读 [维护者手册](../../AGENT.md)。本页保留启动、验证与源码导航，运行时细节以对应模块文档为准。

## 安装与开发

准备 Bun、Node.js 22.19+ 和 npm。在仓库根安装依赖后，进入本目录：

```bash
# 仓库根目录
bun install

cd apps/desktop
npm install
npm run dev
```

`npm run dev` 先构建 Web 运行时，再启动 Electron 与 Vite。页面通过同源 `/api` 与 SSE 调用运行时。桌面端通过 `resolveMicaExecutable()` 调用已安装的 CLI；修改 CLI 源码后需自行重新构建 CLI，并在需要时用 `MICA_CLI_PATH` 指向独立安装入口。包含隔离安装目录的完整示例见 [项目 README](../../README.md#桌面与浏览器)。

## 验证

```bash
# 本目录：全部 host / renderer / main 测试
npm test

# 只验证相关文件或目录
npm test -- src/host/git-watch.test.js
npm test -- src/renderer/src

# 仓库根目录：CLI 与共享包
bun run typecheck
bun run test -- packages/mica-agent/providers/piModelClient.test.ts
```

桌面测试由 `scripts/run-tests.mjs` 启动 Bun，默认 4 个并行 worker、每项 20 秒超时。父进程先隔离全局 Git 配置与本机 Git 包装程序，避免临时仓库里的提交执行开发机 hooks；测试结束清理临时 PATH 入口。单靠 worker 中的 preload 修改环境，无法隔离 Bun 并行测试的默认子进程环境。

测试与调试使用独立 `MICA_HOME`。启动隔离桌面实例还需独立 `MICA_DESKTOP_USER_DATA`、`MICA_DESKTOP_PORT` 与 `--user-data-dir`，详见 [构建与验证约定](../../agent/build.md)。可重复使用的界面探针集中在 [.probe/](./.probe/README.md)。

## 构建与运行

以下命令在本目录执行。构建会产出新文件；运行中的应用何时重启由开发者决定。

| 命令 | 结果 |
| --- | --- |
| `npm run build` | 并行构建并安装 CLI、构建 Electron 外壳/renderer、构建 Web 运行时 |
| `npm run build:server` | 只构建 `out/server/index.mjs` |
| `npm run build:app` | 完整构建、打包本机 `.app` 并执行本机快速签名 |
| `npm run pack:app` | 将现有产物打包为应用目录，跳过 electron-builder 签名 |
| `npm run sign:app` | 对现有 `.app` 执行本机签名；无证书时跳过 |
| `npm run build:mac` | 完整构建并生成 macOS 发布包 |
| `npm run build:win` / `build:linux` | 构建对应平台发布包 |
| `npm run start:web` | 启动已有的 Web 运行时 |

`build` 会调用根目录的 `bun run build`，默认更新 `~/.local/lib/mica` 与 `~/.local/bin/mica`。保留发布版时使用根 README 中的独立安装目录。构建锁、macOS 签名与跨平台条件只在 [agent/build.md](../../agent/build.md) 维护。

独立 Web 工作区需要已有的 renderer 和 server 产物：

```bash
npm run start:web -- --host 127.0.0.1 --port 8787 --no-share
```

默认监听地址为 `0.0.0.0:8787`。运行参数包括 `--host`、`--port`、`--renderer`、`--no-share` 与 `--allow-missing-renderer`；对应环境变量为 `MICA_DESKTOP_HOST`、`MICA_DESKTOP_PORT`、`MICA_DESKTOP_RENDERER`、`MICA_DESKTOP_SHARING`。端口占用时以启动日志中的实际地址为准；`GET /api/health` 返回运行时指纹。

远程访问没有账号体系。完整运行时 API 可以在宿主读写文件、运行命令；仅本机使用时绑定 `127.0.0.1`。LAN、口令与分享链接的访问范围见 [远程与手机访问](https://qirong77.github.io/mica-code/docs/remote-access/) 和 [agent/desktop.md](../../agent/desktop.md#共享状态与路由)。

## 源码边界

| 路径 | 职责 |
| --- | --- |
| `src/host/` | 对话宿主、文件、Git、统计、工作区终端与持久化等业务 |
| `src/server/index.js` | 托管页面，提供 `/api/invoke` 与 SSE，实施访问守卫 |
| `src/main/` | Electron 容器、导航、窗口生命周期、浏览器/终端控制、系统检查 |
| `src/preload/index.js` | 固定的 `window.micaClient` 客户端能力桥 |
| `src/renderer/` | 页面、HTTP/SSE transport 与视图状态 |
| `../../packages/mica-web-shared/` | 跨宿主的地址、主题、状态、展示和用量纯逻辑 |
| `../../packages/mica-config-ui/` | 配置页及 Arco 共享控件 |
| `../../packages/mica-editor/` | Notebook 与 Markdown 共用的隔离 Lexical 编辑器 |
| `../../plugins/` | 清单驱动的产品能力及其桌面模块 |

对话宿主使用 CLI 的 `mica app-server`，通过 stdio 交换 Codex v2 风格协议子集；浏览器页面使用 HTTP/SSE 访问 Web 运行时。两个接口的用途与支持范围见 [Headless 设计](../../docs/headless-design.md) 与 [客户端接入](../../docs/multica-runtime.md)。

客户端能力桥只向登记过的运行时窗口开放固定方法，校验发送窗口、主 frame 和认可的 origin。本机插件数据还需随包清单声明 `desktop.clientData: true`。旧 `mica-client:` fetch 协议不再支持；普通浏览器没有 `window.micaClient`。完整边界见 [桌面架构](../../agent/desktop.md#三层边界与装配)。

运行时构建使用 `ssr.noExternal: true`，仅保留 Node 内置模块与 `node-pty` 为 external。`package.json.dependencies` 只放主进程/运行时实际 require 的包，renderer 依赖归 `devDependencies`。`electron.vite.config.mjs` 的 React/React DOM dedupe 保证共享配置页与 desktop 使用同一份 React；Vite 8 与 electron-vite 6 配套维护。

## 界面与插件

主题注册表只有一份：`mica-web-shared/theme.ts`。当前支持 Darcula、浅色、Catppuccin Mocha/Latte、Tokyo Night/Light，以及跟随系统。`theme.js` 设置具体 `data-theme` 和明暗档 `data-appearance`；主窗口、配置页、编辑器、终端与 Portal 使用同一套语义 token。控件与动画规范见 [agent/ui.md](../../agent/ui.md)。

桌面插件通过清单声明入口、整页、输入控件、面板或会话菜单。随包插件的页面来自各自 `desktop.jsx`，宿主不按具体插件 id 分派产品逻辑。插件 API、版本化文档保存、关闭前保存钩子与原生启动器见 [插件开发文档](../../plugins/README.md)。

Notebook 的树与正文存储归插件，共享编辑器运行在 sandbox iframe 中；第三方编辑器依赖首次从 CDN 加载。AI 接口使用同端口 `/plugin/notebook/mcp`（标准 Streamable HTTP），桌面/Web 会话宿主启动时自动接入，外部客户端可配置同一 URL，不再分发 Notebook skill。接口不依赖打开页面或聊天会话，继承应用访问守卫，分享 cookie 不开放独立 MCP。文件视图的 Markdown、配置页 Role/Skill 与 Notebook 共享编辑能力，说明见 [mica-editor](../../packages/mica-editor/README.md) 和 [Notebook](../../plugins/notebook/README.md)。

会话压缩由 [Session Compact](../../plugins/session-compact/README.md) 提供。快速压缩聚合较早工具过程并移除思考/媒体载荷，保留用户和助手正文；模型压缩保存摘要加最近几轮，界面同步显示当前持久化记录。切换服务商/模型后，插件在下一次发送前快速压缩；没有按占用阈值或空闲时间自动生成摘要的设置。

## 手机键盘诊断

手机原生键盘问题需要在真实浏览器模式复现，包括添加到主屏后的模式。已有 renderer 产物时，可对接正在运行的运行时：

```bash
node scripts/serve-mobile-diagnostics.mjs
```

脚本默认使用运行时端口加 10000（通常为 18787），打印带 `?viewport-debug=1` 的 LAN 地址与临时 NDJSON 日志路径。`MICA_DESKTOP_PORT` 指向已有运行时，`MICA_DIAGNOSTICS_PORT` 可覆盖诊断端口。它记录视口、元素几何、滚动偏移、浏览器模式和构建文件名，不记录对话正文、草稿、HTML、会话 id 或查询参数。

采集仅在专用诊断服务开启，生产运行时不接收这些报告；结束后 Ctrl+C 停止服务。如果问题在采集时消失，应在同一浏览器模式对比 `?viewport-debug=0`：读取几何或计算样式本身可能触发布局，不能将录制时通过当作修复证明。视口算法及布局约定见 [agent/desktop.md](../../agent/desktop.md)。

## 图标与第三方资源

品牌 SVG 唯一源为 `resources/icon.svg`。macOS 上修改后用 `npm run icons:generate` 生成窗口、安装包、网页与 PWA 图标，需要 `sips`、`iconutil` 和 Pillow。

原生位图使用 Apple 的 824/1024 内容区；网页图标保持满幅。SVG 圆角需不大于图标尺寸的 `19/64`，否则 macOS 26 会加灰色底板。几何处理集中在 `scripts/generate-icons.py`，不要单独手改派生位图。

文件图标来自固定版本的 vscode-icons，`npm run icons:sync` 更新图标与映射。授权及复现信息见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
