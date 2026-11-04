# Mica Code Agent 手册

本文件由 `packages/mica-agent/prompt/index.ts` 注入系统提示词的 `<project-instructions>`，每次请求都会发送。它只放**每次都适用的硬规则**与**模块路由**；具体链路在同目录的 `agent/*.md`，改代码前按路由读对应文件，不要凭记忆。

优先级低于系统、开发者与当前用户指令；与代码不一致时以代码为准，并在同次变更里修正对应文件。

## 1. 默认开发流程

所有代码改动走 `agent/workflow.md`：在系统临时目录 clone 一份（目录 `mica_<slug>-<后缀>`）、开 `agent/<slug>-<后缀>` 分支（slug 从任务取名，要看出在改什么）、**副本与依赖都准备好之后才写出工作副本 / 分支 / 会话 id**、开发验证、**把分支推到远端**、合并进 main 并推送、回到用户那份 checkout 把 main 拉下来、在那里重新构建触发热更新、按固定格式汇报「已 / 未热更新」及原因。这四道闸门一步都不许静默跳过：做不到就写明卡在哪、用户要执行哪条命令。

例外只有不产生运行时代码差异的改动（纯文档 / `agent/**` / `AGENT.md`、README 与站点文案）和只读排查——它们直接在主工作区改，仍然不 commit、不 push、不必构建。

## 2. 硬规则

- 改前看 `git status --short`，保留用户已有改动；禁止 `git reset --hard`、`git checkout --`、强推、批量删除与 `--no-verify`。
- 只改任务相关文件，不顺手格式化、重命名或重构；只格式化自己改过的文件。
- 主工作区不自动 commit / push / 建分支 / 开 PR / 做合并提交；除了流程第 5 步的 `--ff-only` 快进，一切写操作只发生在开发流程的隔离副本里。
- 搜索用 `rg`，默认排除 `temp/`、`.backups/`、`node_modules/`、`dist/`、`out/`。
- 验证只跑到「与改动最接近」为止：针对性单测 + `bun run typecheck`。不跑全量测试、全量 lint 与真实子进程 E2E，除非用户要发布或明确要求（尺度见 `agent/build.md`）。
- 临时复现用隔离的 `MICA_HOME`；起桌面实例还要独立 `MICA_DESKTOP_USER_DATA`、`MICA_DESKTOP_PORT` 与 `--user-data-dir`。
- 临时探针命名 `.probe-*.mjs`、放仓库内、用完即删；交付前 `git status --short` 确认无残留。
- 只改前端（`apps/desktop/src/renderer`、配置页这类不进宿主的代码）可以放心构建与重启：热重载只刷页面，进行中的轮次停在边界后自动续跑（分层见 `agent/desktop.md`）。
- 产品能力优先做成插件：内核里不出现具体插件名词，插件也不靠改别人的数据伪造界面。
- 插件系统本身仍在迭代：现有 `PluginContext` 承载不了时先重构能力面，再在新机制上实现；不为单个插件在宿主里写死分支（见 `agent/plugins.md`）。
- 不为旧形态保留兼容分支：改了数据形态、目录布局、协议字段或插件格式，就删掉旧的解析与回退，只留一句「这个形态不再支持」；同次在 `plugins/evolution/migrations.ts` 加一条迁移并更新它的 README 迁移表。
- prompt、skills 索引与工具描述参与 prompt cache 前缀，改时保持前缀稳定。
- 文档与代码同次更新：改到 `agent/**` 的架构 / 路径 / 命令 / 配置 / 协议 / 流程 → 改对应文件；用户可见命令 → 根 `README.md`、`packages/mica-builtin-commands/README.md`、`apps/website/src/pages/docs/commands.astro`；公共 API → `packages/README.md` 与包 README；插件系统 → `plugins/README.md`。

## 3. 模块路由

| 文件                    | 改这些之前读它                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `agent/workflow.md`     | 任何代码改动的开工与收尾（隔离副本、分支推送、合并 main、主工作区拉取与构建热更新、汇报格式）     |
| `agent/architecture.md` | 代码地图、包职责、跨包依赖、新包或新 app                                                          |
| `agent/cli-runtime.md`  | CLI 启动、turn 循环与队列、重试与中止、provider adapter、prompt 拼装、模型档位                    |
| `agent/storage.md`      | 配置、会话快照字段、索引、turn lock、任何持久化形态                                               |
| `agent/headless.md`     | `mica app-server`、Codex 协议与 `mica/*` 通知、headless turn、drain 与续跑                        |
| `agent/plugins.md`      | 插件系统与能力面、清单驱动的界面、命令、工具、MCP、skills、数据迁移                               |
| `agent/agents.md`       | 子代理、压缩、定时循环、BTW、运行观察                                                             |
| `agent/desktop.md`      | 桌面端三层边界、对话与输入、统计、文件 / Git / 侧栏、受控浏览器与终端、日志与性能、构建后自我重载 |
| `agent/ui.md`           | Ink 组件、配置页、共享控件、主题、移动端与界面审查清单                                            |
| `agent/build.md`        | 构建与发布命令、测试项目、验证尺度、对外文档                                                      |

同一件事的约束只写在一个模块里，本文件不复制正文——两处都写必然漂移。
