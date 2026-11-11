# 构建、验证与交付

## 常用命令

### 仓库根目录（CLI）

```bash
bun install
bun run dev
bun run typecheck
bun run test -- <测试文件>   # Vitest；根项目不要用 bun test
bun run test:unit          # 只跑 unit project（进程内单测，并行）
bun run test:process       # 只跑 process project（真实子进程 E2E，文件串行）
bun run build              # typecheck → 单二进制编译 → 安装本地入口
bun run build:config-web   # 配置页产物 + generatedStaticAssets.ts
bun run format             # 全仓格式化；局部任务只格式化改动文件
```

`bun run build` 产出 `dist/mica`，默认安装到 `~/.local/lib/mica`；`~/.local/bin/mica` 是薄 launcher。`postbuild` 走 `scripts/install.mjs`。

### Desktop（`apps/desktop/`）

```bash
npm install
npm run dev                # 构建运行时后启动 Electron + Vite
npm test                   # bun test，4 worker 并行，覆盖 host / renderer / main
npx eslint src/
npm run build              # 并行：根 CLI 构建 + 外壳 + Web 运行时
npm run build:server       # 只重建 out/server
npm run build:app          # build + 无签名打包 + 本机证书快速签名（约十几秒）
npm run pack:app           # 只跑 electron-builder --dir 且强制不签名
npm run sign:app           # 用本机自签证书给已打出的 .app 签名
npm run build:mac          # 再打 DMG + zip（发布用；打包与压缩占 20s 以上）
npm run start:web          # 运行已构建的 Web 运行时
```

`build:app` 之前会执行根 `bun run build`：桌面端经 `resolveMicaExecutable()` 使用 `~/.local/bin/mica`，不刷新 CLI 就会连到旧二进制。

### macOS 签名

`electron-builder.yml` 里 `mac.identity: mica-codesign` 指向一个**本机自签证书**（`~/.mica/codesign/` + 名为 `mica-codesign` 的钥匙串，密码在 login keychain 的通用密码项里）。这样做的原因是 adhoc 签名的 designated requirement 绑 cdhash，每次重建都变，macOS 的「本地网络」授权会随之失效——表现为进程内访问 `172.x`/`10.x` 4ms 内 `EHOSTUNREACH`，而 launchd 拉起的独立进程同时刻一切正常。

- **`electron-builder` 自己的签名不要用**：它带 `--timestamp` 向 Apple 时间戳服务器请求，只能走代理的机器上每个二进制都要等超时，整包卡 5–8 分钟。`CSC_IDENTITY_AUTO_DISCOVERY=false` 压不住 yml 里显式写的 identity，要跳过必须用 `-c.mac.identity=null`（`pack:app` 已经这么做）。
- `sign-app.sh` 不请求时间戳，几秒签完。它只签 Mach-O（node-pty 的 prebuilds 混着 win32 的 `.node`），顺序是 `.node/.dylib/.so` → framework/嵌套 app（按深度倒序）→ 主 app。
- **跨机器安全**：没有 `mica-codesign` 证书的机器（同事、CI、Linux/Windows）`sign-app.sh` 打印一行说明后退出 0，`electron-builder` 找不到该身份也只是 `skipped macOS application code signing` 并以 0 退出，产物保持 adhoc 签名、可运行。想让缺证书变成硬失败（发布流水线）设 `MICA_SIGN_REQUIRED=1`。

## 构建

