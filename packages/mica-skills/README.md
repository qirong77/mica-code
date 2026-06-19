# mica-skills

`mica-skills` 负责加载用户自定义 skills。Skill 以目录形式存放，每个 skill 目录下需要包含 `SKILL.md`。

默认扫描目录：`~/.mica/skills`。

## 主要能力

- 获取当前已加载 skills：`micaSkills.getLoaded()`。
- 重新扫描并加载 skills：`micaSkills.reload()`。

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

## 目录说明

- `loadSkills.ts`：扫描目录、解析 frontmatter、缓存和刷新 skills。
- `types.ts`：Skill 类型定义。
