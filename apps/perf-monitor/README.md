# Mica 本机性能监控台

React + Vite + TypeScript + ECharts + Ant Design 的本机 Web 监控应用。独立于 Mica 桌面端运行，读取已有采集日志，不启动新的全盘扫描或修改采集配置。

## 运行

```sh
cd apps/perf-monitor
npm ci
npm run build
bun run start
```

打开 http://127.0.0.1:9316 。仅监听 loopback；进程命令行与现场路径不对外网提供。

开发时分别运行 `bun run api` 与 `npm run dev`，打开 http://127.0.0.1:5178 。Vite 将 `/api` 转发到 9316。

安装为用户 LaunchAgent（不需要 sudo，登录后自动启动）：

```sh
bun run service:install
```

服务标签 `com.qirong.mica-perf-web`，日志在 `~/Library/Logs/mica-perf-monitor/`。安装器仅重启这个 Web 服务。卸载：

```sh
launchctl bootout gui/$(id -u)/com.qirong.mica-perf-web
rm ~/Library/LaunchAgents/com.qirong.mica-perf-web.plist
```

自定义日志目录：`MICA_PERF_LOG_DIR`（默认 `~/Library/Logs/cpu-watch`）；自定义 API / 生产服务端口：`MICA_PERF_PORT`（默认 9316）。开发代理固定 9316。

## 监控内容

- 概览：系统内存压力、swap 当前用量、换入/换出速率、磁盘吞吐、load、GPU、当前整机 CPU。
- 历史：按日期和 1h / 6h / 24h / 7d 选择范围；重启、采样断档标记；历史日期以当天最后采样为范围终点。降采样保留各信号峰值。
- 进程：footprint、RSS、内存增长、CPU、线程、文件句柄、nice；应用分组；PID 详情中的父进程、脱敏命令行和历史曲线。
- mica（`#mica`）：Mica 自身的进程构成（主进程 / 渲染 / GPU / 会话宿主 / 插件 / CLI）、活跃宿主 RSS 与窗口内增长、渲染帧间隔与 JS 堆、IPC 通道耗时、宿主生命周期与窗口回收、会话快照体积，以及诊断日志各作用域的新鲜度。数据来自 `~/Library/Logs/mica` 的真实诊断日志。
- 异常：当时的系统状态、增长/内存/CPU 排行、进程树，以及 lsof / fs_usage / sample / vmmap 附件的受限文本预览。
- 采集覆盖：资源与 CPU 日志新鲜度、root 捕获器安装/运行状态、LCA 守护进程状态和明确的数据缺口。

环境路径、launchd 标签、日志作用域与历史结论整理在 [MICA-MONITORING.md](./MICA-MONITORING.md)。

## 数据来源与解释

`resource-YYYYMMDD.jsonl[.N]` 提供系统和进程资源，`registry-YYYYMMDD.jsonl` 提供进程登记，`cpu-YYYYMMDD.log[.N]` 中的 MEM 行补充旧系统历史和 GPU，`incidents/` 提供现场。

服务增量读取完整 JSONL 行，兼容写入中最后一行、轮转与删除。内存中只保留趋势、每个文件最后一份进程快照和登记表；进程单项历史按需流式查询。保留最近八个有数据的日期，可覆盖七天跨日窗口。网页每 15 秒轮询，可暂停；后台页面暂停轮询。采集本身通常每 60 秒一次，刷新网页不会提高采样精度。

**界面用于查看证据，不自动宣称某进程是卡死根因：**

- swap 是当前已分配交换文件的使用量，macOS 会动态扩缩容；高比例不能独立证明卡死。
- 当前整机 CPU 使用 Node/Bun 读取的 OS CPU tick 差值，与历史可读进程 CPU 总和分开。进程 CPU 100% = 一个核心，可超过 100%。采集器刚启动不足 10 秒的 CPU 数据留空。
- footprint、RSS 与共享/压缩内存的记账不同，应用汇总不能相加当成物理内存使用量。逐进程排行基于当次被记录的进程；未获权限的进程不在逐进程汇总内。
- 旧 MEM 文本没有逐进程内存、系统压力等级或磁盘吞吐；不推算未知数据。旧 swapout 只有页数/秒，未记录页大小，因此不伪造 MB/s。
- V2 采集器使用正确的 rusage V4 读取同用户、获权限进程的 I/O 字节增量；系统受保护进程仍有缺口。lsof 仅证明文件句柄存在，不证明文件正在被写入。root 捕获器未安装时，无法对实际写入路径作归因。
- 旧采集器请求 V1 却读取 V4 字段，I/O/峰值无效；CPU 又缺少 Mach timebase 换算，约低估 41.67 倍（本机）。旧 CPU 和峰值在页面隐藏，原始日志保留。新 `schema:2` 采样修正单位与接口，`imx` 是内核记账窗口峰值，不能解释成网页选定区间的峰值。首次登记时间不等于启动时间。新记录保存每条进程启动代次，旧记录仍可能存在 PID 复用歧义。
- 内存采集部署之前的增长来源无法事后重建；只有系统曲线的旧日期会没有进程详情。GPU 只匹配 90 秒内最近的独立 MEM 数据。
- LCA 页面状态只检查 launchd，不能替代占空比 / nice 的完整自检。

资源采集器源码已纳入 `collectors/`，可运行 `npm run collector:check` 验证原生 CPU 单位与实际写入字节，再用 `bun run collector:install` 安装并仅重启资源采集器。安装前备份旧脚本，不重启 Mica。

root 文件路径抓取沿用 `~/.mica/tools/install-perf-capture.sh`；本应用只读，不替用户执行提权或修改安全代理。

## API

所有 API 只读，无跨域响应，返回 JSON。缺失数据保留 `null`。

| 接口                                                | 内容                                   |
| --------------------------------------------------- | -------------------------------------- |
| `GET /api/health`                                   | 服务存活（不代表采集正常）             |
| `GET /api/days`                                     | 可用日期                               |
| `GET /api/overview?day=YYYY-MM-DD&range=6h`         | 主机、最后采样、趋势、排行、现场和覆盖 |
| `GET /api/mica?day=YYYY-MM-DD&range=6h`             | Mica 进程构成、宿主内存与增长、渲染/调用耗时、生命周期、会话体积、诊断日志新鲜度 |
| `GET /api/processes/:pid?day=YYYY-MM-DD&identity=…` | 该代 PID 的历史与登记                  |
| `GET /api/incidents/:id`                            | 异常详情                               |
| `GET /api/incidents/:id/artifacts/:name`            | 脱敏文本预览，最多 256 KiB             |

API 不接受任意文件路径、执行命令或写操作。附件限制在现场目录，拒绝路径穿越和出目录的符号链接。

## 验证

```sh
npm test
npm run typecheck
npm run build
```

针对性测试覆盖追加写、残缺行、损坏行、轮转、PID 代次、重启/断档、旧 MEM 日志、峰值保留、路径限制与输出截断；`server/mica.test.ts` 覆盖 Mica 进程归类、孤儿标记、宿主内存按分钟汇总、渲染分位数、慢调用计数、生命周期与增量读取。
