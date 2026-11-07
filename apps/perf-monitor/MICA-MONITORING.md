# Mica 与整机性能监控基线

这份文件记录「要在哪里看、看什么、哪些数据不能当证据」。条目都在 2026-11-07 核对过；路径或端口变了就同次改这里。

## 1. 观测入口

| 对象 | 位置 |
| --- | --- |
| 监控台（Web） | http://127.0.0.1:9316 ，页面锚点 `#overview` `#mica` `#processes` `#incidents` `#coverage` |
| 监控台代码 | `apps/perf-monitor/`（服务端 `server/index.ts`、Mica 聚合 `server/mica.ts`、前端 `src/`） |
| 主机资源日志 | `~/Library/Logs/cpu-watch/`：`resource-YYYYMMDD.jsonl`、`registry-YYYYMMDD.jsonl`、`cpu-YYYYMMDD.log`、`incidents/` |
| Mica 诊断日志 | `~/Library/Logs/mica/`（`MICA_LOG_DIR` 可覆盖；当前约 194 MB，16 MB 分片、保留 7 天、目录上限 256 MB） |
| 会话快照 | `~/.mica/sessions/`（`MICA_HOME` 可覆盖；当前约 1277 个文件 / 631 MB） |
| 源码仓库 | `/Users/qironglin/Desktop/VsGo-Projects/mica-code` |
| 桌面端运行产物 | `apps/desktop/dist/mac-arm64/mica-code-app.app`（Electron 主进程 + GPU/Renderer/Utility helpers） |
| CLI / 会话宿主 | `~/.local/lib/mica/mica`（`mica app-server …`、`mica` TUI、插件脚本） |
| 监控台服务日志 | `~/Library/Logs/mica-perf-monitor/runtime.log`、`error.log` |

## 2. 采集与守护进程

| launchd 标签 | 作用 | 周期 | 数据 |
| --- | --- | --- | --- |
| `com.qirong.mica-perf-web`（gui） | 监控台服务 | 常驻 | 端口 9316，仅 loopback |
| `com.qirong.mica-resource-watch`（gui） | 进程/系统资源采集 | 60 s | `~/Library/Logs/cpu-watch`；源码 `apps/perf-monitor/collectors/mica-resource-watch.py` |
| `com.qirong.cpu-watch`（gui） | CPU 尖峰 + 进程树 | 4 s | 同目录 `cpu-*.log`；独立于资源采集 |
| `system/com.qirong.mica-perf-capture`（root） | 异常触发时 `fs_usage` 抓写入路径 | 按需 | `incidents/` 现场附件 |
| `system/com.qirong.lca-tame`（root） | LCAMon 占空比限速 + 看门狗 | 常驻 | 配置 `~/.mica/tools/lca-tame.conf`；看门狗 150% / 20 s 窗口 / 30 分钟冷却 |
| `com.qirong.ccm-guard`（gui） | CCM 大文件瘦身 | 常驻 | `~/.mica/tools/` |

重装采集器：在 `apps/perf-monitor` 里 `bun run collector:install`（只重启资源采集器）；监控台自身 `bun run service:install`（只重启 Web 服务）。`com.zuche.micabridge` 是内网工具，不属于 Mica，不要算进 Mica 进程。

## 3. Mica 诊断日志的作用域

写入方是 `packages/mica-diagnostics`（唯一写入器）：一行一个 JSON，字段 `at / level / scope / event`。

