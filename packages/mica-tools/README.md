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
- `run_shell`：前台执行 shell 命令并等它结束，严格超时（默认 30s、最长 120s）。
- `background_tasks_start`：后台启动 shell 命令，立刻返回 `task_id`，不等待结果。
- `background_tasks_list`：列出后台任务（id / 状态 / pid / 时长 / 输出大小）。
- `background_tasks_read`：读取后台任务输出与状态。
- `background_tasks_kill`：终止仍在运行的后台任务。
- `wait_for`：等外部条件成立（后台任务结束、进程退出、文件出现或变化、命令/HTTP/端口就绪、固定时长），超时返回可续等的 `wait_id`；可选 `reason` 说明为什么等（展示在客户端「等待中」列表）。它只观察、不启动任何东西，且可与同一条消息里其余调用并发执行。`kind=task` 只认 `background_tasks_start` 的 shell 任务，subagent 任务要用 `Agent` 的 `operation=await`；参数类错误（未知 task_id、非法正则、路径越权）立即返回 `failed`，不续等。
- `pty_spawn`：在 PTY 中启动交互式终端程序。
- `pty_send`：向 PTY 会话发送文本或命名按键。
- `pty_read`：读取 PTY 会话输出。
- `pty_wait`：等待 PTY 输出匹配、进程退出或静默。
- `pty_kill`：终止 PTY 会话。
- `web_fetch`：抓取 URL 内容。
- `web_search`：通过自托管 SearXNG 实例（`searxngUrl` / `SEARXNG_URL`）搜索网络信息。
- `skill`：读取并调用本地 skill 指令。

PTY 工具用于驱动交互式 TUI 程序做端到端验证。

「启动 / 等待 / 查看」是三个独立动作：`run_shell` 只跑前台命令；需要后台时用
`background_tasks_start` 启动，要结果时用 `wait_for(kind="task")` 等、用
`background_tasks_read` 读。启动方式与采集方式分开，模型不必在一个参数里切换语义。node-pty 的 native binding 在 Bun 进程内不工作，因此 PTY 会话由懒启动的 Node 子进程承载（`packages/mica-pty/src/server.mjs`），通过 JSONL over stdio 通信；工具实现位于 `packages/mica-tools/pty/`，首次调用时动态加载 `packages/mica-pty/src/manager.js`（不经过 `mica-pty/index.js`，避免 Bun 进程加载 node-pty）。node-pty 缺失或 Node 不可用时工具降级报错，不影响其他功能。

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
- `ToolBackgroundRead.ts`：读取后台任务输出（`background_tasks_read`）。
- `ToolBackgroundStart.ts`：后台启动 shell 命令（`background_tasks_start`）。
- `ToolBackgroundTasks.ts`：列出后台任务（`background_tasks_list`）。
- `ToolGrepSearch.ts`：文件搜索工具。
- `ToolKillTask.ts`：终止后台任务。
- `ToolListFiles.ts`：按 glob 列文件。
- `ToolReadFile.ts`：读取文件。
- `ToolReadImage.ts`：读取并返回本地或网络图片。
- `ToolRunShell.ts`：执行 shell 命令。
- `ToolRunShellBackground.ts`：后台 shell 输出与任务控制支持。
- `ToolRunShellOutput.ts`：run_shell 统一输出处理。
- `ToolSkill.ts`：基于 skills 的工具调用。
- `ToolWaitFor.ts`：等待外部条件成立（task/process/file/command/http/port/duration）。
- `pty/`：PTY 工具（spawn/send/read/wait/kill）与懒加载 manager 桥接。
- `ToolWebFetch.ts`：抓取网址内容。
- `ToolWebSearch.ts`：通过 SearXNG 实例执行网络搜索。
- `ToolWriteFile.ts`：写入与更新文件。
- `types.ts`：模型侧工具定义类型。
- `runtimeToolDescriptors.ts`：只在会话期注册的工具的目录兜底描述。
- `toolNames.ts`：工具名规范与历史名字映射。
- `utils/`：展示文案、文件历史、错误格式化和输出限制工具。
- `index.ts`：公共 API 聚合导出。
