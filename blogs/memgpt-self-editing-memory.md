# MemGPT 的自我编辑记忆：把上下文管理权交还给模型

> 本文是 [mica-code](https://github.com/qirong77/mica-code) 系列文章之一。mica-code 是一个从零搭建的 CLI code agent，基于 Bun + TypeScript + React（Ink）+ Anthropic SDK，目标是搞清楚 Claude Code 这类工具底层到底怎么工作。

长会话里最尴尬的时刻，不是模型答错，而是**上下文快满了，却没人管**。

上下文占用到了 85%，每一轮请求都在变贵、变慢，模型的短期记忆开始退化——它忘了三小时前定的约束，重复读已经读过的文件，甚至开始复述自己说过的话。而此刻能做决定的只有一个人：用户。用户得自己发现状态栏红了，手动敲 `/compact`，或者干脆 `/clear` 重来。

这不对劲。Agent 明明最清楚自己的上下文里有什么、缺什么、该扔什么，却把"什么时候压缩、压掉什么"这个决定留给了最不该做决定的人。

这篇记录我们从 MemGPT 论文（arXiv 2310.08560）里拿到的答案，以及它在 mica-code 里的两次落地：`session_*` 会话自治工具族，和 context-pressure 自动提醒插件。

---

## 一、MemGPT 在讲什么：把 LLM 当操作系统

先明确归属：这一节是**外部论文**的思想（MemGPT，UC Berkeley 等，2023），不是 mica 的实现。后面几节才是我们把论文翻译成自己代码的过程。

MemGPT 的出发点很朴素：**LLM 的 context window 是有限内存，而内存管理不该由应用层硬编码，应该由 LLM 自己像操作系统一样管理。**

论文做了个映射：

```txt
传统操作系统               MemGPT 里的 LLM
─────────────            ─────────────────────
RAM（物理内存）      ←→   main context（prompt，始终可见）
磁盘（持久存储）    ←→   external context（archival/recall，必须显式读入）
分页 / 换入换出     ←→   函数调用（自己决定读什么、扔什么、写什么）
```

这个映射最大的意义不是技术，而是**职责转移**：以前"上下文怎么管理"是开发者写死的策略；MemGPT 把它变成了一组暴露给模型的函数，让模型在运行中自己决策。

论文里有四个机制，缺一不可：

### 1.1 自我编辑记忆（self-editing memory）

模型通过函数调用读写自己的上下文：把重要结论写入常驻 memory block，把不再需要的内容从上下文里移除。不需要用户干预，不需要开发者干预。

### 1.2 内存感知（memory awareness）

光有工具不够，模型得知道"现在内存紧张"。MemGPT 在系统提示词里带上 token 限额警告，让模型在做记忆管理决策时有依据。论文原话是：**"对上下文限制的感知，是让自我编辑机制有效工作的关键"**。

### 1.3 中断驱动（interrupt-driven）

系统可以在需要时主动唤醒模型处理事件——比如"上下文快满了，请处理"。不一定要等用户输入。这解决了"模型忙着回复用户，没空想内存"的问题。

### 1.4 请求心跳（request_heartbeat）

模型可以在输出里要求"马上再推理一轮"，把多次记忆操作链起来：先查记忆、再决定删什么、再确认结果。一次工具调用完就停的话，多步决策没法连贯。

## 二、落地前的现状：压缩的开关在用户手里

回到 mica-code。在引入 MemGPT 思路之前，我们已经有了一套不错的压缩基础设施，但它的触发权完全在用户：

```txt
用户发现上下文快满了
      │ 手动
      ▼
/compact ──→ CompactionService
      │
      ▼
保留最近轮次 + 裁剪 tool result + 可选 LLM 总结
```

`packages/mica-context/CompactionService.ts` 解决的是"**怎么压**"：压多少、保留哪几轮、tool-call 的 `arguments` 怎么改写才能不触发 provider 400、`usageHistory` 怎么保留才不会让 Stats 对账出缺口。

但它解决不了"**什么时候压、该不该压**"。模型对这一切毫不知情：

- 模型看不到 context 占用数字，不知道自己快超窗了；
- 模型没有工具去观察会话状态，更别说触发压缩；
- 即使它想压缩，也没有安全的手段——工具执行时 agent 正 busy，直接改 snapshot 会破坏在途请求。

于是我们照 MemGPT 的四件套，一项一项补。

## 三、第一轮落地：session\_\* 会话自治工具族

### 3.1 自我观察：session_info / session_history（内存感知）

MemGPT 的 memory awareness 要求模型知道自己的状态。我们给了两个只读工具：

- `session_info`：会话 id/title/cwd、provider/model/effort/role、消息数、usage、**context 占用估算**——这是模型做压缩决策的依据；
- `session_history`：分页读当前会话历史（start/limit + 截断），模型可以回顾自己说了什么。

两个工具都标了 `readOnly: true`，纯查询、无副作用，模型可以放心调用。

### 3.2 自我编辑：session_compact / session_rewrite / session_set_prompt

然后是 MemGPT 的 self-editing 三件套：

- `session_compact`：触发压缩（复用 `CompactionService`），`preview: true` 可以先看估算不应用；
- `session_rewrite`：把整段历史重写成一条精简总结——这正是用户场景里"让模型自己把上下文压成摘要"的能力；
- `session_set_prompt`：替换/追加当前会话的系统提示词覆盖，下一轮生效——模型发现自己被错误约束困住时，可以自己改。

### 3.3 关键实现决策：写操作为什么延迟到下一轮

这是整个实现里最反直觉、也最重要的一处。工具执行时**不能**直接改 snapshot：

```txt
工具执行时（agent busy）
  agent.getSnapshot()  ← provider 请求正在用这份历史
  agent.loadSnapshot(x) ← 立刻破坏在途请求 → 下一个请求 400

turn:before（agent 空闲、请求未构建）
  可以安全替换 client history + saveCurrent
```

第一版我们图省事放在 `turn:after`，结果撞上一个真实竞态：压缩应用（含 LLM 总结请求）和下一轮对话并发，迟到的 `saveCurrent` 把下一轮已经写好的历史覆盖掉了。最后定在 `turn:before` 应用，一次修复。

另外两个隔离边界：

- **`primaryAgentOnly: true`**：subagent 不能动主会话的历史（subagent 共享 parent 的 registry，工具层还要再拒一道）；
- **compact 的摘要 subagent 必须禁用工具**：它共享 registry，不关的话摘要子任务会再次调用会话工具，递归改自己正在压缩的会话。

## 四、第二轮落地：context-pressure 自动提醒（中断驱动）

MemGPT 的 interrupt 机制翻译成 mica 是这样的：**状态栏的 context 占用变红时，系统主动注入一条用户消息提醒模型压缩**。

判定逻辑直接复用 UI 的着色阈值（`packages/mica-ui/panels/contextThresholds.ts`，与 WorkingStatus 同源，避免双份漂移）：

```txt
ratio ≥ 0.7  或  tokens ≥ 300k   →  进入红色区
提醒后：warned 闩锁
占用回落到 ratio < 0.5          →  解除闩锁（允许再次提醒）
60s 冷却兜底
```

触发时机选在 `contextSize` 更新之后——它每轮 turn 结束更新，正好是 agent 空闲、可以注入的时候。注入的消息走 `queueMode: 'after_turn'`，busy 时由 message-queue 排队，UI 只显示一行 `displayText`（"（系统提醒）上下文占用 85%，建议压缩"），完整文本只进 provider。

实测链路（mock provider，850k tokens / 1M window）：

```txt
turn 1 完成（usage 报 850k）
   │ contextSize 更新 → 插件判定红区
   ▼
自动注入："当前上下文占用已达 85%……请使用 session_compact 工具压缩历史"
   │ after_turn 排队
   ▼
模型下一轮读到提醒 → 决定是否调用 session_compact
```

端到端验证确认了两件事：提醒只注入一次（闩锁生效，红色区间内不重复轰炸）；模型确实收到了完整提醒文本（在 provider history 里可见）。

## 五、我们故意没做的：全自动压缩

MemGPT 还有一层我们没有照搬——让系统在上下文满时**直接**执行压缩，不给模型决策机会。

原因很实在：压缩是破坏性操作，压掉什么内容直接决定模型后续会不会失忆。自动压缩的时机判断（"现在压 vs 再撑一轮"）依赖对任务状态的理解，而这正是模型最擅长、规则最难写对的地方。所以我们的分工是：

```txt
系统负责：发现红区、提醒（确定性规则，阈值可预期）
模型负责：决定是否压缩、压到什么程度（语义判断）
用户负责：兜底否决（看到提醒可以不理会）
```

这个三角色分工比"系统全自动压缩"更稳：提醒是确定性的、可测试的；压缩是语义化的、由最了解上下文的一方决定。

## 六、回头看：MemGPT 到底给了我们什么

如果只从论文里带走一句话，是这句：**上下文管理的决策权，应该从开发者手里移交到模型手里；系统要做的不是替模型做决定，而是给模型做决定所需的信息和工具。**

对照 MemGPT 四件套，mica 现在的完成度：

```txt
MemGPT 机制             mica 落地                   状态
──────────────         ──────────────────────      ──────
self-editing memory    session_compact/rewrite/     ✅
                       set_prompt（延迟到 turn:before）
memory awareness       session_info/history +        ✅
                       system-prompt 固定引导文字
interrupt-driven       context-pressure 插件         ✅
request_heartbeat      天然支持：provider loop 本    ✅
                       就支持 turn 内连续工具调用
```

也留了两个明确的"不做什么"：

- **不做向量检索**：终端工具的历史检索用 grep 就够，上 embedding 是过度设计；
- **不做跨任务权重进化**：论文里"收集失败轨迹 → 微调 → 迭代提升"是训练级的事，和运行时上下文管理是两条路。我们做的只是后者。

最后提一个容易踩的坑：`system-prompt:build` 里注入的引导文字必须**固定**，不能带动态数字（比如实时 token 占用）。动态内容会打散 prompt cache，让每一次请求都多付一大笔前缀重算成本。动态数字只放在工具返回值里。

上下文管理的本质问题不是"怎么压缩"，而是"谁来决定"。MemGPT 的答案是：把决定权交给那个唯一知道上下文里装着什么的人——模型自己。
