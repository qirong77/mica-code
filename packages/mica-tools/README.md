# mica-tools

`mica-tools` 是 Mica Code 的工具系统包，提供内置工具、工具抽象、工具 registry，以及 MCP 工具注册入口。

## 主要能力

- 提供统一工具基类：`MicaTool`。
- 注册和移除 MCP 工具：`micaTools.registerMcp()`、`micaTools.unregisterMcp()`。
- 获取可提供给模型的工具定义：`micaTools.getDefinitions()`。
- 执行指定工具：`micaTools.execute(name, input, callbacks)`。
- 获取工具调用展示文案：`micaTools.getDisplayText(name, input)`。
- 运行期工具注册支持 `primaryAgentOnly` 元数据，subagent 工具过滤通过 registry 查询，不硬编码产品工具名。

## 内置工具

- `read_file`：读取文件内容。
- `read_image`：读取本地图片或网络图片 URL，并嵌入模型对话。
- `write_file`：写入或覆盖文件。
- `apply_patch`：应用文件补丁。
- `list_files`：按 glob 模式列出文件。
- `grep_search`：在文件中搜索正则。
- `run_shell`：执行 shell 命令，可启动后台任务。
- `background_tasks`：列出后台任务。
- `read_task_output`：读取后台任务输出。
- `kill_task`：终止后台任务。
- `pty_spawn`：在 PTY 中启动交互式终端程序。
- `pty_send`：向 PTY 会话发送文本或命名按键。
- `pty_read`：读取 PTY 会话输出。
- `pty_wait`：等待 PTY 输出匹配、进程退出或静默。
- `pty_kill`：终止 PTY 会话。
- `web_fetch`：抓取 URL 内容。
- `web_search`：搜索网络信息。
- `Skill`：读取并调用本地 skill 指令。

PTY 工具用于驱动交互式 TUI 程序做端到端验证。node-pty 的 native binding 在 Bun 进程内不工作，因此 PTY 会话由懒启动的 Node 子进程承载（`packages/mica-pty/src/server.mjs`），通过 JSONL over stdio 通信；工具实现位于 `packages/mica-tools/pty/`，首次调用时动态加载 `packages/mica-pty/src/manager.js`（不经过 `mica-pty/index.js`，避免 Bun 进程加载 node-pty）。node-pty 缺失或 Node 不可用时工具降级报错，不影响其他功能。

## 使用入口

```ts
import { micaTools } from '../packages/mica-tools/index.js';

const definitions = micaTools.getDefinitions();
const result = await micaTools.execute('read_file', { file_path: 'README.md' });
```

## 设计约束

- 所有工具统一通过 registry 暴露给模型和运行时。
- 官方产品插件通过 `PluginContext.tools.register()` 接入；应用 host 将注册转发到本包 registry。
- 工具结果可以是字符串或文本/图片内容块；UI 和日志消费文本投影，provider adapter 负责嵌入图片。
- 新增工具优先继承 `MicaTool` 并提供参数校验、展示文案和错误格式化。
- 文件、shell、网络类工具需要保留边界检查和输出限制。
- MCP 工具只能通过注册接口接入，便于 server 断开后清理。

## 目录说明

- `MicaTool.ts`：工具基类和执行回调类型。
- `registry.ts`：内置工具、MCP 工具注册和执行分发。
- `ToolApplyPatch.ts`：应用补丁工具。
- `ToolBackgroundTasks.ts`：列出与管理后台任务。
- `ToolGrepSearch.ts`：文件搜索工具。
- `ToolKillTask.ts`：终止后台任务。
- `ToolListFiles.ts`：按 glob 列文件。
- `ToolReadFile.ts`：读取文件。
- `ToolReadImage.ts`：读取并返回本地或网络图片。
- `ToolReadTaskOutput.ts`：读取后台任务输出。
- `ToolRunShell.ts`：执行 shell 命令。
- `ToolRunShellBackground.ts`：后台 shell 输出与任务控制支持。
- `ToolRunShellOutput.ts`：run_shell 统一输出处理。
- `ToolSkill.ts`：基于 skills 的工具调用。
- `pty/`：PTY 工具（spawn/send/read/wait/kill）与懒加载 manager 桥接。
- `ToolWebFetch.ts`：抓取网址内容。
- `ToolWebSearch.ts`：执行网络搜索。
- `ToolWriteFile.ts`：写入与更新文件。
- `types.ts`：模型侧工具定义类型。
- `utils/`：展示文案、文件历史、错误格式化和输出限制工具。
- `index.ts`：公共 API 聚合导出。
