# Mica Code / CLI Agent 记忆系统设计方案

设计一个“记忆系统”，核心不是“把所有东西存起来”，而是解决三个核心问题：

1. 记什么
2. 什么时候写入
3. 什么时候取出并注入上下文

下文为面向 Mica Code / CLI Agent 的完整记忆系统设计方案。

## 1. 先区分记忆类型

不要把所有记忆混在一起，至少分成四类独立存储、独立检索：

### 1.1 用户偏好 Memory

长期稳定、全局跨所有项目生效。
示例结构：

```json
{
  "type": "user_preference",
  "content": "用户偏好使用中文回复。",
  "scope": "global",
  "confidence": 0.9
}
```

适合记录内容：

- 回复语言偏好
- 代码风格偏好
- 常用技术栈
- 是否喜欢详细解释
- 是否默认运行测试

### 1.2 项目记忆 Project Memory

绑定指定 workspace / repo，仅当前仓库生效。
示例结构：

```json
{
  "type": "project_fact",
  "content": "本项目使用 Bun + TypeScript + Ink，测试应使用 bun run test。",
  "scope": "project:/Users/qironglin/Desktop/mica-code",
  "source": "AGENT.md"
}
```

适合记录内容：

- 项目架构约定
- 常用命令
- 测试方式
- import 导入风格
- 编码禁止事项
- 特殊目录说明
  > 数据来源：AGENT.md、README、package.json、Agent 执行过程沉淀

### 1.3 会话记忆 Session Memory

仅当前单次对话/任务内有效，生命周期跟随会话。
示例结构：

```json
{
  "type": "session_note",
  "content": "用户当前想设计 Mica Code 的 memory 系统，不要求立即实现。",
  "scope": "session:abc123"
}
```

适合记录内容：

- 当前任务目标
- 用户临时确认的约束
- 单次对话临时决策
- 未完成待办 TODO
  > 特性：会话销毁可清理，默认不持久存入长期记忆库

### 1.4 事实/经验 Memory

Agent 执行过程沉淀、可复用的踩坑经验。
示例结构：

```json
{
  "type": "lesson",
  "content": "在本仓库不要直接运行裸 bun test，因为 temp/ 目录可能导致无关失败。",
  "scope": "project:/Users/qironglin/Desktop/mica-code",
  "source": "execution_result"
}
```

适合记录内容：

- 命令执行失败根因
- 模块隐含约束
- 历史修复过的坑
- 用户纠正 Agent 的错误信息

## 2. 建议统一数据模型

统一 `MemoryRecord` 类型承载所有记忆条目：

```typescript
export type MemoryScope =
  | { type: 'global' }
  | { type: 'project'; workspace: string }
  | { type: 'session'; sessionId: string };

export type MemoryKind = 'user_preference' | 'project_fact' | 'session_note' | 'lesson' | 'todo' | 'decision';

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  content: string;
  tags?: string[];
  source?: {
    type: 'user' | 'assistant' | 'file' | 'command' | 'system';
    ref?: string;
  };
  confidence: number; // 0 - 1 可信度
  importance: number; // 0 - 1 重要度
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  ttl?: number; // 过期时间戳，单位ms
  archived?: boolean;
  embedding?: number[]; // 向量数组，语义检索用
}
```

### 核心关键字段说明

- `scope`：控制记忆生效范围，隔离全局/项目/会话数据
- `kind`：区分记忆类型，决定读写、过期、检索策略
- `confidence`：过滤错误、低可信度记忆，避免污染上下文
- `importance`：用于排序，判定是否长期保留、优先注入prompt
- `source`：完整溯源记忆来源，方便排查与清理
- `embedding`：可选字段，用于相似度语义检索

## 3. 存储分层演进方案

分三阶段迭代，前期降低开发成本，后期增强检索能力，不一步到位上重型数据库。

### 阶段一：JSON 文件存储（MVP 首选）

存储路径示例：

```
~/.mica/memory/global.json
~/.mica/memory/projects/{workspaceHash}.json
~/.mica/memory/sessions/{sessionId}.json
```

#### 优点

- 实现简单、无第三方重型依赖
- 文本可读，方便手动调试、导出迁移

#### 缺点

- 海量记忆下检索性能差
- 多进程并发写入需加锁处理冲突

### 阶段二：SQLite 本地数据库（正式版）

