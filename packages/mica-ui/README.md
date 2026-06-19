# mica-ui

`mica-ui` 是 Mica Code 的 Ink 终端 UI 包，提供应用根组件、对话视图、输入框、底部面板、日志面板、基础组件和 UI 状态 store。

## 主要能力

- 应用与核心视图组件：`App`、`Conversation`、`TerminalInputUI`。
- 运行状态与日志组件：`WorkingStatus`、`LogView`、`AgentTurnLog`。
- 底部交互面板：`BottomSurface`、`DropDownUI`、`PluginPanel`。
- 基础组件：`Dialog`、`KeyHints`、`SelectList`、`Spin`。
- 状态入口：`conversation`、`terminalInput`、`dropdown`、`bottom`、`panels`。
- 文本和图片输入处理：`parseImageRefs`。

## 使用入口

```ts
import { micaUI } from '../packages/mica-ui/index.js';

micaUI.panels.pushLog({
  type: 'info',
  text: 'ready',
});
```

## 目录说明

- `app/`：Ink 应用根组件。
- `conversation/`：消息列表和 Markdown 渲染。
- `input/`：终端输入组件与输入状态。
- `bottom/`：底部面板、下拉菜单和 agent turn log。
- `panels/`：状态栏、消息栏和运行日志。
- `hooks/`：UI 刷新和布局相关 hooks。
- `primitives/`：通用基础 UI 组件。
- `utils/`：输入解析等 UI 工具函数。
- `types.ts`：UI 公开类型。
