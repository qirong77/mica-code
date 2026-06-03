# 终端里的浏览器体验：事件、选择与虚拟滚动

前两篇分别讲了 ink 的基础渲染管线（数据怎么从 React 状态变成终端屏幕上的字符）和 fork 的四项核心性能优化（Packed Buffer、Blit Cache、Damage Tracking、闪烁消除）。

但一个完整的 UI 框架不能只把东西画对、画快——还要能交互。用户要能点击组件、选择文本、滚动内容、触发快捷键。浏览器天然提供了 Selection API、scroll 事件、鼠标事件、焦点管理——终端一个都没有。

本篇聚焦 fork 为终端实现的四套交互系统：事件系统（捕获冒泡与优先级映射）、文本选择（选区高亮与软换行处理）、ScrollBox（虚拟滚动与惯性滚动），以及键盘快捷键绑定。最后附上完整的优化对比表与系列总结。

---

## 第六章：Event System——终端里的事件冒泡


开源 ink 的事件处理很简单——全局监听 stdin，不太关心事件应该分发给哪个组件。Fork 实现了一套完整的、模仿浏览器的事件系统。

### 6.1 捕获与冒泡

和浏览器一样，事件分为三个阶段：

```
         root
          |   ^  ← 冒泡阶段（从 target 向上）
          v   |
    parent     |
      |  ^     |
      v  |     |
    target  ———    ← 目标阶段

    捕获阶段（从 root 向下）
    ↑         |
    └─────────┘
```

`Dispatcher.collectListeners()` 从 target 走到 root，收集沿途的捕获处理器（unshift 到列表头）和冒泡处理器（push 到列表尾），形成完整的处理链。

### 6.2 事件优先级映射到 React 调度

不同类型的终端事件有不同的优先级，映射到 React reconciler 的调度优先级：

```typescript
function getEventPriority(eventType) {
  switch (eventType) {
    case 'keydown': case 'keyup': case 'click':
    case 'focus': case 'blur': case 'paste':
      return DiscreteEventPriority    // 同步处理，不中断
    case 'resize': case 'scroll': case 'mousemove':
      return ContinuousEventPriority  // 可被更高优先级事件中断
    default:
      return DefaultEventPriority
  }
}
```

这和 react-dom 对 DOM 事件的优先级映射完全一致——键盘和点击是 Discrete（用户预期立即响应），鼠标移动和滚动是 Continuous（允许批量处理）。

### 6.3 终端特有的事件类型

fork 支持终端特有的事件：
- **MouseEvent**：通过 `ENABLE_MOUSE_TRACKING`（`\x1b[?1003h`）启用鼠标追踪，终端发送鼠标坐标
- **PasteEvent**：通过 bracketed paste（`\x1b[?2004h`）区分粘贴内容和键盘输入
- **TerminalFocusEvent**：通过 `\x1b[?1004h` 感知终端窗口获得/失去焦点
- **ResizeEvent**：监听 `stdout` 的 resize 事件

**类比前端**：这就好比你在浏览器里监听 `mousemove`、`paste`、`focus/blur`、`resize`——只不过信息来源从浏览器事件变成了终端发送的 ANSI 序列。

### 6.4 复合键绑定系统

fork 实现了一套完整的 Keybinding 系统，支持：
- **复合键**：`Ctrl+Shift+K`、`Cmd+Enter`
- **和弦**：`Ctrl+K` 然后 `Ctrl+B`（像 Vim 那样）
- **冲突解析**：同一个键在不同上下文（context）里可以绑定不同行为
- **显示文本生成**：把绑定转成人类可读的快捷键提示（如 `^K ^B`）


---

## 第七章：文本选择——在字符网格上模拟选区

在浏览器里，文本选择是浏览器原生能力。在终端里，你得从头实现。

### 7.1 数据结构

选择需要记录起始点（anchor）和当前点（focus），以及一个 "scrolled-off-screen" 的文本缓冲区：

```typescript
type SelectionState = {
  anchor: { row: number, col: number } | null
  focus: { row: number, col: number } | null
  isDragging: boolean
  scrolledOffAbove: string[]    // 滚出屏幕顶部的文本
  scrolledOffBelow: string[]    // 滚出屏幕底部的文本
}
```

当用户滚动 ScrollBox 时，选中的文本可能部分滚出了可见区域。`captureScrolledRows` 在文本即将滚出屏幕时把它存到 `scrolledOffAbove/Below`，这样即使文本不在当前 screen buffer 里，用户仍能复制到完整内容。

### 7.2 高亮渲染

选中区域的高亮不是简单的 SGR 7 inverse（反转色）。SGR 7 会交换前景色和背景色，导致语法高亮的每个 token 变成不同背景色——视觉效果碎片化。

Fork 使用 `StylePool.withSelectionBg()`：替换 cell 的背景色为统一的选取色（如蓝色），但保留前景色。这模拟了浏览器和原生终端（iTerm2、Terminal.app）的选择效果。

```typescript
withSelectionBg(baseId: number): number {
  // 保留前景色、粗体、斜体，替换背景色为选取色
  const kept = this.get(baseId).filter(
    c => c.endCode !== '\x1b[49m' && c.endCode !== '\x1b[27m'
  )
  kept.push(selectionBgColor)
  return this.intern(kept)
}
```

### 7.3 软换行处理

终端的文本换行有两种：
- **硬换行**：用户按了 Enter，是真的段落分隔
- **软换行**：文本太长，终端自动换行

复制文本时，软换行不应该插入换行符（它只是视觉折行）。Fork 用 `screen.softWrap` 数组跟踪每行是不是软换行：

