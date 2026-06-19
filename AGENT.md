# Mica Code 仓库说明

## 项目定位

- Mica Code 是一个基于 Bun + TypeScript + React（Ink）的 CLI code agent。
- 目标是把 CLI 启动、运行时 turn loop、agent provider、工具、命令、会话、配置、UI、插件分层管理，为 compact、memory、todo、fork、multi-agent 等能力保留稳定扩展点。
- 当前仓库采用 `src/` 应用装配层 + `packages/` 可复用包的结构。新增通用能力优先放入对应 package，`src/` 只做应用级 wiring。

## 维护要求

- 如果一次改动涉及项目整体架构、目录结构、关键运行链路、公共 package 边界、配置/数据位置、常用命令或开发约束变化，必须同步修改本 `AGENT.md`。
- 如果新增长期模块、核心服务、命令体系、runtime 生命周期、session 存储格式、工具注册方式或 UI 状态模型，也必须更新本文件中的对应章节。
- 不要让本文件变成实现细节日志；只记录会影响后续 agent/开发者理解和修改项目的稳定约定。

## 特别注意

- 如果改动影响旧数据或旧架构，全部使用新的写法，禁止先保留旧路径再逐步迭代，而是一次性完成。
