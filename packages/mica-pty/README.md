# mica-pty

基于 [node-pty](https://github.com/microsoft/node-pty)（VS Code 终端同款底层库）的 PTY 能力包，包含两类能力：

- **`PtyDriver`（测试驱动）**：Node ≥22 / vitest 环境下直接 import，用于驱动交互式 TUI 程序（如 mica 本体）做测试和验证。
- **内置 `pty_*` 工具运行时**：mica 以 Bun 运行时内置 `pty_spawn`/`pty_send`/`pty_read`/`pty_wait`/`pty_kill` 工具。node-pty 的 native binding 在 Bun 进程内不工作（spawn 的进程不会输出、master fd 无效），因此 PTY 会话由懒启动的 **Node 子进程**（`src/server.mjs`）通过 JSONL over stdio 承载，Bun 主进程（`PtyManager`）只做 IPC 和输出缓冲。

> node-pty 只能在 Node 进程中加载。**不要从 `bun run` 代码里 import `PtyDriver` 或 `mica-pty/index.js`**（后者会 chain 到 node-pty）；生产代码应只通过 `@packages/mica-pty/src/manager.js` 使用内置工具运行时。

## 设计动机

原始 python 驱动（`temp/mica_pty.py`）发现过一个关键问题：同步读取 pty master 时，如果 app 的输出没有及时排空，stdin 字节会被批量积压，导致 ink 的 tokenizer 把 `\r`（Enter）与前序字符合并成一个 chunk，Enter 被当成文本（换行）插入。

node-pty 天然避免了这个问题：它在独立线程读取 master fd，`onData` 以异步事件回调 JS 主线程，子进程永远不会因为 pty 缓冲满而阻塞，stdin 写入也不会被合并。因此本包不依赖"持续排空 pty"这类驱动侧 hack。

## 安装

```bash
bun install
```

node-pty 的 prebuild `spawn-helper` 在通过 Bun 安装时可能缺少执行位（Bun 默认不跑依赖的 lifecycle scripts）。`PtyDriver.spawn()` 首次调用会做幂等 chmod 兜底，正常使用无需手动处理。

## 快速开始

```ts
import { PtyDriver } from '@packages/mica-pty/index.js';

const driver = PtyDriver.spawn(['/path/to/dist/mica'], {
  cols: 120,
  rows: 40,
  cwd: '/tmp/workdir',
  env: { MICA_HOME: '/tmp/mica-home' },
  logPath: '/tmp/mica-run.raw', // 输出日志；stdin 回显写入 /tmp/mica-run.raw.in
});

await driver.waitFor(/Type a message|start a conversation/, { timeoutMs: 60_000 });
await driver.waitIdle(800);

const sendPos = driver.text().length;
await driver.typeText('回复两个字：你好', 15);
driver.enter();
await driver.waitTurnCompleted(sendPos, { timeoutMs: 180_000 });

console.log(driver.latestScreen(60_000));
await driver.close('SIGTERM', 3_000);
```

## 运行环境

- 在 vitest 测试中直接 import（项目 `bun run test` 即 vitest，跑在 Node 上）。
- 独立脚本用 `node` 运行，或用 `npx tsx`（本项目未内置 tsx）。
- **不要**从 `bun run` 的代码里 import `PtyDriver` 或 `index.ts`（会加载 node-pty）。

## 内置 PTY 工具

mica 内置 `pty_spawn` / `pty_send` / `pty_read` / `pty_wait` / `pty_kill` 工具，agent 可以直接驱动交互式 TUI 程序。运行时链路：

```text
pty_* 工具 (packages/mica-tools/pty/)
  └─ 动态加载 PtyManager (packages/mica-pty/src/manager.ts，不 import node-pty)
       └─ 懒启动 node 子进程运行 src/server.mjs（JSONL over stdin/stdout）
            └─ node-pty 创建 PTY 会话，异步回传 data/exit 事件
```

- manager 按以下顺序解析 node-pty 入口，交给 Node helper 从真实磁盘加载：
  1. `MICA_PTY_ENTRY` 环境变量（显式指定，最优先）；
  2. `import.meta.resolve('node-pty')`（开发模式，排除 Bun 虚拟 `$bunfs` 路径）；
  3. mica 二进制所在目录向上（发布版自带 `node_modules/node-pty`，如 `~/.local/lib/mica/`）；
  4. mica-pty 模块目录向上（开发模式，不依赖 cwd）；
  5. 当前工作目录向上（含 `.bun` 缓存布局）；
  6. 全局 npm / homebrew / nvm 目录。
  全部失败时报错会列出已尝试位置和修复方式。
- `src/server.mjs` 是唯一真相源，`src/ptyServerSource.ts` 通过 `bun run scripts/generate-pty-server-source.mjs` 生成其 JSON 转义内嵌（`bun build --compile` 不支持 `?raw`），`tests/serverSource.test.ts` 校验同步。
- node-pty 缺失或 `node` 不可用（可用 `MICA_PTY_NODE` 覆盖）时工具降级报错，不影响 mica 其他功能。

### 发布版自带 node-pty

node-pty 是 C++ 原生模块，无法打进 `bun build --compile` 的单文件二进制，因此发布包（GitHub Release 的 `mica-code-{platform}-{cpu}.tar.gz`）除 `mica` 二进制外还携带精简后的 `node_modules/node-pty`：

- darwin / win32：npm 包自带的 `prebuilds/{platform}-{arch}`（`pty.node` + `spawn-helper`）；
- linux：构建机（对应架构 runner）上 `bun install` 时编译的 `build/Release/{pty.node,spawn-helper}`。

安装脚本（`scripts/install.sh` 与 `scripts/install.mjs`）把两者解压到 `~/.local/lib/mica/`，`~/.local/bin/mica` 只是 launcher。运行时 manager 从二进制目录向上即可找到 node-pty，**不再依赖用户机器上的 node_modules**。打包逻辑见 `scripts/package-release.mjs` 与 `scripts/stage-node-pty.mjs`。

`PtyManager` 也可直接编程使用：

```ts
import { PtyManager } from '@packages/mica-pty/src/manager.js';

const manager = new PtyManager();
const { sessionId } = await manager.spawn(['/bin/sh'], { cols: 120, rows: 40 });
await manager.send(sessionId, 'echo hi\r');
await manager.wait(sessionId, { pattern: 'hi' });
console.log(manager.read(sessionId, { mode: 'tail' }).output);
await manager.kill(sessionId);
```

## API

### `PtyDriver.spawn(argv, options)`

启动一个 PTY 子进程。

| 选项            | 默认             | 说明                                                        |
| --------------- | ---------------- | ----------------------------------------------------------- |
| `cols` / `rows` | `120` / `40`     | 终端尺寸（同时注入 `COLUMNS`/`LINES`）                      |
| `cwd`           | 当前目录         | 子进程工作目录                                              |
| `env`           | 继承             | 合并到 `process.env` 的额外环境变量                         |
| `name`          | `xterm-256color` | `TERM` 值                                                   |
| `logPath`       | 无               | raw 输出日志；同时生成 `<logPath>.in` 记录写回 stdin 的字节 |

### 实例方法

- `send(data)` / `typeText(text, charDelayMs)` / `enter()` / `esc()` / `sendKey(name)` / `sendCtrl(letter)`
  - 按键名见 `KEYS`（`enter`/`esc`/`tab`/`shiftTab`/方向键/`ctrlC`/`ctrlD` 等），`sendCtrl('c')` 生成 `\x03`。
- `resize(cols, rows)` — 调整 PTY 窗口。
- `raw()` / `text()` / `latestScreen(windowSize)` — raw 全文、剥离 ANSI 全文、剥离 ANSI 的尾部窗口（默认 80k 字符）。
- `waitFor(pattern, { timeoutMs, mode })` — 等待输出匹配；`mode: 'screen'` 只搜尾部窗口。
- `waitIdle(minIdleMs, timeoutMs)` — 等待输出静默。
- `waitTurnCompleted(sendPos, { activeRe, endRe, timeoutMs, noActiveTimeoutMs })` — mica 风格回合完成检测：`sendPos` 是发送输入前 `text()` 的长度；active 关键字之后出现 end 关键字即视为完成。返回 `'completed' | 'none' | 'timeout'`。
- `onData(cb)` / `onExit(cb)` — 订阅输出 chunk / 进程退出，返回退订函数。
- `close(signal, forceAfterMs)` — kill 子进程（SIGTERM，超时升级 SIGKILL）并关闭日志。

### 其他导出

- `stripAnsi` / `ANSI_STRIP_RE` — ANSI/控制序列剥离（保留 `\t \r \n`）。
- `KEYS` / `ctrl()` / `key()` — 按键序列。

## mica 冒烟测试

`tests/mica.smoke.test.ts` 用本包驱动 `dist/mica` 跑一轮真实对话（需要真实 provider API key，默认跳过）：

```bash
bun run build   # 先生成 dist/mica
MICA_PTY_SMOKE=1 npx vitest run packages/mica-pty/tests/mica.smoke.test.ts
```

`tests/mica-sync.smoke.test.ts` 会启动隔离的 Sync Server、daemon 和本地 PTY，验证同一会话按“本地 → 远程 → 本地”交替后历史不丢失，并确认远程完成后原终端会自动显示新消息：

```bash
bun run build
bun run build:sync-server
MICA_PTY_SOURCE_HOME="$HOME/.mica" MICA_PTY_SYNC_SMOKE=1 \
  npx vitest run packages/mica-pty/tests/mica-sync.smoke.test.ts
```

`tests/user-flows.smoke.test.ts` 是真实用户流套件：通过 PTY 驱动 `dist/mica` 覆盖全新配置启动、全部内置命令面板、真实模型多轮对话与文件工具、多 agent（`/new` `/fork` `/task`）、`/clear` 会话隔离、`--resume` 跨重启恢复、Shift+Tab role 切换，以及随机命令序列 + resize + 快速输入的压测：

```bash
bun run build
MICA_PTY_FLOW_SMOKE=1 MICA_PTY_SOURCE_HOME="$HOME/.mica" \
  npx vitest run packages/mica-pty/tests/user-flows.smoke.test.ts
```

vitest 会重定向 `HOME`，必须显式传 `MICA_PTY_SOURCE_HOME`；测试只把 `config.json` 复制到隔离 `MICA_HOME`，不触碰用户数据。可加 `-t "seeded HOME"` 等过滤只跑部分场景。

按需修改文件顶部的 `MICA_BIN`/`HOME`/`CWD`，并预置隔离 `MICA_HOME`（config.json + storage.json，模板见 `temp/mica_pty.py`）。

## 目录结构

```text
packages/mica-pty/
  index.ts            公共 API 聚合
  node-pty.d.ts       node-pty 最小类型声明（官方包未声明 typings 字段）
  src/
    ansi.ts           ANSI 剥离
    keys.ts           按键序列
    ensureExecutable.ts  spawn-helper chmod 兜底
    driver.ts         PtyDriver 核心
    manager.ts        Bun 侧 PtyManager（JSONL IPC、session 状态、wait 逻辑）
    server.mjs        Node 侧 PTY helper server（唯一真相源，JSONL 协议）
    ptyServerSource.ts  由 server.mjs 生成的 JSON 转义内嵌（勿手改）
  tests/
    driver.test.ts    单元/集成测试（vitest，Node 环境）
    manager.test.ts   PtyManager 集成测试（真实 PTY 进程）
    serverSource.test.ts  校验 server.mjs 与 ptyServerSource.ts 同步
    mica.smoke.test.ts  真实 mica 端到端冒烟（默认跳过）
    user-flows.smoke.test.ts  真实用户流冒烟（命令/对话/多 agent/压测，默认跳过）
```

## 验证

```bash
bunx tsc --noEmit
bun run test -- packages/mica-pty/tests/driver.test.ts packages/mica-pty/tests/manager.test.ts packages/mica-pty/tests/serverSource.test.ts
```
