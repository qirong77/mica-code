<p align="center">
  <img src="./apps/desktop/resources/icon.svg" width="64" height="64" alt="Mica Code">
</p>

<h1 align="center">Mica Code</h1>

<p align="center">
  <strong>从一个想法，到可运行的代码。</strong><br>
  源码公开、缓存优先的 AI 编程工作区。连接你的模型，把工作接着做完。
</p>

<p align="center">
  <a href="https://qirong77.github.io/mica-code/">官网</a> ·
  <a href="https://qirong77.github.io/mica-code/docs/">文档</a> ·
  <a href="https://qirong77.github.io/mica-code/docs/getting-started/">快速开始</a> ·
  <a href="https://github.com/qirong77/mica-code/releases/latest">CLI 下载</a> ·
  <a href="https://github.com/qirong77/mica-code/issues">问题反馈</a>
</p>

<p align="center">
  <a href="https://github.com/qirong77/mica-code/actions/workflows/build-binaries.yml"><img alt="Build" src="https://github.com/qirong77/mica-code/actions/workflows/build-binaries.yml/badge.svg"></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-334155?labelColor=17212d">
  <a href="https://github.com/qirong77/mica-code/releases"><img alt="CLI: macOS / Linux" src="https://img.shields.io/badge/CLI-macOS%20%2F%20Linux-087d96?labelColor=17212d"></a>
</p>

Mica 是一个可以实际动手的 coding agent：阅读项目、修改代码、运行命令和测试，再把过程与结果交给你审阅。在终端、桌面或浏览器里推进任务，也可以将同一套执行能力接入脚本和客户端。

## 文档

