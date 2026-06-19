# mica-tools

`mica-tools` 是 Mica Code 的工具系统包，提供内置工具、工具抽象、工具 registry，以及 MCP 工具注册入口。

## 主要能力

- 提供统一工具基类：`MicaTool`。
- 注册和移除 MCP 工具：`micaTools.registerMcp()`、`micaTools.unregisterMcp()`。
- 获取可提供给模型的工具定义：`micaTools.getDefinitions()`。
- 执行指定工具：`micaTools.execute(name, input, callbacks)`。
- 获取工具调用展示文案：`micaTools.getDisplayText(name, input)`。

## 内置工具

- `read_file`
- `write_file`
- `edit_file`
- `list_files`
- `grep_search`
- `run_shell`
- `web_fetch`
- `web_search`
- `Skill`

## 使用入口

```ts
import { micaTools } from '../packages/mica-tools/index.js';

const definitions = micaTools.getDefinitions();
const result = await micaTools.execute('read_file', { file_path: 'README.md' });
```

## 目录说明

- `MicaTool.ts`：工具基类和执行回调类型。
- `registry.ts`：内置工具、MCP 工具注册和执行分发。
- `Tool*.ts`：各内置工具实现。
- `types.ts`：模型侧工具定义类型。
