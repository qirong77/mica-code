# mica-diagnostics

Mica 的**诊断日志唯一写入器**。目标不是遥测，而是「事后能查」：出了问题之后能回答「什么时候开始变慢/变胖、慢在哪一段、那个 1.2GB 是谁」。

node-only（写文件），不要从浏览器侧的代码里 import。

## 职责

- **落盘**：JSONL 一行一个事件，目录由 `resolveLogDir()` 决定（macOS `~/Library/Logs/mica`，`MICA_LOG_DIR` 覆盖）。**不写系统 temp**——temp 每次登录被清空，跨天的问题就查不到了。
- **节流**：内存排队 + 2s 批量 flush，高频事件（流式输出、每秒采样）不会把调用方拖慢；单文件 16MB 分片、保留 7 天、目录总容量 256MB。
- **慢操作**：`logger(scope).timed()` / `timedResult()` 包一次调用，超过 `SLOW_MS`（默认 300ms）记一条 warn，并累计到 `slowReport()`——「哪个功能慢」看这张表。`timedResult` 额外识别「调用成功但返回体里带 `error` / `ok:false`」的失败。
- **进程内存**：`startMemorySampler({ host, describe })` 每 30s 记一条 `scope: 'mem'`。
- **聚合**：`readPerformanceSummary()` 把上面几类合成配置页 Performance 用的形状（渲染层时间线、按功能聚合、进程内存、最近事件）。

## 谁在写

| 进程 | `host` | 额外现场 |
| --- | --- | --- |
| 桌面运行时（`apps/desktop/src/server`） | `runtime` | `hosts` / `busy`（挂了几个 app-server） |
| Electron 主进程 | `main` | `windows` + `byType`（`app.getAppMetrics()` 按进程类型的 MB） |
| 每个会话宿主（`mica app-server`） | `app-server` | `session` / `turn` |
| TUI（`mica`） | `tui` | `session` / `model` |
| `mica exec` | `exec` | 只留 warn+，不采样内存（一次性命令） |

同一个目录、同一套文件，靠 `host` + `pid` 区分——所以「是宿主变多了，还是单个宿主在涨」可以直接看出来。

## 入口

```ts
import { logger, startMemorySampler, setLogLevel, flushLogs } from '@packages/mica-diagnostics/index.js';

const log = logger('invoke');
await log.timedResult('git:status', () => readStatus());   // 慢调用自动记 warn

const stop = startMemorySampler({ host: 'runtime', describe: () => ({ hosts: 3 }) });
process.on('exit', () => flushLogs());
```

- `setLogLevel('warn')`：一次性命令（`mica exec`、插件命令）用，避免每次调用都建一个文件。
- `snapshot()` / `slowReport()` / `stats()`：内存里的现场，给 `diagnostics:snapshot` 通道用。
- `clearLogs()`：配置页的「清空」。

## 布局

- `index.ts`：全部实现（写入器、采样器、聚合）。
- 目录结构只有这一个文件：它刻意保持无依赖（除 `mica-config` 的路径解析），任何宿主都能直接引用。