按照手头的任务选择入口，完整目录见 [Mica 文档](https://qirong77.github.io/mica-code/docs/)。

| 我想…… | 从这里开始 |
| --- | --- |
| 安装并连接模型 | [快速开始](https://qirong77.github.io/mica-code/docs/getting-started/) · [模型与配置](https://qirong77.github.io/mica-code/docs/configuration/) |
| 在工作区中完成任务 | [实战演示](https://qirong77.github.io/mica-code/docs/demos/) · [日常开发流程](https://qirong77.github.io/mica-code/docs/workflows/) · [桌面与浏览器](https://qirong77.github.io/mica-code/docs/desktop/) · [命令与快捷键](https://qirong77.github.io/mica-code/docs/commands/) |
| 连接其他设备或扩展能力 | [远程与手机访问](https://qirong77.github.io/mica-code/docs/remote-access/) · [插件与能力管理](https://qirong77.github.io/mica-code/docs/plugins/) · [Skills、MCP 与角色](https://qirong77.github.io/mica-code/docs/extensions/) |
| 集成或了解内部设计 | [自动化与协议](https://qirong77.github.io/mica-code/docs/headless/) · [架构概览](https://qirong77.github.io/mica-code/docs/architecture/) · [设计文档](./docs/README.md) |

文档以当前仓库源码为准；已发布 CLI 的功能可能有所不同，可用 `mica --version` 查看版本并对照 [Release 说明](https://github.com/qirong77/mica-code/releases)。

<p align="center">
  <img src="./images/app-chat.png?v=3bcd4ffe" width="1100" alt="Mica 工作区：在示例项目中查看任务过程、代码与验证结果">
</p>
<p align="center"><sub>截图来自真实运行时与隔离示例项目；模型响应由本地脚本生成，图中用量为演示值。<a href="./docs/demo-assets.md">了解截图的复现方式</a></sub></p>

## 围绕真实任务构建

- **从理解到验证**：搜索和引用文件、修改代码、运行 Shell 或交互式终端，并查看实际输出。
- **为长任务保留线索**：恢复或分叉会话、回退检查点；用会话笔记记录决定，用记忆保存跨会话的偏好和项目经验。
- **整理自己的笔记**：Notebook 提供左侧目录树和完整富文本／表格编辑器，正文保存在本机，界面跟随 Mica 主题；编辑器依赖首次从 CDN 加载。[使用说明](./plugins/notebook/README.md)
- **缓存优先的上下文**：保持请求前缀稳定，先在本地清理冗长工具输出，再按需生成模型摘要。实际缓存效果取决于模型服务。
- **让工作并行推进**：用子代理分担探索、实现、审查和测试；用 Sidecar 启动可以持续追问的独立子会话。
- **选择适合的入口**：终端 TUI、桌面与 Web 工作区、手机连接、Headless 自动化，各自面向不同工作场景。
- **组合自己的工具**：连接兼容模型服务和 MCP，用 Skills、角色与插件复用工作方法。

[看看一次开发任务如何推进 →](https://qirong77.github.io/mica-code/docs/workflows/)

## 安装并完成第一个任务

### 1. 安装 CLI

准备 **Node.js 22+** 和支持工具调用的模型服务。macOS / Linux 可以安装预构建 CLI（Apple Silicon、Intel、x64 / ARM64 Linux）：

```bash
curl -fsSL https://github.com/qirong77/mica-code/releases/latest/download/install.sh | sh
mica --version
```

预构建 CLI 不需要 Bun。安装器会校验 SHA-256，默认将程序放在 `~/.local/lib/mica`，并创建 `~/.local/bin/mica` 启动器。如果找不到命令，可在当前终端执行 `export PATH="$HOME/.local/bin:$PATH"`，并将其加入 shell 配置。Windows 可使用下方的[源码运行入口](#从源码运行与参与开发)。

### 2. 连接模型

在项目目录启动 Mica，输入 `/config` 打开配置页，填写服务商的 API 地址、API key 和可用的模型 ID，按服务实际支持的接口选择 `openai_chat_completions` 或 `openai_responses`。模型列表需要手动配置。配置页会自动保存有效设置；回到终端后用 `/model` 选择模型。

```bash
cd your-project
mica
```

配置与会话默认保存在 `~/.mica`；需要隔离环境时可设置 `MICA_HOME`。服务商配置、模型默认值和排查方法见[模型与配置](https://qirong77.github.io/mica-code/docs/configuration/)。

### 3. 给它一个可以验证的任务

> 阅读项目结构，找出测试入口。先说明准备如何修改，再为一个边界情况补充测试，运行相关验证，并汇报改动和结果。

执行时可以输入 `@` 引用文件、继续发送补充要求；输入框为空时按 `Shift+←` 撤回待发消息，按 `Ctrl+C` 停止当前任务。完成后查看 diff 和测试输出，再决定下一步。用 `/resume` 可以恢复已有会话；更多操作见[命令与快捷键](https://qirong77.github.io/mica-code/docs/commands/)。

想先在隔离项目中练习？[实战演示](https://qirong77.github.io/mica-code/docs/demos/)从一段有失败测试的代码出发，展示审查、修复、子代理协作和自动化事件处理。

## 选择你的工作入口

### 桌面与浏览器

项目分组和历史会话、代码编辑器、Git diff、工作区终端、回合日志与用量统计，都可以在同一处查看。桌面应用提供受控浏览器与终端窗口；独立 Web 工作区也提供对话、文件、Git 和工作区终端。

<p align="center">
  <img src="./images/app-turn-log.png?v=0f5503ca" width="1100" alt="Mica 执行记录：示例任务中的工具调用、代码修改与测试输出">
</p>
<p align="center"><sub>演示使用真实运行时和工具；模型响应由本地脚本生成，用量为演示值。</sub></p>

目前 Release 提供的是预构建 **CLI**；桌面与独立 Web 工作区从源码启动。下面以 macOS / Linux 为例，准备 Git、Bun、Node.js 22+ 和 npm。示例将源码 CLI 安装到独立目录，以便与上面的发布版共存：

```bash
git clone https://github.com/qirong77/mica-code.git
cd mica-code
bun install
MICA_NO_RC=1 \
  MICA_INSTALL_PACKAGE_DIR="$HOME/.local/lib/mica-dev" \
  MICA_INSTALL_DIR="$HOME/.local/bin/mica-dev" \
  bun run build
cd apps/desktop
npm install
MICA_CLI_PATH="$HOME/.local/bin/mica-dev/mica" npm run dev
```

打开桌面应用后，在 Settings 配置模型并选择项目目录。桌面与终端默认共享 `~/.mica` 下的配置和会话。桌面会调用已安装的 CLI；修改 CLI 源码后，需要用相同的安装目录重新构建，并继续用 `MICA_CLI_PATH` 指向它。默认执行 `bun run build` 会更新 `~/.local/lib/mica` 和 `~/.local/bin/mica`，可能覆盖已有的发布版入口，还可能修改 shell 配置中的 PATH；上面的 `MICA_NO_RC=1` 避免改动 shell 配置。

需要独立浏览器工作区时，先停止桌面开发进程，或另开一个终端并进入 `apps/desktop`。`npm run build` 也会构建并安装 CLI，因此沿用相同的隔离目录：

```bash
MICA_NO_RC=1 \
  MICA_INSTALL_PACKAGE_DIR="$HOME/.local/lib/mica-dev" \
  MICA_INSTALL_DIR="$HOME/.local/bin/mica-dev" \
  npm run build
MICA_CLI_PATH="$HOME/.local/bin/mica-dev/mica" \
  npm run start:web -- --host 127.0.0.1 --port 8787 --no-share
```

打开启动日志中的地址，通常为 `http://127.0.0.1:8787`。完整构建、平台条件与排查方法见[桌面与浏览器指南](https://qirong77.github.io/mica-code/docs/desktop/)。

### 手机与远程访问

设备可以直连开发机时，通过 **Connections** 打开运行时地址并输入访问口令；跨网络时可通过 **Mobile Relay** 插件接入中转机。模型请求、文件操作和命令仍在开发机上执行。

<details>
  <summary>查看手机布局</summary>
  <p align="center">
    <img src="./images/app-mobile.png?v=1482d98f" width="280" alt="Mica 手机布局：查看示例任务的进度与结果">
  </p>
  <p align="center"><sub>隔离示例项目与脚本化模型响应，图中用量为演示值。</sub></p>
</details>

运行时默认监听 `0.0.0.0:8787`；启用完整远程访问前应修改初始口令 `0000`。分享链接也是访问凭据，可调用运行时 API。仅在本机使用时，可按上面的 Web 命令绑定 `127.0.0.1`。连接步骤和访问范围见[远程与手机访问](https://qirong77.github.io/mica-code/docs/remote-access/)。

### 自动化与客户端集成

配置好模型后，在项目目录运行一次任务，或把结构化事件交给其他程序：

```bash
mica exec "检查当前变更，修复问题并运行相关测试"
mica exec --json "分析测试失败原因"
mica app-server
```

`exec` 默认输出文本，`--json` 输出 ThreadEvent JSONL；`app-server` 通过 stdin/stdout 提供 Codex v2 风格协议子集，用于客户端持续会话。它不是浏览器 HTTP 服务。工具使用宿主的文件与命令环境；参数、事件和集成示例见[自动化与协议](https://qirong77.github.io/mica-code/docs/headless/)。

## 扩展你的工作方式

- **Skills 与项目指令**：将可复用的流程写入 `.mica/skills/<name>/SKILL.md`，将项目约定放在 `AGENT.md` 或 `AGENTS.md`。
- **MCP 与角色**：连接外部服务与工具，为规划、实现或审查选择合适的工作方式。
- **插件与会话能力**：管理官方和用户插件，在会话设置中选择工具、Skills 和 MCP；部分插件设置可以按会话覆盖。
- **笔记与记忆**：会话笔记保留当前任务的决定，Memory 保存跨会话的偏好与经验。自动整理会产生额外模型请求，可在插件设置中调整。
- **运行复盘**：Harness Review 在本地记录工具失败、重复调用与重试，可导出带证据的报告并记录人工评估。

从[插件与能力管理](https://qirong77.github.io/mica-code/docs/plugins/)或 [Skills、MCP 与角色](https://qirong77.github.io/mica-code/docs/extensions/)开始。

## 从源码运行与参与开发

准备 Git、Bun 和 Node.js 22+。只运行源码终端时，不需要先安装本机 CLI：

```bash
git clone https://github.com/qirong77/mica-code.git
cd mica-code
bun install
bun run dev
```

开发时可以运行类型检查和相关测试：

```bash
bun run typecheck
bun run test -- packages/mica-agent/prompt/index.test.ts
```

根项目测试使用 Vitest。`bun run build` 会构建并安装本机 CLI，默认影响 `~/.local/lib/mica` 与 `~/.local/bin/mica`；保留发布版时可使用上面桌面示例中的独立安装目录。Windows 请使用 `bun run dev` 源码入口，发布安装器目前面向 macOS / Linux。

应用位于 `apps/`，共享能力在 `packages/`，官方插件在 `plugins/`。修改前阅读[维护者手册](./AGENT.md)，行为变化与文档一起更新。

| 入口 | 内容 |
| --- | --- |
| [设计文档](./docs/README.md) · [共享包索引](./packages/README.md) | 协议、运行时和包的公开入口 |
| [架构概览](https://qirong77.github.io/mica-code/docs/architecture/) · [交互架构图](https://qirong77.github.io/mica-code/architecture/) | 执行链路、应用边界与源码导航 |
| [开发记录](./blogs/README.md) · [演示素材复现](./docs/demo-assets.md) | 设计取舍、实现过程与截图方法 |
| [问题反馈](https://github.com/qirong77/mica-code/issues) | Bug 报告、使用问题与改进建议 |