```typescript
// softWrap[row] > 0  → 这一行是软换行，复制时不要加 \n
screen.softWrap = new Int32Array(height)
```

`getSelectedText()` 读取选中文本时，检查 softWrap 数组决定是否拼接行。

### 7.4 独立渲染匹配搜索结果

搜索结果的高亮通过 `renderToScreen()` 实现——把一条消息**独立渲染**到一个隔离的 Screen buffer，然后扫描 buffer 查找查询词位置，最后把位置映射回主 screen 做高亮叠加。这是搜索高亮与选区高亮的两层叠加机制。


---

## 第八章：ScrollBox——终端里的虚拟滚动


ScrollBox 是 fork 中最复杂的组件。它实现了一个类似 `overflow: scroll` 的容器，包括虚拟滚动、粘性滚动（自动追底）和惯性滚动。

### 8.1 虚拟滚动

不是从 React 层面做虚拟化（只渲染可见项目），而是在布局和渲染层做裁剪：

1. Yoga 布局计算所有子节点的完整尺寸（包括不可见部分）
2. `renderNodeToOutput()` 根据 `scrollTop` 和 viewport 尺寸裁剪可见区域
3. 子节点通过 blit 缓存，避免未变区域的重复渲染

```typescript
// 每个 DOMElement 维护自己的滚动状态
scrollTop?: number         // 当前滚动偏移（行数）
scrollHeight?: number      // 内容总高度
scrollViewportHeight?: number  // 可见区域高度
stickyScroll?: boolean     // 是否自动追底（如 streaming 文本）
```

### 8.2 粘性滚动（Sticky Scroll）

当 ScrollBox 设置 `stickyScroll: true` 时，如果用户在底部，新内容自动追底；如果用户手动滚动了，不追底。

```typescript
// 在渲染时判断：
if (stickyScroll && scrollTop >= maxScroll - 1) {
  scrollTop = maxScroll  // 自动追底
}
```

这就是你在聊天界面看到的效果：新消息来了自动滚动到底部，但如果你往上翻看历史消息，新消息不会把你弹回底部。

### 8.3 惯性滚动与平滑 drain

鼠标滚轮的每个 tick 产生一个 delta。Fork 不是直接把 delta 加到 scrollTop（会导致一跳一跳的），而是**累积到 `pendingScrollDelta`**，每帧 drain 一部分（约 3/4），产生自然的减速效果。

```typescript
// 每帧：
const step = Math.max(4, Math.ceil(pendingScrollDelta * 3 / 4))
scrollTop += step
pendingScrollDelta -= step

if (pendingScrollDelta === 0) {
  // 停止 drain，不再调度额外帧
} else {
  // 还有剩余，调度下一帧继续 drain
}
```

**类比前端**：这就是 CSS `scroll-behavior: smooth` + `ease-out` 缓动在终端的手动实现。


---

## 第九章：完整对比表

| 优化 | 解决的问题 | 前端类比 |
|---|---|---|
| Packed Int32Array | 每帧 24000 个对象导致 GC 暂停 | Float32Array 替代对象数组（WebGL 模式） |
| CharPool | 重复字符串对象 | 字符串驻留（V8 内部机制） |
| StylePool | 每次计算 ANSI 过渡序列 | CSS-in-JS 样式注入缓存 + transition cache |
| Blit Cache | 未变组件全量重绘 | React.memo + 渲染层 memo |
| Damage Rect | 全量 screen diff（O(n^2)） | 脏矩形优化（浏览器合成器） |
| Diff-based Rendering | clear + repaint = 闪烁 | Virtual DOM diff + patch |
| BSU/ESU | 部分更新提前显示 = 闪烁 | requestAnimationFrame 批量提交 |
| DECSTBM | 滚动时重绘全部区域 | transform: translateY GPU 合成 |
| Render Throttle | 状态更新频率 > 渲染频率 | React 18 自动批处理 |
| Pure-TS Yoga | WASM 加载延迟 + 不必要的特性 | Fork 构建工具的插件系统 |
| Event System | 全局事件处理 | DOM 事件捕获/冒泡三阶段 |
| Text Selection | 无法选择文本 | Selection API + getSelection() |
| ScrollBox | 无滚动容器 | overflow: scroll + CSS scroll-behavior |
| Search Highlight | 搜索无高亮 | Find-in-page (Ctrl+F) |
| Keybinding System | 键盘快捷键冲突 | 浏览器全局快捷键 + 上下文感知 |

---

## 第十章：总结

用一句话概括：**这个 fork 做的事情，就是把 React 在浏览器里做的事情（虚拟 DOM diff、批量更新、合成优化、事件系统、布局引擎）在终端里重新实现了一遍。**

作为前端工程师，理解这个 fork 的价值不仅仅是理解"我们改了什么"。更重要的教训是：

1. **数据结构的紧凑性直接决定渲染性能**。从对象数组到 Packed Int32Array 的转换是 GC 压力的根本解决方案。
2. **缓存是通用的性能策略**。无论是 StylePool 的 ANSI 过渡缓存、LayoutNode 的布局结果缓存、还是 Blit Cache 的渲染结果缓存——模式都是"算一次、存起来、下次直接用"。
3. **充分利用终端的能力**。BSU/ESU、DECSTBM 这些不是 hack，是标准化的终端协议。浏览器有 GPU 合成，终端有硬件滚动——不用白不用。
4. **限流应该在正确的层级做**。`useScheduleState` 是业务层的 workaround；Fork 在渲染层限流是正确的位置。每个问题都有它应该在的抽象层级。
