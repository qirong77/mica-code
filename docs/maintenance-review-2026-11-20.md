# 整体维护审查与修复（2026-11-20）

审查基线：`3b7417dc`（2026-11-20，包含 Notebook 独立 HTTP API）。本轮沿 2026-11-11
审查之后的协议、持久化和官方插件改动复查调用链，改动直接留在当前 checkout，未提交、构建、安装或重启。
工作区另有未归属的 `plugins/floatingwindow/` 改动，本轮未触碰，也不把它们计入下面的结论。

## 已处理的兼容代码

项目规则是：持久化形态变化必须由 Evolution 一次性迁移，运行时只认当前形态；无法安全转换的原文私有归档，损坏数据不覆盖。
本轮实际删除了以下运行时旧形态分支：

| 领域 | 旧形态 | 处理 |
| --- | --- | --- |
| Schedule | `plans/stages` 两层排期；读取、页面写入和导入时转换 | 新增 `schedule-plans-stages` 数据迁移，使用 `data.json.lock` 和原子替换，归档原文；删除 `schedule.ts`、`store.ts`、`writer.ts` 与页面中的运行时转换，当前只认扁平 `tasks`。缺失或重复 id 在迁移时一次性确定，不再每次读取随机变化。 |
| Connections | 纯地址数组、缺 `version` 的 `{ peers }` | 新增 `connections-peer-store` 数据迁移，归档原文后写入 `{ version: 1, peers }`；删除 `peers.ts` / `persistence.ts` 的读取时回写与数组解析。 |
| Notebook | 独立 MCP 停用项 `mica-plugin-notebook` | Notebook 当前是 HTTP API；新增 `notebook-http-api` 会话迁移，清理上一条历史迁移留下的无效 MCP 停用项，保留其它 MCP 选择。同步修正 README、存储说明和源码注释。 |
| 会话状态 | 缺失或非法顶层 `turnState` | 新增 `session-turn-state` 会话迁移，补为 `completed`；桌面快速读取路径统一只对剩余损坏值做 `completed` 投影，避免各路径不一致。 |
| 用量统计 | 缺失或非法 `occurredAt` 时按会话创建时间 / 子代理开始时间统计 | 存量由已有 `usage-occurred-at` 迁移补齐；统计解析现在跳过未迁移的无日期记录，不再伪造统计日期。合成账本输入仍可显式提供 fallback，但持久化会话解析不再使用它。 |

## 无用与冗余代码

本轮确认并删除：

- `plugins/notebook/service.ts` 中无调用的 `readDocumentForUpdate` 和不可达的重复文本分支；
- 共享编辑器 Prism / Shiki Facade 中无调用的语言选项函数及无用 import；
- Schedule 中重复维护旧 `plans/stages` 的转换与存储校验路径；
- Connections 中重复维护旧数组读取、检测和回写的一整条运行时路径。

删除后，旧形态只在对应 Evolution 迁移和迁移测试中出现；当前业务代码不再把它们当作可用输入。

## 仍保留、但不属于旧持久化兼容的边界

- Electron `userData/workspace.json` 是桌面 UI 状态的一次性导入，不属于 `$MICA_HOME` 会话或插件数据；新 `ui-state.json` 写入成功后即删除旧文件。
- 旧工具名在历史消息展示和只读投影中的归一化，是不可变对话内容的展示层处理，不是新配置或新会话的存储兼容。
- `validate-config` 中的配置键迁移属于配置加载前的启动迁移；它不作为插件数据读取时的回退。
- 对 JSON 损坏、非法字段和缺失可选展示字段的拒绝或安全投影仍保留；它们不是旧版本成功路径，不会把数据静默当成合法的新记录写回。

## 文档同步

- `docs/README.md` 已指向本记录；上一轮记录保留为历史参考。
- `agent/storage.md`、`plugins/README.md`、`plugins/evolution/README.md`、Notebook / Schedule / Connections README 已同步当前协议、迁移入口和“不保留运行时兼容分支”的边界。

## 验证记录

| 验证 | 结果 |
| --- | --- |
| Evolution、Schedule、Connections 定点 Vitest | 8 个文件，95 项通过 |
| Desktop stats / scanner / session-reader 定点 Bun | 64 项通过，0 失败 |
| 根 TypeScript | 通过 |
| `git diff --check` | 通过 |

上述验证使用隔离测试数据，没有启动当前应用、调用真实计费模型或修改真实用户会话。

## 交付与剩余边界

- 修改尚未提交、构建、安装或重启；运行中的实例继续使用此前产物。
- 本轮没有把其它会话产生的 `plugins/floatingwindow/` 未提交改动纳入或回滚；交付前需要按文件归属另行 review。
- 本记录覆盖的是当前 HEAD 之后至本轮工作区所能确认的持久化、插件协议和桌面统计路径；未把所有业务级 `fallback`（例如网络、模型配置和 UI 布局兜底）误判成旧数据兼容。
