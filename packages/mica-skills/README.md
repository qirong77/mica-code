# mica-skills

`mica-skills` 负责加载用户自定义 skills。Skill 以目录形式存放，每个 skill 目录下需要包含 `SKILL.md`。

默认扫描目录：`~/.mica/skills`，可通过 `MICA_HOME` 覆盖。

## 主要能力

- 获取当前已加载 skills：`micaSkills.getLoaded()`。
- 重新扫描并加载 skills：`micaSkills.reload()`。
- 解析 `SKILL.md` frontmatter。
- 为工具系统的 `Skill` 工具提供可用 skill 列表。

## Skill 文件格式

`SKILL.md` 支持简单 frontmatter：

```md
---
name: example
description: Example skill
when_to_use: When an example is needed
argument-hint: [name]
---

Skill instructions...
```

## 使用入口

```ts
import { micaSkills } from '../packages/mica-skills/index.js';

const skills = micaSkills.getLoaded();
```

## 设计约束

- 本包只负责扫描、解析和缓存 skills，不执行 skill 内容。
- skill 内容属于用户数据，调用方需要按工具安全策略处理。
- reload 应尽量保持失败隔离，单个无效 skill 不应影响其他 skill 加载。

## 目录说明

- `loadSkills.ts`：扫描目录、解析 frontmatter、缓存和刷新 skills。
- `types.ts`：Skill 类型定义。
- `loadSkills.test.ts`：skills 加载行为测试。
- `index.ts`：公共 API 聚合导出。
