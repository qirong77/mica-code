# mica-diagnostics

Mica 的**诊断日志唯一写入器**。目标不是遥测，而是「事后能查」：出了问题之后能回答「什么时候开始变慢/变胖、慢在哪一段、那个 1.2GB 是谁」。

node-only（写文件），不要从浏览器侧的代码里 import。

## 职责

- **落盘**：JSONL 一行一个事件，目录由 `resolveLogDir()` 决定（macOS `~/Library/Logs/mica`，`MICA_LOG_DIR` 覆盖）。**不写系统 temp**——temp 每次登录被清空，跨天的问题就查不到了。
- **节流**：内存排队 + 2s 批量 flush，高频事件（流式输出、每秒采样）不会把调用方拖慢；单文件 16MB 分片、保留 7 天、目录总容量 256MB。
- **慢操作**：`logger(scope).timed()` / `timedResult()` 包一次调用，超过 `SLOW_MS`（默认 300ms）记一条 warn，并累计到 `slowReport()`——「哪个功能慢」看这张表。`timedResult` 额外识别「调用成功但返回体里带 `error` / `ok:false`」的失败。
- **进程内存**：`startMemorySampler({ host, describe })` 每 30s 记一条 `scope: 'mem'`。RSS 越过 `MICA_LOG_SPIKE_MB`（默认 1024）时额外记一条 `warn` + `event: 'spike'`，带上完整的 `describe()` 现场——采样 30 秒一次，一个回合把宿主顶到 2GB 再还回去只会在日志里留两三个点，事后看不出那一刻在跑什么。降到阈值以下再越过才会再报（10 分钟冷却）。
- **聚合**：`readPerformanceSummaryAsync()` 供生产刷新使用，按 scope 各自从文件尾部读取最多 4MB，64KB 一批异步读取与解析；把渲染层时间线、按功能聚合、进程内存和最近事件交给 Performance 页。同步 `readPerformanceSummary()` 保留给同步诊断调用。慢且失败的 `timed()` / `timedResult()` 都只写一条带 `failed` 标记的 slow 记录。
- **插件日志**：`enqueueLogEntry(entry, { dir?, filePrefix?, maxFileBytes? })` 复用同一写入器，不另起每行同步 IO。PluginLog 保留 2 MiB 分片和原日志入口、使用 `at/scope/pluginId/plugin/data` 信封。队列最多 2000 条/4 MiB、单条 64 KiB；`stats()` 暴露溢出、序列化及写入失败计数。`force` 只供显式刷新，常规生产者入队后在批次/2 秒定时点写盘。
- **操作观察**：`observePluginOperation(context, task)`、`startPluginOperation(context)` 与 `operationResult()` 共用开始/终态关联协议；同步 begin/end 不改变处理器返回类型。只记录固定身份、操作、outcome/code、耗时，不复制 task 的参数、返回正文或异常原文。取消/拒绝/冲突/等待/忙/部分/未知不当故障，无会话操作不伪造 Agent run。自定义结果分类也必须返回固定白名单码。

### 结果与身份契约

处理器应返回 `{ outcome, code, message? }`，`message` 仅供人读，不参与终态分类。`operationResult()` 接受 `success/error/failure/failed/busy/cancelled/declined/partial/unknown/waiting/skipped/timeout/conflict`；`failure` 和 `failed` 归一为 `error`。显式终态优先于 `ok/isError` 等传输标记，未知显式值归为 `unknown/invalid_outcome`，不按中文、英文成功/失败文案猜测。`code` 只接受固定标识字符（字母开头、字母数字与 `._-`、最多 60 字符），不复制错误正文或地址。既有 `ok:false`、`isError`、非零退出码与取消/超时布尔标记仍是结构化结果，不扫描任意 stdout/source。

`operationFailure(error, signal?)` 按调用方取消/超时、错误名和固定 code 分类；`BusyError` 及 `busy/session_busy/turn_busy/resource_busy/maintenance_busy/TURN_LEASE_BUSY/EBUSY/ERR_BUSY/E_BUSY` 为 `busy`，普通异常即便文案里写了 busy 也不改类。相同白名单 code 的结构化结果也归为 busy。观察不改变 HTTP 状态、处理器结果或异常身份，不重发业务操作。

`processIdentity()` 的 `pid/generation` 标记当前进程写入世代（PID 可被重用，generation 为随机 UUID）。操作和插件文件日志均携带这两个字段；`pluginVersion` 只能由加载的生产者传入，缺失或非法即 `unknown`，绝不从后来清单回填历史。旧日志缺字段仍为未知，不当成当前部署版本的证据。

### 后台心跳（合并，不是采样）

