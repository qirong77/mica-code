# Mica Code 文档

[在线文档](https://qirong77.github.io/mica-code/docs/)提供按任务组织的操作指南。本目录保存设计参考、协议说明与素材复现方法。

## 使用指南

| 阅读路径 | 指南 |
| --- | --- |
| **开始使用** | [快速开始](https://qirong77.github.io/mica-code/docs/getting-started/) · [模型与配置](https://qirong77.github.io/mica-code/docs/configuration/) · [桌面与浏览器](https://qirong77.github.io/mica-code/docs/desktop/) |
| **日常工作** | [日常开发流程](https://qirong77.github.io/mica-code/docs/workflows/) · [命令与快捷键](https://qirong77.github.io/mica-code/docs/commands/) · [远程与手机访问](https://qirong77.github.io/mica-code/docs/remote-access/) |
| **按需扩展** | [插件与能力管理](https://qirong77.github.io/mica-code/docs/plugins/) · [Skills、MCP 与角色](https://qirong77.github.io/mica-code/docs/extensions/) |
| **集成与原理** | [自动化与协议](https://qirong77.github.io/mica-code/docs/headless/) · [架构概览](https://qirong77.github.io/mica-code/docs/architecture/) · [评测方法](https://qirong77.github.io/mica-code/docs/benchmark/) |

第一次使用从快速开始进入；需要连接手机、管理记忆或协调子会话时，直接查看对应的日常工作与扩展指南。

## 设计与维护参考

| 文档 | 内容 |
| --- | --- |
| [Headless 执行层设计](./headless-design.md) | 无界面执行层、队列、重试、中止与 Codex 事件投影 |
| [Codex 系驱动接入](./multica-runtime.md) | 参数兼容、模型解析、会话复用与错误处理 |
| [共享包索引](../packages/README.md) | 包的职责、公共入口及依赖边界 |
| [交互式架构图](https://qirong77.github.io/mica-code/architecture/) | CLI 与 Desktop 运行时地图、节点搜索与依赖追踪 |
| [演示素材复现](./demo-assets.md) | 隔离示例项目、脚本化 provider、运行时与截图流程 |
| [官网开发说明](../apps/website/README.md) | 页面结构、主题、文档导航和构建验证 |

## 文档维护

- 产品介绍放在[项目 README](../README.md)与官网首页；操作步骤放在[官网文档源码](../apps/website/src/pages/docs/)，设计细节放在本目录或包 README。
- 使用指南围绕读者任务组织，说明前提、可复制示例与预期结果。一个主题保留一个主要位置，其余页面通过链接进入。
- 命令、配置、路径和环境变量以当前代码为准。公开行为变化时，同步 README、官网指南与对应包文档。
- 示例只用公开服务、明确的占位符与隔离数据。截图和评测数字要标明来源，生成方法可复现。
- 网站修改运行类型检查、静态构建，并检查桌面与移动视口。完整仓库约定见[维护者手册](../AGENT.md)。