| scope / 文件 | 内容 | 谁在写 |
| --- | --- | --- |
| `mem-YYYYMMDD.jsonl` | 每 30 s 的进程内存：`host`（`main`/`runtime`/`app-server`/`tui`/`exec`）、`rss`、`pid`、`session`、`turn`、`windows`、`byType` | 桌面主进程、运行时、每个会话宿主、TUI |
| `perf-YYYYMMDD.jsonl` | 渲染采样：`pageId`、`lag`、`long`、`longN`、`dom`、`rows`、`heapMB`、`vis`、`sid`；`batch` 行带 `dropped` | 每个渲染页（窗口可见时按秒） |
| `invoke-YYYYMMDD.jsonl` | IPC 通道耗时：`event`（通道名）、`ms`、`kind`（`call` / `slow` / `failed`），慢行带 `plugin` / `sid` / `cwd` | 桌面端 host 层 |
| `app-server-YYYYMMDD.jsonl` | 会话宿主 `boot` / `shutdown`、`argv`（含 `--session`） | `mica app-server` |
| `chat-YYYYMMDD.jsonl` | `chat.idle-reap`：宿主回收、`idleSeconds`、`hostCount` | 桌面端 host 层 |
| `main-*` / `runtime-*` / `tui-*` / `exec-*` | 各自身份的启动、错误、慢操作 | 对应进程 |
| `plugin-*.jsonl` | 插件命令与工具的慢/失败记录 | 各插件 |

口径提醒：Bun/JSC 的 `heapUsed` 不可信，宿主内存一律看 `rss`（日志会标 `heapReliable: false`）；要 JS 堆只能拍快照。`footprint`（资源采集）与 `rss`（宿主自报）是两套记账，不能相加当物理内存。

## 4. 监控台接口

| 接口 | 内容 |
| --- | --- |
| `GET /api/health` | 服务存活 |
| `GET /api/days` | 有资源采样的日期 |
| `GET /api/overview?day=&range=` | 整机：趋势、进程排行、应用分组、异常现场、采集覆盖 |
| `GET /api/mica?day=&range=` | Mica：进程构成、活跃宿主、宿主内存走势、渲染/调用耗时、生命周期、会话体积、诊断数据自检 |
| `GET /api/processes/:pid` | 单个 PID 代次的历史 |
| `GET /api/incidents/:id` 与 `/artifacts/:name` | 异常现场与脱敏附件（≤256 KiB） |

全部只读、仅 loopback，拒绝跨站读取。页面每 15 s（Mica 页 20 s）轮询；刷新页面不会提高采集精度。

## 5. 归因时最常看的代码

| 位置 | 为什么 |
| --- | --- |
| `packages/mica-diagnostics/` | 日志格式、`startMemorySampler`、慢调用阈值（300 ms）、聚合读取 |
| `apps/desktop/src/host/git-ops.js` | 工作树扫描的 in-flight 去重（`worktreeInFlight`）、缓存键 |
| `apps/desktop/src/host/git.js` | `git:status` / `workspace-status` 的 TTL 与轮询，10 s 轮询要求 TTL 不短于它 |
| `apps/desktop/src/host/chat-idle.js` | 闲置会话宿主回收：30 分钟、至少保留 1 个、最多保留 3 个 |
| `apps/desktop/src/main/window-idle.js` | 隐藏窗口回收：终端 30 min（`MICA_TERMINAL_IDLE_REAP_MS`）、浏览器 60 min（`MICA_BROWSER_IDLE_REAP_MS`），`0` 关闭 |
| `apps/desktop/src/main/browser/browser-manager.js` | 每个浏览器标签一个 renderer；窗口只隐藏不销毁 |
| `apps/desktop/src/renderer/src/perf-probe.js` | 渲染采样与 lag 的可见性口径 |
| `apps/perf-monitor/server/mica.ts` | 本页所有聚合口径与阈值 |

## 6. 两个会话留下的结论（历史证据，不是当前状态）

### 会话「性能监控」`20261015T095809Z-368bn3`（2026-10-15 → 11-06）

