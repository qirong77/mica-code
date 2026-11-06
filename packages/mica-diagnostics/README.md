# mica-diagnostics

Mica 的**诊断日志唯一写入器**。目标不是遥测，而是「事后能查」：出了问题之后能回答「什么时候开始变慢/变胖、慢在哪一段、那个 1.2GB 是谁」。

node-only（写文件），不要从浏览器侧的代码里 import。

## 职责

- **落盘**：JSONL 一行一个事件，目录由 `resolveLogDir()` 决定（macOS `~/Library/Logs/mica`，`MICA_LOG_DIR` 覆盖）。**不写系统 temp**——temp 每次登录被清空，跨天的问题就查不到了。
- **节流**：内存排队 + 2s 批量 flush，高频事件（流式输出、每秒采样）不会把调用方拖慢；单文件 16MB 分片、保留 7 天、目录总容量 256MB。
- **慢操作**：`logger(scope).timed()` / `timedResult()` 包一次调用，超过 `SLOW_MS`（默认 300ms）记一条 warn，并累计到 `slowReport()`——「哪个功能慢」看这张表。`timedResult` 额外识别「调用成功但返回体里带 `error` / `ok:false`」的失败。
- **进程内存**：`startMemorySampler({ host, describe })` 每 30s 记一条 `scope: 'mem'`。RSS 越过 `MICA_LOG_SPIKE_MB`（默认 1024）时额外记一条 `warn` + `event: 'spike'`，带上完整的 `describe()` 现场——采样 30 秒一次，一个回合把宿主顶到 2GB 再还回去只会在日志里留两三个点，事后看不出那一刻在跑什么。降到阈值以下再越过才会再报（10 分钟冷却）。
- **聚合**：`readPerformanceSummaryAsync()` 供生产刷新使用，按 scope 各自从文件尾部读取最多 4MB，64KB 一批异步读取与解析；把渲染层时间线、按功能聚合、进程内存和最近事件交给 Performance 页。同步 `readPerformanceSummary()` 保留给同步诊断调用。慢且失败的 `timed()` / `timedResult()` 都只写一条带 `failed` 标记的 slow 记录。

聚合缓存只保留计数、进程投影和限量的事件 / 时间线，不保留原始日志、读取 buffer 或任意嵌套 payload。文件投影最多 256 份、估算容量 32MB，另留最多 2MB 的最终结果；文件身份、大小、mtime / ctime、尾部读取范围变化会使对应投影失效，目录变化和清空也会失效。未变化的目录只检查文件元数据并返回结果副本，同参数并发读取合并为一次。追加会重读变化文件的选中尾部，尚未做字节级增量解析。事件中的错误展示为最多 2000 字符的短消息，原始错误仍在 JSONL 中。

## 谁在写

| 进程                                    | `host`       | 额外现场                                                      |
| --------------------------------------- | ------------ | ------------------------------------------------------------- |
| 桌面运行时（`apps/desktop/src/server`） | `runtime`    | `hosts` / `busy`（挂了几个 app-server）                       |
| Electron 主进程                         | `main`       | `windows` + `byType`（`app.getAppMetrics()` 按进程类型的 MB） |
| 每个会话宿主（`mica app-server`）       | `app-server` | `session` / `turn`                                            |
| TUI（`mica`）                           | `tui`        | `session` / `model`                                           |
| `mica exec`                             | `exec`       | 只留 warn+，不采样内存（一次性命令）                          |

同一个目录、同一套文件，靠 `host` + `pid` 区分——所以「是宿主变多了，还是单个宿主在涨」可以直接看出来。

**Bun 进程不报 heap**：`collectMemory()` 在 Bun/JSC 下只写 `rss` 并标 `heapReliable: false`。那套 `heapUsed` / `heapTotal` / `external` 与实际占用对不上（实测 `heapUsed 524MB > heapTotal 374MB`，日志里出现过 `heap 5014MB / heapT 161MB`、`rss 95MB / ext 430MB`），写进去会让「谁在涨」的判断整体失真。判断进程内存一律看 RSS；要看 JS 堆得拍快照（Desktop 的 Performance 页有入口）。

**调用方归因**：`timedResult(event, fn, limit, meta)` 的第 4 个参数是调用方现场（例如 `{ plugin, sid, cwd, hidden }`）。它只写进事件行，**不进** `slowReport()` 与聚合表的键——同一个通道会被十几个调用方打，按通道名聚合回答不了「这 600 次是谁发的」，但让高基数键进聚合又会把表撑开。

## 入口

```ts
import { logger, startMemorySampler, setLogLevel, flushLogs } from '@packages/mica-diagnostics/index.js';

const log = logger('invoke');
await log.timedResult('git:status', () => readStatus()); // 慢调用自动记 warn

const stop = startMemorySampler({ host: 'runtime', describe: () => ({ hosts: 3 }) });
process.on('exit', () => flushLogs());
```

- `setLogLevel('warn')`：一次性命令（`mica exec`、插件命令）用，避免每次调用都建一个文件。
- `snapshot()` / `slowReport()` / `stats()`：内存里的现场，给 `diagnostics:snapshot` 通道用。
- `readPerformanceSummaryAsync(options)` / `readPerformanceSummary(options)`：同一套聚合口径与有界缓存；选项为 `maxBytes`（每 scope 的尾部字节预算）、`limit`（事件数）、`timeline`（时间线 / 内存点数）、`buckets`（耗时排行数）。
- `clearLogs()`：配置页的「清空」。

## 布局

- `index.ts`：公共入口、写入器与采样器。
- `performance-summary.ts`：同步 / 异步读取、精简聚合与有界缓存；只依赖 Node 内置模块和 `mica-config` 的路径解析。