- `mica.build.env` 定义品牌键，同名环境变量优先；改键同步构建文件与本文。
- models.dev 种子用 `bun scripts/update-models-dev-seed.mjs` 刷新。
- 发布链路 `build-binaries.yml`：checks / desktop-checks 任一失败，build 与 publish 整段跳过。
- 打包按平台取 node-pty 原生产物（`scripts/stage-node-pty.mjs`）；`spawn-helper` 只属于 macOS。
- desktop 用 `scripts/run-parallel.mjs` 并行跑三份构建；Vite 8 需搭配 electron-vite 6。
- `npm run build:app` = 三份构建 + 强制跳过 electron-builder 签名的 `--dir` 打包 + 本机快速签名，只产出可运行的 `.app`；没有本机证书时签名步骤安全跳过。DMG + zip 是发布产物，走 `npm run build:mac`。后者省不掉：`hdiutil` 单压 277MB 的 app 就要 9s，zip 与 blockmap 再加 6s，两者串行约 20s，占整个 `build:mac` 的四分之三。
- 构建产物是唯一的共享点（`~/.local/lib/mica/mica` 与运行中的 `.app` 会被覆盖）：同一台机器上多个会话可能同时构建，动手前先争 `$HOME/.mica/.build-lock`（`mkdir` 自旋，结束 `rmdir`），并在动手前说明会覆盖哪些产物。
- 品牌 SVG 唯一源 `apps/desktop/resources/icon.svg`，位图由 `npm run icons:generate` 生成。
- 官网架构图只改 `apps/website/architecture/*.architecture.json`，再由 Archify 生成。

## 验证

**默认只跑与改动最接近的那一两条单测 + `bun run typecheck`。** 全量 `bun run test`（实测 8 核、load 8–10 的机器上约 4 分钟：unit 43s + process 209s，另加 desktop `npm test` 51s）、`npx eslint src/`（desktop 全量，带缓存约 8s）、`apps/cli/src/cli/app-server.flows.test.ts` 这类真实子进程 E2E 只在发布前、跨慢套件改动或用户明确要求时跑；不要用长测试兜底，也不要为「更保险」重复跑同一批。

- 局部改动跑相关测试 + `bun run typecheck` + `git diff --check`。
- `bun run test` 走 `scripts/run-tests.mjs`：先 `scripts/prune-test-temp.mjs` 清掉 `os.tmpdir()` 下过期的 `mica*` 测试目录（保留 `mica-tasks`，`MICA_TEST_TEMP_MAX_AGE_HOURS` 默认 6h），再串行跑两个 project，unit 失败即跳过 process。`test/globalSetup.ts` 用 `MICA_TEST_ROOT` 作整轮唯一的临时根并在结束时删除；worker 是被直接杀掉的，`setupFiles` 里的 exit 钩子不会触发，清理只能放在 globalSetup。
- 测试分两个 project（`vitest.config.ts`）：`unit` 是进程内单测、按文件并行；`process` 是真实子进程 / PTY / TUI 的 E2E，文件串行、文件内用例并发。慢的根源是每个用例 spawn 一次真实 `mica`（冷启动 1–1.5s），所以新增 E2E 用例要用 `it.concurrent` 语义（每用例自带 mock provider 与 `MICA_HOME`），不要把 `process` 项目丢回并行池：它和 unit 的 worker 抢 CPU 时会打挂 `btw.pty`、turn lease 这类时序敏感用例。
- `testTimeout` 显式给定而不是沿用 Vitest 默认 5s：unit 里有真实 git 仓库与文件 I/O，process 的 PTY 用例内部就按 20s 等待。机器一忙（多个 worker + 开发者自己的进程）5s 会打挂与代码无关的用例。desktop 的 `npm test` 同理显式给 `--timeout=20000`：那里的 git 夹具用例常态就要 3–8s，沿用 bun 默认 5s 会随机报「timed out after 5000ms」。并发上限：`unit` 的 `maxWorkers` 固定 4（6 个实测有 7 个用例超时）；`process` 的 `maxConcurrency` 是 6（实测 3 → 6 把整轮 397s 压到 209s，失败数不变）。
- desktop 的 `npm test` 通过 `scripts/run-tests.mjs` 用 `--parallel=4` 执行；`npm test -- <测试文件>` 可只跑指定文件。启动 Bun 前设置 `GIT_CONFIG_GLOBAL` 为系统空设备，PATH 前置只含 `git → /usr/bin/git` 的临时目录，结束后清理。隔离必须在父进程完成：Bun 并行 worker 内 preload 对 `process.env` 的修改不会进入未显式传 `env` 的子进程，单靠 `test-setup.js` 仍会执行本机 hooks。preload 为直接运行的串行 `bun test` 保留相同隔离。
- desktop 的 `test-setup.js` 将 React、JSX runtime、React DOM 与 server renderer 指向根依赖的真实实现，与 Vite 的 dedupe 对齐，避免共享 UI 从根加载 React、测试 renderer 从 desktop 加载另一份而报 invalid hook call。
- 根测试用 Vitest / Node；`PtyDriver` 仅 Node/vitest 可用，Bun 用 manager + Node helper。
- `app-server.flows.test.ts` 用本地 mock provider，无需真实 key；resume 用隔离 `MICA_HOME`。
- 允许使用用户真实 Mica 配置中的 API 做少量、与当前改动直接相关的冒烟测试、复现和验证，无需逐次征求同意；仍使用隔离的 `MICA_HOME`，不改写原配置、不输出凭据，临时凭据副本用完清理。控制实际 API 请求总量，计入工具迭代、重试及 helper/subagent 请求；大量请求（批量评测、压力测试、长循环或大规模并发）必须先说明目的、预计请求量与成本范围，并取得用户同意，不能拆成多批少量请求绕过。
- PTY 真实 provider 冒烟须显式开关并指向真实配置：单轮用 `MICA_PTY_SMOKE=1`，用户流程用 `MICA_PTY_FLOW_SMOKE=1`，两者都读 `MICA_PTY_SOURCE_HOME`（默认 `~/.mica`）。
- desktop 改动按改动面跑：`npm test`（host / renderer / main 全量）在收尾时可省，改到哪一侧就只跑那一侧（`bun test src/host` 等）；新增运行时依赖另构建 server 验证自包含（`npm run build:server`）。
- 浏览器与终端控制必须真窗口验证，单测不能替代。
- 起测试实例要同时给 `MICA_HOME` / `MICA_DESKTOP_USER_DATA` / `MICA_DESKTOP_PORT` 与独立 `--user-data-dir`。
- 长进程放后台任务，用 `wait_for`（http / port / 文件）等就绪，不用大数字 `sleep` 硬等。
- 要反复看的界面探针放 `apps/desktop/.probe/<名字>/` 并纳入 git（每套一个子目录，运行方式见 `apps/desktop/.probe/README.md`）；一次性的探针、复现脚本与临时测试一律放在 gitignore 的 `temp/` 下，用完即删，交付前 `git status --short` 确认无残留。
- 判断服务不可用先看证据（curl、lsof、日志 ready 行）；整页空白先查渲染期异常。