核心数据表结构：

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_key TEXT,
  content TEXT NOT NULL,
  tags TEXT,
  source TEXT,
  confidence REAL NOT NULL,
  importance REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT,
  archived INTEGER DEFAULT 0
);
```

向量检索扩展方案（按需接入）：

- sqlite-vec（SQLite 原生向量插件）
- LanceDB
- Chroma
- 独立本地 embedding 索引文件

### 阶段三：混合检索策略（成熟版本）

多维度联合检索，多层过滤重排：

1. 关键词精确匹配检索
2. Tag 标签过滤
3. Scope 作用域过滤（优先当前会话、项目）
4. Embedding 向量相似度打分
5. 时间新鲜度 / 重要度 综合重排
   最终仅筛选少量高相关记忆注入上下文。

## 4. 写入策略：禁止无差别自动记录

记忆系统失效核心诱因：无节制存储冗余信息。提供三类可控写入方式。

### 方式一：用户自然语言显式写入

用户话术示例：

> 记住，我以后希望你默认用中文回答。

生成记忆数据：

```typescript
{
  kind: "user_preference",
  scope: { type: "global" },
  content: "用户希望默认使用中文回答。",
  confidence: 1,
  importance: 0.9
}
```

优势：可信度最高，无隐私与冲突风险。

### 方式二：斜杠命令手动写入（/memory 系列）

内置 CLI 操作指令，用户完全可控：

```bash
/memory add 用户偏好使用 vitest 而不是 jest
/memory list
/memory delete [id]
/memory search test command
/memory clear project
/memory clear global
```

### 方式三：自动生成候选，人工确认再持久化

Agent 自动识别潜在记忆，但不直接写入长期库，先推送确认弹窗。
候选数据结构：

```typescript
interface MemoryCandidate {
  content: string;
  kind: MemoryKind;
  reason: string;
  confidence: number;
}
```

交互示例：

> 我发现一个可能值得记住的项目约定：
> “本仓库不要直接运行裸 bun test，应使用 bun run test。”
> 是否保存到项目记忆？

配套配置开关，管控自动识别范围：

```json
{
  "memory": {
    "autoSave": false,
    "autoSaveKinds": ["lesson", "project_fact"]
  }
}
```

## 5. 读取策略：上下文注入克制化

每次对话不加载全部记忆，按流程精准筛选少量相关内容。

### 完整检索流程

```
用户输入消息
    ↓
构造 MemoryQuery 查询对象
    ↓
按当前 scope 筛选候选记忆池
    ↓
关键词 + 语义多维度检索打分
    ↓
按相关性、重要度、新鲜度排序
    ↓
截取 Top K 条高价值记忆
    ↓
分区注入 system/context prompt
```

### 查询对象定义

```typescript
interface MemoryQuery {
  text: string;
  workspace?: string;
  sessionId?: string;
  taskType?: 'coding' | 'debugging' | 'planning' | 'review';
  limit: number;
}
```

### 检索优先级（从高到低）

1. 当前会话 Session Memory
2. 当前项目 Project Memory
3. 全局用户偏好 User Preference
4. 历史经验 Lesson Memory

### Prompt 注入分区示例

```
Relevant Memories
## User Preferences
- 用户偏好中文回复。

## Project Memories
- 本项目使用 Bun，测试应运行 bun run test。
- temp/ 目录不是项目源码，递归扫描时应排除。

