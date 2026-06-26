# mica-logger

`mica-logger` 是 Mica Code 的运行时日志包。它负责保存运行日志状态，并提供适合 UI 面板展示的格式化辅助能力。

## 主要能力

- 维护运行时日志 store。
- 记录 info、warning、error 等日志项。
- 提供日志格式化工具，供状态面板或日志面板展示。
- 支持导出或查看当前运行过程中的关键事件。

## 使用入口

```ts
import { micaLogger } from '@packages/mica-logger/index.js';

micaLogger.runtimeLogger.info('ready');
```

## 设计约束

- 本包只负责日志数据与格式化，不直接渲染 UI。
- UI 展示由 `packages/mica-ui` 或应用层适配完成。
- 日志内容应避免写入敏感信息。

## 目录说明

- `runtimeLogger.ts`：运行时日志 store 与记录方法。
- `index.ts`：公共 API 聚合导出。
