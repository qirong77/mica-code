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
npm run build:app          # build + electron-builder --dir + 写产物指纹（产出 .app，= build:unpack）
npm run build:mac          # 再打 DMG + zip（发布用；打包与压缩占 20s 以上）
npm run start:web          # 运行已构建的 Web 运行时
```

`build:app` 之前会执行根 `bun run build`：桌面端经 `resolveMicaExecutable()` 使用 `~/.local/bin/mica`，不刷新 CLI 就会连到旧二进制。

## 构建

- `mica.build.env` 定义品牌键，同名环境变量优先；改键同步构建文件与本文。
- models.dev 种子用 `bun scripts/update-models-dev-seed.mjs` 刷新。
- 发布链路 `build-binaries.yml`：checks / desktop-checks 任一失败，build 与 publish 整段跳过。
- 打包按平台取 node-pty 原生产物（`scripts/stage-node-pty.mjs`）；`spawn-helper` 只属于 macOS。
- desktop 用 `scripts/run-parallel.mjs` 并行跑三份构建；Vite 8 需搭配 electron-vite 6。
- `npm run build:app` = 三份构建 + `electron-builder --dir`，只产出可运行的 `.app`；DMG + zip 是发布产物，走 `npm run build:mac`。后者省不掉：`hdiutil` 单压 277MB 的 app 就要 9s，zip 与 blockmap 再加 6s，两者串行约 20s，占整个 `build:mac` 的四分之三。
- 构建产物是唯一的共享点（`~/.local/lib/mica/mica` 与运行中的 `.app` 会被覆盖）：同一台机器上多个会话可能同时构建，动手前先争 `$HOME/.mica/.build-lock`（`mkdir` 自旋，结束 `rmdir`），并在动手前说明会覆盖哪些产物。
- 品牌 SVG 唯一源 `apps/desktop/resources/icon.svg`，位图由 `npm run icons:generate` 生成。
- 官网架构图只改 `apps/website/architecture/*.architecture.json`，再由 Archify 生成。

## 验证

**默认只跑与改动最接近的那一两条单测 + `bun run typecheck`。** 全量 `bun run test`（实测 8 核、load 8–10 的机器上约 4 分钟：unit 43s + process 209s，另加 desktop `npm test` 51s）、`npx eslint src/`（desktop 全量，带缓存约 8s）、`apps/cli/src/cli/app-server.flows.test.ts` 这类真实子进程 E2E 只在发布前、跨慢套件改动或用户明确要求时跑；不要用长测试兜底，也不要为「更保险」重复跑同一批。

- 局部改动跑相关测试 + `bun run typecheck` + `git diff --check`。
- `bun run test` 走 `scripts/run-tests.mjs`：先 `scripts/prune-test-temp.mjs` 清掉 `os.tmpdir()` 下过期的 `mica*` 测试目录（保留 `mica-tasks`，`MICA_TEST_TEMP_MAX_AGE_HOURS` 默认 6h），再串行跑两个 project，unit 失败即跳过 process。`test/globalSetup.ts` 用 `MICA_TEST_ROOT` 作整轮唯一的临时根并在结束时删除；worker 是被直接杀掉的，`setupFiles` 里的 exit 钩子不会触发，清理只能放在 globalSetup。
- 测试分两个 project（`vitest.config.ts`）：`unit` 是进程内单测、按文件并行；`process` 是真实子进程 / PTY / TUI 的 E2E，文件串行、文件内用例并发。慢的根源是每个用例 spawn 一次真实 `mica`（冷启动 1–1.5s），所以新增 E2E 用例要用 `it.concurrent` 语义（每用例自带 mock provider 与 `MICA_HOME`），不要把 `process` 项目丢回并行池：它和 unit 的 worker 抢 CPU 时会打挂 `btw.pty`、turn lease 这类时序敏感用例。
- `testTimeout` 显式给定而不是沿用 Vitest 默认 5s：unit 里有真实 git 仓库与文件 I/O，process 的 PTY 用例内部就按 20s 等待。机器一忙（多个 worker + 开发者自己的进程）5s 会打挂与代码无关的用例。desktop 的 `npm test` 同理显式给 `--timeout=20000`：那里的 git 夹具用例常态就要 3–8s，沿用 bun 默认 5s 会随机报「timed out after 5000ms」。并发上限：`unit` 的 `maxWorkers` 固定 4（6 个实测有 7 个用例超时）；`process` 的 `maxConcurrency` 是 6（实测 3 → 6 把整轮 397s 压到 209s，失败数不变）。
- desktop 的 `npm test` 用 `--parallel=4`（串行 138s → 51s）；再往上（实测 6）在这台机器上反而更慢。`apps/desktop/test-setup.js` 把测试里的 git 与这台机器装的扩展隔离：`GIT_CONFIG_GLOBAL=/dev/null` 关掉全局 `core.hooksPath` / trace2，PATH 前置一个只含 `git → /usr/bin/git` 的临时目录绕开 `~/.git-ai/bin/git` 这类包装二进制（每次 commit 实测 +170ms）。
- 根测试用 Vitest / Node；`PtyDriver` 仅 Node/vitest 可用，Bun 用 manager + Node helper。
- `app-server.flows.test.ts` 用本地 mock provider，无需真实 key；resume 用隔离 `MICA_HOME`。
- 允许使用用户真实 Mica 配置中的 API 做少量、与当前改动直接相关的冒烟测试、复现和验证，无需逐次征求同意；仍使用隔离的 `MICA_HOME`，不改写原配置、不输出凭据，临时凭据副本用完清理。控制实际 API 请求总量，计入工具迭代、重试及 helper/subagent 请求；大量请求（批量评测、压力测试、长循环或大规模并发）必须先说明目的、预计请求量与成本范围，并取得用户同意，不能拆成多批少量请求绕过。
- PTY 真实 provider 冒烟须显式开关并指向真实配置：单轮用 `MICA_PTY_SMOKE=1`，用户流程用 `MICA_PTY_FLOW_SMOKE=1`，两者都读 `MICA_PTY_SOURCE_HOME`（默认 `~/.mica`）。
- desktop 改动按改动面跑：`npm test`（host / renderer / main 全量）在收尾时可省，改到哪一侧就只跑那一侧（`bun test src/host` 等）；新增运行时依赖另构建 server 验证自包含（`npm run build:server`）。
- 浏览器与终端控制必须真窗口验证，单测不能替代。
- 起测试实例要同时给 `MICA_HOME` / `MICA_DESKTOP_USER_DATA` / `MICA_DESKTOP_PORT` 与独立 `--user-data-dir`。
- 长进程放后台任务，用 `wait_for`（http / port / 文件）等就绪，不用大数字 `sleep` 硬等。
- 临时探针脚本命名 `.probe-*.mjs` 并放仓库内，用完立即删除；交付前 `git status --short` 确认无残留。
- 判断服务不可用先看证据（curl、lsof、日志 ready 行）；整页空白先查渲染期异常。

## 对外文档与演示素材

- README 面向使用者；`docs/` 放稳定设计；`apps/website` 是官网；`blogs/` 是开发记录；包 README 只讲单包 API 与边界。
- 对外文案不依赖个人路径与未公开项目；不写虚构成果或无证据排行。
- 命令表必须与代码一致（`ALLOW_DURING_TURN_COMMANDS` 与 `allowDuringTurn`），新增/删除命令同步 README、命令页与 `packages/mica-builtin-commands/README.md`。
- 截图必须可复现：脚本化 mock provider（`scripts/demo-mock-provider.mjs`）→ 隔离 demo home → 运行时 → `chat:start` → 受控浏览器截图。产物固定三个，内容只用示例数据。
- 评测数据唯一来源是 `apps/website/public/benchmark-data.json`；图由 `bun scripts/generate-eval-chart.mjs` 生成，不手改 SVG；不得称 Terminal-Bench 成绩。