## Session Notes
- 当前任务是设计 memory 系统，暂不修改代码。
```

## 6. 记忆生命周期管理

记忆数据不能无限堆积，提供合并、更新、过期、删除完整生命周期逻辑。

### 6.1 合并

多条语义高度相似记忆自动合并，消除冗余：

- 旧记忆1：用户喜欢中文回复。
- 旧记忆2：用户希望默认用中文。
- 合并结果：用户偏好默认使用中文回复。

### 6.2 更新

出现冲突新指令时，更新原有记忆，而非新增冲突条目。
例：用户指令「以后不用中文，直接英文」→ 更新全局偏好记忆内容。

### 6.3 过期衰减 TTL

临时类记忆设置过期时间自动失效：

- 单次任务临时路径
- 临时调试状态
- 一次性命令执行结果
  TTL 示例（7天过期）：

```
ttl: 7 * 24 * 60 * 60 * 1000
```

### 6.4 用户可控删除

通过 `/memory` 命令手动清理，支持单条/批量清空：

```bash
/memory delete [记忆ID]
/memory clear global
/memory clear project
```

## 7. 冲突处理规则

多条记忆存在矛盾时，按优先级覆盖（上层临时指令 > 底层长期记忆）
优先级从高到低：

1. 用户本次实时输入指令
2. 当前会话临时约束
3. 项目记忆
4. 全局用户偏好
5. 历史经验 Lesson

核心规则：长期静态记忆不能覆盖用户当下明确临时要求。

## 8. 安全与隐私约束

记忆系统默认保守，禁止自动存储敏感数据。

### 禁止自动记录内容

- API Key、密钥、Token
- 密码、私钥、Cookie
- 个人身份隐私信息
- 企业内部涉密内容
- 用户未授权长期存储的隐私数据

### 敏感内容检测函数

```typescript
function isSensitiveMemory(content: string): boolean {
  return /api[_-]?key|secret|password|token|private key/i.test(content);
}
```

检测到敏感内容时，直接拒绝写入，或弹窗二次确认用户意图。

## 9. Mica Code 仓库落地架构

新增独立包隔离记忆能力，分层解耦，无循环依赖。

### 目录结构

```
packages/mica-memory/
├── index.ts             # 对外导出入口
├── MemoryStore.ts       # 底层存储抽象
├── MemoryManager.ts     # 记忆增删改合并生命周期管理
├── MemoryRetriever.ts   # 检索、打分、重排逻辑
├── MemoryTypes.ts       # 全部类型定义
└── JsonMemoryStore.ts   # JSON 文件存储实现
```

### 各模块职责边界

1. **mica-memory（独立包）**
   仅负责：类型定义、存储读写、检索、记忆合并/过期/删除
   禁止依赖 UI、Agent 运行时、会话控制器
2. `src/` 主工程
   对接 `mica-memory`，接入 Application / AgentRuntime
3. `mica-builtin-commands`
   实现 `/memory` 全套 CLI 操作命令
4. `mica-agent`
   构建 Prompt 阶段调用检索接口，注入记忆上下文
5. `mica-config`
   持久化记忆系统配置（autoSave、检索limit等）

## 10. MVP 最小可行版本规划

第一版不做复杂向量检索、自动持久化，优先实现可用基础能力。

### 10.1 MVP 功能清单

1. 支持 global / project / session 三类 scope 隔离
2. JSON 文件本地持久化存储
3. 完整手动 `/memory add/list/delete/search` 命令
4. 基于关键词简易检索打分
5. 每次对话注入 Top5 高相关记忆至 Prompt
6. 敏感信息自动过滤拦截
7. 无自动长期持久化，仅生成记忆候选，全流程用户可控

### 10.2 MVP 核心服务接口

```typescript
export interface MemoryService {
  add(input: AddMemoryInput): Promise<MemoryRecord>;
  list(query: ListMemoryQuery): Promise<MemoryRecord[]>;
  search(query: SearchMemoryQuery): Promise<MemoryRecord[]>;
  update(id: string, patch: Partial<MemoryRecord>): Promise<MemoryRecord>;
  delete(id: string): Promise<void>;
  retrieve(query: RetrieveMemoryQuery): Promise<MemoryRecord[]>;
}
```

### 10.3 MVP 简易检索打分算法（无向量）

```
score =
  keywordMatchScore * 0.5 +
  importance * 0.3 +
  recencyScore * 0.2
```

后续迭代再接入 embedding 向量相似度加权。

## 11. 完整业务流程示例

### 1. 用户输入指令

> 以后在这个项目里不要直接运行 bun test，要用 bun run test。

### 2. 系统写入项目记忆

```typescript
await memory.add({
  kind: 'project_fact',
  scope: {
    type: 'project',
    workspace: '/Users/qironglin/Desktop/mica-code',
  },
  content: '在本项目中不要直接运行裸 bun test，应使用 bun run test。',
  source: {
    type: 'user',
  },
  confidence: 1,
  importance: 0.9,
  tags: ['test', 'bun', 'project-convention'],
});
```

### 3. 后续用户交互触发检索

用户输入：`帮我跑一下测试。`
系统检索匹配到上述项目记忆，自动执行正确命令：

```bash
bun run test
# 而非 bun test
```

## 12. 核心设计原则（落地基准）

1. **用户可控**：记忆可查看、手动修改、一键清空，无黑盒自动存储
2. **默认保守**：不偷偷持久敏感隐私数据，自动记忆需人工确认
3. **范围清晰**：全局/项目/会话三层隔离，互不干扰
4. **少量高质**：宁可少存，杜绝大量低相关信息污染上下文
5. **检索相关**：仅注入当前任务强相关记忆，限制单次注入条数
6. **可追溯**：每条记忆携带来源字段，支持溯源清理
7. **可演进**：技术栈分阶段迭代，先 JSON+关键词，后 SQLite+向量检索

### 落地实施建议

仓库落地第一步：开发 `packages/mica-memory` 基础包，实现手动 `/memory` 命令 + JSON 文件全局/项目存储，完成后接入主流程提 PR。