Manager 的 `background.tick` 使用固定 `taskId` 和 `heartbeat:true`。首次结果、outcome/code 转换、失败、取消以及非例行终态保留即时 `operation.start/finish`；重复 success/skipped/waiting 不逐 tick 占据高频 operation 尾部，合并到独立 `scope:plugin-heartbeat/event:background.heartbeat`、`schemaVersion:1`。每个桶带唯一 heartbeatId，复制/轮转按该 ID 去重，同毫秒的两次独立 flush 不合并。计数只代表处理器完成，不代表业务服务已 ready 或用户验收。

- 分组最多 256 个（插件、生产者版本、taskId）；淘汰前补写累计尾部，绝不为腾出展示容量静默丢计数。
- 按完成时刻的一分钟桶写 `windowStart/windowEnd/firstAt/lastAt/count/totalMs/minMs/maxMs`；`durationBoundsMs:[10,100,1000,10000]` 对应 `durationBuckets` 的五个互斥区间：`<10`、`[10,100)`、`[100,1000)`、`[1000,10000)`、`>=10000` ms。
- 心跳仅计被合并的重复 success/skipped/waiting（保留原终态，不提升为成功），不包含即时状态转换记录，因此两者可相加、不重复。定时、插件释放与 `flushLogs()` 补齐部分尾桶，身份字段与普通操作一致。
- 为避免逐 tick start 污染尾部，健康后台 span 的开始先留内存，异常或转换时才补写真实开始时刻。调用方取消会即时结算观察终态，即使处理器忽略 signal，迟到完成也不能改写为 success；这不证明处理器物理停止。强杀仍可能丢失未完成 tick 与最后一个内存桶；不据此补造成功、失败或完整覆盖。

### Writer 自身健康

独立 `scope:writer-health/event:writer.checkpoint`（`schemaVersion:1`）受保护检查点**不经过普通队列、ring 或 logger**，所以满队列和序列化故障不会递归制造更多入队。它仅在批量 flush/定时器栈执行 IO，正常生产者栈仍无同步 IO。每目的目录最多每分钟自动写一次，显式 flush 只补变更，退出补一次 `reason:exit` 尾部；失败限频重试，不改变业务结果。目的目录最多保留 64 个检查点状态，文件服从共享轮转与保留期。

检查点包含 `pid/generation/dropped/overflowDrops/serializationFailures/writeFailures/checkpointFailures/lostLowerBound/logLevel/pluginLogEnabled/closePolicy/reason`。计数为**同一进程世代累计值**，读取取最新/最大值，不能把每行或不同目的目录的副本相加。`clearLogs()` 清展示记录，不重置这些累计计数。

`lostLowerBound = overflowDrops + serializationFailures` 是未进入 append 的确证丢失下界；`writeFailures` 是 append 抛错批次的条目数，可能部分已写入，独立保留不确定性，不冒充精确丢失。恢复后的成功检查点携带全部此前累计丢弃，即使对应操作的 start/finish 都丢了仍可事后看到下界。`checkpointFailures` 单列检查点自身失败次数，不递归计为普通日志丢失。关闭策略为 `best_effort_sync_exit`：不阻止退出、不 fsync、不保证强杀/OOM/磁盘永久不可写时有最终检查点；无检查点绝不等于零丢失。

聚合缓存只保留计数、进程投影和限量的事件 / 时间线，不保留原始日志、读取 buffer 或任意嵌套 payload。文件投影最多 256 份、估算容量 32MB，另留最多 2MB 的最终结果；文件身份、大小、mtime / ctime、尾部读取范围变化会使对应投影失效，目录变化和清空也会失效。未变化的目录只检查文件元数据并返回结果副本，同参数并发读取合并为一次。追加会重读变化文件的选中尾部，尚未做字节级增量解析。事件中的错误展示为最多 2000 字符的短消息，原始错误仍在 JSONL 中。

## 谁在写

| 进程                                    | `host`       | 额外现场                                                      |
| --------------------------------------- | ------------ | ------------------------------------------------------------- |
| 桌面运行时（`apps/desktop/src/server`） | `runtime`    | `hosts` / `busy`（挂了几个 app-server）                       |
| Electron 主进程                         | `main`       | `windows` + `byType`（`app.getAppMetrics()` 按进程类型的 MB） |
| 每个会话宿主（`mica app-server`）       | `app-server` | `session` / `turn`                                            |
| TUI（`mica`）                           | `tui`        | `session` / `model`                                           |
| `mica exec`                             | `exec`       | 只留 warn+，不采样内存（一次性命令）                          |

同一个目录、同一套文件，带世代身份的生产者靠 `pid/generation` 区分，`host` 说明宿主类别；历史缺身份时如实保留未知。

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
- `operation.ts`：元数据操作观察与调用方取消等待；通过包入口导出，浏览器代码不能直接导入。
- `identity.ts`：可信生产者版本校验与进程世代身份。
- `heartbeat.ts`：有界后台例行终态合并、耗时分布与部分尾桶收尾。
- `writer-health.ts`：受保护、不递归、可注入持久器的限频累计检查点。
