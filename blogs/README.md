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

## 文章列表

- [【01】Code Agent 从零到一：ink 渲染管线全景](./1.ink-render-pipeline.md)
- [【02】Code Agent 从零到一：Packed Buffer、缓存与闪烁消除](./2.ink-yoga-layout.md)
- [【03】Code Agent 从零到一：事件、选择与虚拟滚动](./3.ink-output-control.md)
- [【04】Code Agent 从零到一：对话压缩策略的演进](./4.compact-strategy.md)
- [【05】Code Agent 从零到一：工具设计的防御性编程](./5.tool-optimization.md)

---

## 关于这个项目

动手原因很简单：想真正搞清楚 Claude Code 这类工具在底层是怎么工作的。光读代码不够，得自己写一遍。

技术栈选择也尽量克制——Bun 原生运行 TypeScript 省掉构建配置，Ink 处理终端 UI，Anthropic SDK 负责模型调用。插件系统从一开始就是核心，因为 agent 的能力扩展不应该改主干代码。

项目地址：`/src` 目录，入口是 `src/index.ts`。
