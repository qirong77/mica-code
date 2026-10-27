# mica-common

`mica-common` 是 Mica Code 各 package 共享的底层工具包。它提供无业务依赖的通用类型和工具函数，用于降低 package 之间的重复实现。

## 主要能力

- `Disposable` 相关工具，用于统一资源释放。
- 类型安全的事件总线工具。
- JSON 值类型定义。
- `Result` 成功/失败结果类型。
- `ID` 生成、token 格式化、Git 命令执行与错误格式化工具。
- 共享的图片格式、尺寸识别与原图载荷工具。

## 使用入口

```ts
import { micaCommon } from '@packages/mica-common/index.js';

const id = micaCommon.createId('item');
const tokenText = micaCommon.formatTokenCount(15320);
const errText = micaCommon.formatExecError(new Error('cmd error'));
```

图片处理能力通过同一公共入口按需导入：

```ts
import { prepareImageForApi } from '@packages/mica-common/index.js';
```

## 设计约束

- 不依赖任何产品业务包。
- 不包含 UI、agent、配置、会话等领域逻辑。
- 新增工具应保持小而稳定，适合作为跨包基础能力复用。

## 目录说明

- `disposable.ts`：资源释放接口和辅助方法。
- `eventBus.ts`：事件总线相关类型与实现。
- `json.ts`：JSON 类型定义。
- `result.ts`：结果类型。
- `ids.ts`：ID 生成。
- `format.ts`：token 数量格式化。
- `git.ts`：git 命令执行与错误格式化。
- `autolink.ts`：自动链接在全角标点处断开的唯一判定，CLI 与桌面端渲染共用。
- `promptText.ts`：消息文本归一化（剥掉媒体占位符再折叠空白）与 `comparableText` 系列，编辑重发、回退点按文本定位用户消息时共用。
- `chatQuote.ts`：「引用对话」文本约定的唯一实现（格式化、解析、插入草稿、移除、标题派生时剥离前导引用块），CLI 与桌面端按子路径 `@packages/mica-common/chatQuote.js` 引入。
- `capabilities.ts`：会话级能力选择（只保存被关掉的 skills / tools / MCP server），归一化与比较规则两端共用。
- `toolNames.ts`：工具名规范（snake_case 全小写）与历史大驼峰名的 `normalizeToolName` 映射。
- `loopArgs.ts`：`/loop` 参数解析与间隔上下限，CLI 与桌面端斜杠命令共用同一套写法。
- `todoState.ts`：待办解析归一化与展示投影的唯一实现，TUI 面板与 desktop 计划 dock 共用；宿主只渲染，不改写模型给的状态。
- `btwState.ts`：By The Way 线程的落盘路径与读写（`$MICA_HOME/btw/<sessionId>.json`），常驻 host 写入与会话删除时的清理共用。
- `image.ts`：图片格式和尺寸识别，保留原始图片字节供 provider 发送。
- `sessionNotes.ts`：会话笔记的归一化、追加、长度上限与 prompt 片段，唯一实现在这里，工具与桌面面板都调它。
- `index.ts`：公共 API 聚合导出。