## 对外文档与演示素材

- README 面向使用者；`docs/` 放稳定设计；`apps/website` 是官网；`blogs/` 是开发记录；包 README 只讲单包 API 与边界。
- 对外文案不依赖个人路径与未公开项目；不写虚构成果或无证据排行。
- 命令表必须与代码一致（`ALLOW_DURING_TURN_COMMANDS` 与 `allowDuringTurn`），新增/删除命令同步 README、命令页与 `packages/mica-builtin-commands/README.md`。
- 截图必须可复现：脚本化 mock provider（`scripts/demo-mock-provider.mjs`）→ 隔离 demo home → 运行时 → `chat:start` → 受控浏览器截图。产物固定三个，内容只用示例数据。

## 隔离插件 Web 运行时

桌面 renderer 的 `pluginWebAssets()` 自动构建提供 `plugins/*/web-build.mjs` 的随包插件，静态文件进入 `out/renderer/plugin-web/<id>/`。共享编辑器 `packages/mica-editor` 不走这条路径：两个宿主都用它的 `editorWebAssets()`（`build.mjs`）输出 `/editor/`，桌面进 `out/renderer/editor/`、配置 Web 进 `apps/config-web/web/dist/editor/`，开发期按需构建到 `temp/editor-web-dev/`。它的运行时单独管理开发依赖与类型检查（`packages/mica-editor/runtime` 下 `npm ci --ignore-scripts`、`npm run typecheck`），第三方库在运行时由 CDN 加载，主仓库 `typecheck` 不重复检查这份独立项目。隔离调试只向 `temp/` 或 `/private/tmp` 输出，不覆盖已安装应用。
