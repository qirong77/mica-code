# Mica Code 文档

从安装到日常开发，再到脚本和客户端集成，在这里找到对应的指南。

## 使用指南

在线文档提供完整的操作步骤与配置参考。

| 指南                                                                       | 内容                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------- |
| [快速开始](https://qirong77.github.io/mica-code/docs/getting-started)      | 安装 CLI、连接模型、开始第一个编程任务。                |
| [模型与配置](https://qirong77.github.io/mica-code/docs/configuration)      | Provider、API 协议、模型列表、推理强度与环境变量。      |
| [桌面与浏览器](https://qirong77.github.io/mica-code/docs/desktop)          | 构建和启动工作区，使用对话、文件、Git、终端与远程访问。 |
| [命令与快捷键](https://qirong77.github.io/mica-code/docs/commands)         | 会话恢复、上下文压缩、并行任务、循环任务与键盘操作。    |
| [MCP、Skills 与角色](https://qirong77.github.io/mica-code/docs/extensions) | 接入工具、复用任务流程、定制角色与项目指令。            |
| [自动化与协议](https://qirong77.github.io/mica-code/docs/headless)         | `mica exec`、JSONL 事件、app-server 与脚本集成。        |
| [架构概览](https://qirong77.github.io/mica-code/docs/architecture)         | 执行链路、跨端复用、会话存储与源码导航。                |
| [评测方法](https://qirong77.github.io/mica-code/docs/benchmark/)           | DeepSWE 任务来源、自定义检查评分与数据范围。            |

## 集成与设计参考

本目录的设计文档面向需要理解执行语义或开发集成的读者。使用命令和配置时，优先阅读上面的操作指南。

| 文档                                                              | 内容                                                |
| ----------------------------------------------------------------- | --------------------------------------------------- |
| [Headless 执行层设计](./headless-design.md)                       | 无界面执行层、队列、重试、中止与 Codex 事件投影。   |
| [Codex 系驱动接入（Multica）](./multica-runtime.md)               | 参数兼容、模型解析、会话复用与错误处理。            |
| [共享包索引](../packages/README.md)                               | 包的职责、公共入口及依赖边界。                      |
| [交互式架构图](https://qirong77.github.io/mica-code/architecture) | CLI 与 Desktop 运行时地图，支持节点搜索与依赖追踪。 |

## 源码与维护

| 入口                                                      | 用途                                                 |
| --------------------------------------------------------- | ---------------------------------------------------- |
| [项目 README](../README.md)                               | 产品定位、能力概览与安装入口。                       |
| [网站文档源码](../apps/website/src/pages/docs/)           | 使用指南的维护位置，随网站发布。                     |
| [内置命令包](../packages/mica-builtin-commands/README.md) | 命令定义、装配与包 API。                             |
| [开发文章](../blogs/README.md)                            | 设计取舍与开发过程记录，技术细节以文章写作时为背景。 |
| [维护者手册](../AGENT.md)                                 | 仓库约束、运行链路、构建和验证方式。                 |

## 文档维护约定

- 使用指南以读者任务组织内容，给出前提、可复制示例与预期结果。实现细节放入设计文档或包文档。
- 命令、配置、路径与环境变量以源码为准。变更公开行为时同步检查官网文档、根 README 和对应包的 README。
- 示例使用公开服务地址与明确标记的占位符，不包含真实凭证、个人路径或未公开项目的依赖。
- 说明平台限制、具有副作用的操作与访问边界；不把兼容参数或界面模式写成尚未实现的能力。
- 每个主题保留一个主要说明位置，其他页面链接到该位置。截图和图表的再生成方式统一维护在维护者手册中。
