# 从 0 到 1 开发一个 Code Agent

这里记录 mica-code 的开发过程。不是教程，不是文档——是真实遇到的问题和解法。

mica-code 是一个轻量 CLI code agent，基于 Bun + TypeScript + React（Ink）+ Anthropic SDK。整个项目从零搭建，过程中有些问题值得记下来。

## 文章规范

所有 Blog 文章遵循以下统一规范：

**文件命名**

`{序号}.{英文名}.md`，所有文件放在 `blogs/` 根目录，不设子目录。

**标题格式**

`# 【{序号}】Code Agent 从零到一：{子标题}`

**项目介绍 blockquote**

每篇文章的 h1 标题后必须紧跟以下 blockquote（内容完全一致）：

```markdown
> 本文是 [mica-code](https://github.com/qirong77/mica-code) 系列文章之一。mica-code 是一个从零搭建的 CLI code agent，基于 Bun + TypeScript + React（Ink）+ Anthropic SDK，目标是搞清楚 Claude Code 这类工具底层到底怎么工作。
```

之后空一行再接正文。禁止在项目介绍 blockquote 前后添加其他内容。

**新增文章 checklist**

1. 按顺序分配序号
2. 文件名用英文：`{序号}.{topic-slug}.md`
3. 标题：`# 【{序号}】Code Agent 从零到一：{子标题}`
4. 紧跟统一项目介绍 blockquote
5. 在本文档「文章列表」下添加链接

---

## 写作优化经验

以下是经过多轮迭代提炼的 Blog 写作原则，适用于本系列所有技术文章。

### 1. "先痛后治"结构

不要直接讲"这个工具做了什么"，先让读者感受到"没有这个工具的时候你会怎么挣扎"。

- **反例**：直接介绍 ink 的双缓冲机制
- **正例**：先展示"清屏重写会闪"和"手动增量更新很快失控"，再引入 ink 的双缓冲方案

Blog 04 和 05 天然符合这个结构——"没有防御的代码 → 问题分析 → 参考方案 → 改造效果"就是先痛后治。Blog 01 原本缺少这个环节，在迭代中补充了"第零章（续）"来做过渡。

### 2. 过渡章节连接概念层级

当两个概念之间有跃迁（比如从"终端基础概念"跳到"ink 渲染实现"），插入一个桥梁章节：

- 先解释"如果不引入这个库，你会怎么做"（展示原生 API、暴露问题）
- 再过渡到"这个库帮你做了什么"（问题到方案的映射表）
- 最后进入实现细节

Blog 01 的"第零章（续）"和 Blog 03 新增的"过渡：没有事件系统的时候，交互长什么样？"都是这个模式。

### 3. 归属说明——这是谁的？

本系列交替介绍开源 ink 和 fork（`@anthropic/ink`）。读者在章节之间容易忘记上下文，必须明确标注：

- 每篇开头或关键章节明确：**"这是开源已有的机制"**还是**"这是 fork 新增的特性"**
- 不要依赖读者记住上一页的导语——在章节内部也需要反复提示

Blog 01 在 1.4 开头加了归属说明。Blog 02 和 03 在导语末尾补了归属 blockquote。

### 4. 具体场景驱动，而非抽象描述

用真实场景（消息折行、浮层遮盖、窗口 resize）代替抽象词汇（"代码复杂度增加"）。读者通过场景自行感受到痛苦，不需要被说服。

- **反例**："随着功能增多，代码变得难以维护"
- **正例**：展示三个具体场景：消息折行→下面内容全要下移；浮层遮盖→需要记住被盖住的内容；窗口 resize→所有坐标作废

### 5. 代码对比比抽象描述更有力

"不用 ink 需要写 100+ 行维护屏幕快照，用 ink 只需要 4 行 JSX"——这种 before/after 对比比任何文字描述都有说服力。Blog 01 的过渡章节、Blog 04 的效果对比都用了这个手法。

### 6. 复杂协作关系用数据流图

当多个子系统协作时（如三池 + Packed Buffer），用 ASCII 数据流图展示数据如何从一个池子流到另一个池子，最终打包成 Int32。比纯文字描述直观得多。Blog 02 的 2.4 结尾用了这个手法。

---

## 文章列表

- [【01】Code Agent 从零到一：ink 渲染管线全景](./1.ink-render-pipeline.md)
- [【02】Code Agent 从零到一：Packed Buffer、缓存与闪烁消除](./2.ink-yoga-layout.md)
- [【03】Code Agent 从零到一：事件、选择与虚拟滚动](./3.ink-output-control.md)
- [【04】Code Agent 从零到一：对话压缩策略的演进](./4.compact-strategy.md)
- [【05】Code Agent 从零到一：工具设计的防御性编程](./5.tool-optimization.md)
- [【06】Code Agent 从零到一：claude-code 文件级记忆系统设计](./6.memory-system-design.md)
- [【07】Code Agent 从零到一：后台命令执行与自动终止](./7.background-task.md)
- [【08】Code Agent 从零到一：记忆系统的设计与实现](./8.memory-system-implementation.md)

---

## 关于这个项目

动手原因很简单：想真正搞清楚 Claude Code 这类工具在底层是怎么工作的。光读代码不够，得自己写一遍。

技术栈选择也尽量克制——Bun 原生运行 TypeScript 省掉构建配置，Ink 处理终端 UI，Anthropic SDK 负责模型调用。插件系统从一开始就是核心，因为 agent 的能力扩展不应该改主干代码。

项目地址：`/src` 目录，入口是 `src/index.ts`。