- **LCAMon 运行中劣化**：11-04 10:53 卡死前跑到 400–550%，当天 857 次 CPU 尖峰几乎都归它；加入占空比 + 看门狗后由 1.25 核降到可控。
- **git 层真 bug 已修**：`cachedWorktreeRead` 只缓存已完成结果，7 个全树扫描并发；`git:status` 更是完全没缓存。修复后按 32 / 79 项测试通过。
- **Spotlight 排除生效**：`VsGo-Projects` 加入隐私列表后，`package.json` 命中 22,255 → 0；`.metadata_never_index` 在本机实测无效，SIP 阻止脚本写 plist，只能 GUI 添加。
- **Cursor / git-ai 放大效应**：重启前 `cursor --version` 被拉起 6306 次（git-ai 在临时 HOME 里探测编辑器）；`~/.git-ai/config.json` 现为 `allow_repositories: ["*xiaojukeji*"]`，Cursor 已卸载。
- **孤儿宿主**：`exec.flows.test.ts` 遗留的 `--model mock/mock-chat-override` bun 进程烧了 4.8 CPU 小时；杀掉后 load 15.88 → 7.67。
- **Mica 5.28 GB 的构成**：与活动监视器 5.22 GB 对齐，其中 GPU helper 1.4 GB（峰值 1.9 GB），主进程持有 12 个窗口、23 个 renderer——你只看到一个窗口。因此新增了隐藏窗口回收与 `chat.idle-reap`。
- 本监控台（`apps/perf-monitor`）就是这次会话建的。

### 会话「mica-性能监控」`20261104T034213Z-loatwr`（2026-11-04 → 11-06）

- **埋点补齐**：新增 `packages/mica-diagnostics`，覆盖 runtime / main / app-server / tui / exec 五类进程；`timedResult` 带调用方归因。
- **`rawUsage` 彻底移除**：会话里 199,713 字节的 usage 里 199,513 字节是无人读取的 `attribution`。写入侧不再写、存量按 evolution 迁移清掉（1133 个文件、13.9 万条）：会话目录 1038 MB → 599 MB，最大单文件 153 MB → 19 MB。迁移默认不再整份备份。
- **Performance 页曾自我失效**：4 MB 读取预算按 mtime 从新到旧分配，perf 文件一大就把 mem 挤出，面板显示「没有数据」；已改为分批异步读取 + 有界缓存（冷 294 ms、命中 1.6 ms）。
- **lag 假尖峰**：11.7 s 的 `lag` 对应 `longN=0`，是窗口重新可见的恢复帧；现在只在前后两次采样都可见时才计。
- **瞬时大分配**：某会话宿主 30 秒内 180 MB → 1.86 GB（峰值 2.24 GB），5 分钟后回落到 80 MB，来自一个仅 6 条消息、含 2 个子代理的回合；不是缓慢泄漏。
- **待观察**：主窗口 JS 堆 3 小时从 4.3 MB 涨到 170 MB（DOM 8k–22k 波动），未归因；ChatView 虚拟化仍未做。
- **慢调用基准**：后端 6817 次调用里 27 次（0.4%）超 1 s 属正常水位；`git:status` 中位数已接近原生 git（26–100 ms）。

## 7. 米卡页怎么读

- **进程 Footprint**：来自资源采集最后一份快照的 Mica 进程合计，按类型拆分；orphan（父进程已退出）标红。
- **宿主内存**：`mem` 日志按分钟取每个 PID 最后一条后相加；「活跃」= 10 分钟内仍有采样，只采到一两次的短命宿主单独计数（测试与一次性命令会产生很多）。
- **渲染帧间隔**：只看 `vis=1` 的采样；页面隐藏时不采样，没有数据不等于健康。p99 > 16 ms 会提示。
- **主机调用**：`kind=call` 计入次数，`slow`/`failed` 是同一批调用的附加判定；p95 只算成功调用。
- **会话快照体积**：整目录统计 + 最大 5 个文件；单个会话变大通常来自历史与 checkpoint，不再有 `rawUsage`。

## 8. 环境边界

- `fs_usage` 只有 root 能跑，写入路径归因依赖 `system/com.qirong.mica-perf-capture`；没装时页面只给「未确认运行」。
- `proc_pid_rusage` 的 I/O 字段要按 V4 读；V1 恒为 0（旧采集器结论不成立）。
- Spotlight 隐私列表受 SIP 保护，只能系统设置里手动加；不要用脚本改。
- 诊断日志只保留 7 天、单文件 16 MB 分片；早于保留期的数据不可重建。
- Mica 桌面端与 CLI 都写同一个日志目录，`host` + `pid` 区分；PID 复用时以当日 `registry` 登记为准。
