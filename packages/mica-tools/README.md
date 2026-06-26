# mica-tools

`mica-tools` 是 Mica Code 的工具系统包，提供内置工具、工具抽象、工具 registry，以及 MCP 工具注册入口。

## 主要能力

- 提供统一工具基类：`MicaTool`。
- 注册和移除 MCP 工具：`micaTools.registerMcp()`、`micaTools.unregisterMcp()`。
- 获取可提供给模型的工具定义：`micaTools.getDefinitions()`。
- 执行指定工具：`micaTools.execute(name, input, callbacks)`。
- 获取工具调用展示文案：`micaTools.getDisplayText(name, input)`。

## 内置工具

- `read_file`：读取文件内容。
- `write_file`：写入或覆盖文件。
- `edit_file`：通过精确字符串替换编辑文件。
- `list_files`：按 glob 模式列出文件。
- `grep_search`：在文件中搜索正则。
- `run_shell`：执行 shell 命令。
- `web_fetch`：抓取 URL 内容。
- `web_search`：搜索网络信息。
- `Skill`：读取并调用本地 skill 指令。

## 使用入口

```ts
import { micaTools } from '../packages/mica-tools/index.js';

const definitions = micaTools.getDefinitions();
const result = await micaTools.execute('read_file', { file_path: 'README.md' });
```

## 设计约束

- 所有工具统一通过 registry 暴露给模型和运行时。
- 新增工具优先继承 `MicaTool` 并提供参数校验、展示文案和错误格式化。
- 文件、shell、网络类工具需要保留边界检查和输出限制。
- MCP 工具只能通过注册接口接入，便于 server 断开后清理。

## 目录说明

- `MicaTool.ts`：工具基类和执行回调类型。
- `registry.ts`：内置工具、MCP 工具注册和执行分发。
- `Tool*.ts`：各内置工具实现。
- `types.ts`：模型侧工具定义类型。
- `utils/`：展示文案、文件历史、错误格式化和输出限制工具。
- `index.ts`：公共 API 聚合导出。
