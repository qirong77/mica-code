# mica-session

`mica-session` 是 Mica Code 的会话持久化包，负责保存、读取和列出 agent runtime 快照。

会话文件默认保存到：`~/.mica/sessions`。

## 主要能力

- 创建会话 store：`micaSession.createStore()`。
- 创建会话 ID：`micaSession.createId()`。
- 读取最近会话列表：`store.list(limit)`。
- 加载指定会话：`store.load(id)`。
- 保存会话快照：`store.save(session)`。

## 使用入口

```ts
import { micaSession } from '../packages/mica-session/index.js';

const store = micaSession.createStore();
const sessions = store.list(10);
```

## 目录说明

- `sessionStore.ts`：会话类型、文件存储实现、ID 创建和路径安全处理。
