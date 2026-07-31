# mica-pty

基于 [node-pty](https://github.com/microsoft/node-pty)（VS Code 终端同款底层库）的 PTY 测试驱动，用于驱动交互式 TUI 程序做测试和验证，例如 mica 本体。

> **不集成进 mica 运行时**。mica 是 Bun 运行时，而 node-pty 的 native binding 在 Bun 下不可用（master fd 会 EBADF、读写无效）。本包必须运行在 Node ≥22 或 vitest（Node 环境）下。

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
- **不要**从 `bun run` 的代码里 import 本包。

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
  tests/
    driver.test.ts    单元/集成测试（vitest，Node 环境）
    mica.smoke.test.ts  真实 mica 端到端冒烟（默认跳过）
```

## 验证

```bash
bunx tsc --noEmit
bun run test -- packages/mica-pty/tests/driver.test.ts
```
