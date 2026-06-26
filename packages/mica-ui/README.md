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
import { micaUi } from '../packages/mica-ui/index.js';

micaUi.panels.pushLog({
  type: 'info',
  text: 'ready',
});
```

## 设计约束

- 本包只负责终端 UI 组件和 UI 状态，不直接调用 provider。
- Runtime 到 UI 的映射由应用层或 adapter 完成。
- 组件应尽量通过公开 store 和 props 获取状态，避免隐式耦合应用单例。
- 新增交互面板优先复用 `bottom/` 和 `primitives/` 中的基础组件。

## 目录说明

- `app/`：Ink 应用根组件。
- `conversation/`：消息列表和 Markdown 渲染。
- `input/`：终端输入组件与输入状态。
- `bottom/`：底部面板、下拉菜单和 agent turn log。
- `panels/`：状态栏、消息栏和运行日志。
- `hooks/`：UI 刷新和布局相关 hooks。
- `primitives/`：通用基础 UI 组件。
- `utils/`：输入解析和格式化工具函数。
- `types.ts`：UI 公开类型。
- `theme.ts`：终端 UI 主题定义。
- `index.ts`：公共 API 聚合导出。
