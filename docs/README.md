# 文档索引

Mica Code 的文档分四处，各管一件事，互相不重复：

| 位置                                                                   | 读者             | 内容                                                      |
| ---------------------------------------------------------------------- | ---------------- | --------------------------------------------------------- |
| [README](../README.md)                                                 | 使用者           | 一句话定位、能力一览、安装与配置、命令/工具速查、集成入口 |
| `docs/`（本目录）                                                      | 集成方、维护者   | 稳定的设计文档：headless 执行层、Codex 系 driver 兼容     |
| [blogs/](../blogs/README.md)                                           | 想了解实现的读者 | 从 0 到 1 的开发记录，偏「当时为什么这么选」              |
| [官网 docs](https://qirong77.github.io/mica-code/docs/getting-started) | 使用者           | 同一批使用文档的网页版，随 `main` 自动部署                |
| `packages/*/README.md`                                                 | 包的使用者       | 单个包的 API、边界与目录结构                              |
| [AGENT.md](../AGENT.md)                                                | 维护者与 agent   | 架构约束、运行链路、实现约定、验证方式                    |

## 本目录文档

| 文档                                       | 内容                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| [headless-design.md](./headless-design.md) | Headless 执行层的内部设计：`HeadlessTurnExecutor`、单槽队列、turn 级重试、abort 语义、Codex 事件投影 |
| [multica-runtime.md](./multica-runtime.md) | 如何把 Mica 当成 Codex 系 driver 的后端：参数兼容、模型解析、会话复用、错误码                        |

## 演示素材

README 与官网用的图都在仓库里，可以直接重新生成：

| 文件                        | 用途                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `images/app-chat.png`       | README 头图：桌面端一问一答 + 状态栏用量                                                             |
| `images/app-turn-log.png`   | 回合日志、待办与工具执行                                                                             |
| `images/eval-benchmark.svg` | 五个 agent 的同题对比，由 `bun scripts/generate-eval-chart.mjs` 生成（口径与数据来源见 README 该节） |

截图不是手截的：用 `scripts/demo-mock-provider.mjs` 起一个脚本化 provider，在隔离的 `MICA_HOME` 里跑出固定形态的对话，再用受控浏览器按固定窗口尺寸截图。完整步骤见 [AGENT.md](../AGENT.md) 的「对外文档与演示素材」一节。

## 写作约定

- 面向读者写，不写实现细节；实现细节留给 `docs/`、包的 README 和 AGENT.md。
- 命令必须能直接复制执行；改命令、参数、配置字段时，同步检查 README、官网 docs 与 `packages/mica-builtin-commands/README.md`。
- 中文正文用全角标点，代码与路径用行内代码；表格优先于长段落。
- 不重复：同一件事只在一个地方详细写，其它地方给链接。
