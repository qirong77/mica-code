# 从 React 的视角理解终端渲染：为什么我们 fork 了 ink

> 作为一个前端开发，你可能觉得"在终端里渲染 React 组件"就是把 JSX 转成字符串然后 `console.log`。直到你发现**终端不是浏览器**——它没有 CSS、没有 DOM、没有 `requestAnimationFrame`、甚至没有"像素"的概念。

mica-code 的终端 UI 基于开源 [ink](https://github.com/vadimdemedes/ink) 库，但我们 fork 了一个自己的版本（`@anthropic/ink`）。这篇文章从前端工程师的视角出发，逐层解释我们为什么 fork，以及我们在每一层做了什么优化。

本文假设你熟悉 React 的基本概念（组件、JSX、虚拟 DOM、state 更新），但对终端工作原理不熟悉。先讲终端基础，再讲每一层优化。

---

## 第零章：终端怎么"显示"东西？

| | 浏览器 | 终端 |
|---|---|---|
| 最小渲染单元 | 像素 | **字符格（cell）** |
| 布局引擎 | CSS Flexbox/Grid | 无（需自己实现） |
| 样式 | CSS 属性 | **ANSI 转义序列** |
| 更新方式 | DOM diff → 浏览器合成 | **逐 cell 写入字节流** |
| 通信 | HTTP/WebSocket | **stdin/stdout 字节流** |

终端的屏幕是一个二维的**字符网格**。比如你的窗口是 80 列 * 24 行，就是一个 80*24 的表格，每个格子叫一个 **cell**。一个 cell 有字符内容和样式（颜色、加粗等）。

**ANSI 转义序列是终端的"CSS"**。浏览器里写 `style={{ color: 'red' }}`，终端里发出 `\x1b[31m`（前景色变红）+ 字符 + `\x1b[0m`（重置）。它是状态切换指令流，不是成对的标签。

---

## 第一章：整个渲染流水线（端到端概览）

在深入每一层优化之前，先理解从 React 状态变化到终端显示字符的全过程。

### 1.1 React 状态变化 → reconciler

当你调用 `setState`，React 的 reconciler（和 React DOM 用的是同一个 `react-reconciler`）计算哪些 Fiber 节点需要更新。然后调用 ink 自定义的 host config：

```typescript
// 不是 document.createElement，而是 createNode('ink-box')
createInstance('ink-box', props, root, hostContext)
// 不是 element.appendChild，而是 appendChildNode(parent, child)
appendChild(parentNode, childNode)
// 不是 element.setAttribute，而是 setAttribute(node, key, value)
commitUpdate(node, oldProps, newProps)
```

这个 host config 把 React 的更新操作"翻译"成对虚拟终端树的操作。虚拟终端树由 `DOMElement` 节点组成——和浏览器的 DOM 类似，但每个节点附带了 Yoga 布局信息。

### 1.2 布局计算（Yoga Flexbox）

Reconciler 的 `resetAfterCommit` 钩子触发布局计算。调用 `rootNode.onComputeLayout()`，它内部执行：

```typescript
rootNode.yogaNode.setWidth(terminalColumns)
rootNode.yogaNode.calculateLayout(terminalColumns)
```

这会遍历整棵 Yoga 节点树，根据 Flexbox 规则（`flexDirection`、`flexGrow`、`alignItems` 等）计算出每个节点的位置 (`left`, `top`) 和尺寸 (`width`, `height`)。

**关键差异**：开源 ink 使用 Facebook 的 Yoga WASM 二进制（通过 `yoga-layout` npm 包）。我们的 fork 删除了这个依赖，用了一个纯 TypeScript 实现（`yoga-layout/index.ts`，约 2500 行）。为什么？

- **启动速度**：省去 WASM 加载时间（实测约 8-15ms）
- **性能可控**：实现针对 ink 的实际使用场景做了大量裁剪和优化——只实现 ink 真正用到的 Flexbox 子集，删掉了 `aspect-ratio`、`box-sizing: content-box`、RTL 等不需要的特性
- **缓存机制**：实现添加了多层布局缓存（单槽 `_hasL`、多槽 `_cIn/_cOut`、flex-basis 缓存 `_fbBasis`），脏节点传播时可以跳过大量干净的子树。500 个消息的 ScrollBox + 一个脏叶子节点，重新布局从 76k 次 `layoutNode` 调用降至 4k 次

**类比前端**：就像你 fork 了 `postcss` 然后移除所有不用的插件，加了自己的缓存层——体积更小、跑得更快。

### 1.3 渲染到 Screen Buffer

布局计算完成后，`onRender` 被调度执行。核心流程：

```
renderNodeToOutput(rootNode, output, { prevScreen })
  → 遍历虚拟终端树
  → 每个 Text 组件转换为一串 cell 写入操作
  → 每个 Box 组件可能触发 blit（重用缓存）、clear（擦除旧区域）
  → 所有操作收集在 Output 的操作队列里
  → output.get() 将所有操作应用到 Screen buffer
```

**Screen buffer** 是这章最核心的概念。它是渲染的"目标画布"——一个二维数组，每个元素代表一个 cell 的最终状态。后续的 diff、选择、高亮都在这块 buffer 上操作。

### 1.4 Diff 计算

拿到当前帧的 Screen buffer 后，`log-update.ts` 对比上一帧的 buffer：

```typescript
diffEach(prev.screen, next.screen, (x, y, removed, added) => {
  // 对每个变化的 cell，生成一个 Patch
  // Patch 可以是：移动光标、切换样式、写字符、清屏...
})
```

结果是一个 `Patch[]` 数组——最小化的终端操作序列。

### 1.5 写入终端

`optimize()` 合并连续的同类型 Patch（例如两个相邻的 `cursorMove` 合并为一个），然后 `writeDiffToTerminal()` 把所有 Patch 序列化为 ANSI 字节流写入 `stdout`：

```typescript
let buffer = BSU   // 开始同步更新（后面会解释）
for (const patch of optimized) {
  buffer += serializePatch(patch)
}
buffer += ESU      // 结束同步更新
terminal.stdout.write(buffer)
```

终端收到字节流后解析执行——移动光标、设置颜色、写字符——屏幕上就出现了更新后的 UI。

### 1.6 缓冲区交换

最后一步，双缓冲 swap：

```typescript
this.backFrame = this.frontFrame
this.frontFrame = frame   // frame 是本帧的渲染结果
```

`frontFrame` 是"当前显示在屏幕上的那一帧"，`backFrame` 是下一帧复用内存的备用 buffer。下一帧渲染时：
- `backFrame` 被 `resetScreen()` 清零，用于承载新的渲染结果
- `frontFrame`（即上一帧的结果）作为 diff 的参考

**类比前端**：这是图形学中的经典"双缓冲"（double buffering）——一个 buffer 显示，一个 buffer 绘制，交替使用避免撕裂。


---

## 第二章：Screen Buffer 的内存优化


### 2.1 开源 ink 的问题：每帧创建大量对象

开源 ink 的 Screen buffer 是一个二维对象数组：

```typescript
type Cell = { char: string; style: object }
const screen: Cell[][] = new Array(height)
  .fill(null)
  .map(() => new Array(width).fill({ char: ' ', style: {} }))
```

一个 200 * 120 的终端 = 24000 个 Cell 对象。每帧重新创建，V8 的 GC 要回收 24000 个对象。想象你每 16ms 就 `new Array(24000)` 然后立刻丢弃——GC 会频繁触发 "stop-the-world" 暂停。

### 2.2 Fork 的方案：Packed Int32Array

Fork 把整个 screen buffer 存进一个 TypedArray。每个 cell 不再是一个对象，而是**两个 Int32 整数**，紧凑地打包在一个连续的 ArrayBuffer 里：

```typescript
// 一个 cell = 2 个 Int32，存在 Int32Array 中
// word0: charId    → 这个 cell 的字符在 CharPool 中的索引
// word1: styleId[31:17] | hyperlinkId[16:2] | width[1:0]
//        样式 ID 15bit | 链接 ID 15bit | 宽度 2bit

const cells = new Int32Array(width * height * 2)
// 同时提供 BigInt64 视图，用于批量清零：
const cells64 = new BigInt64Array(cells.buffer)
```

24000 个 cell —— 不再是 24000 个对象，而是一块 48000 个整数的连续内存，零 GC 压力。

重置 screen 只需要一行：
```typescript
cells64.fill(0n, 0, size)  // 整个 buffer 一键清零
```

**类比前端**：就像你从 `Array<{x: number, y: number}>` 换成 `Float32Array`（WebGL 里的 `gl.bufferData`），把大量小对象压缩成连续内存块，CPU 缓存友好、GC 友好。

### 2.3 CharPool：字符串驻留

`'H'` 这个字符在聊天界面可能出现几百次。与其创建几百个同样的字符串，不如只存一个索引：

```typescript
class CharPool {
  private strings: string[] = [' ', '']  // 索引 0: 空格, 索引 1: 空字符串
  private ascii: Int32Array  // ASCII 快速路径

  intern(char: string): number {
    if (char.length === 1) {
      const code = char.charCodeAt(0)
      if (code < 128) return this.ascii[code]  // 直接 Int32Array 查表
    }
    return this.stringMap.get(char) ?? this.insert(char)
  }
}
```

**类比前端**：这是经典的字符串驻留（string interning）模式——和 V8 内部对字符串的处理方式一样。数字比较比字符串比较快 10 倍以上。

### 2.4 StylePool：样式驻留 + ANSI 过渡缓存

这是最精妙的部分。问题背景：

在终端里从"红色加粗"切换到"蓝色"需要发出 `\x1b[0m\x1b[34m`（先重置红和粗，再设蓝）。每帧有几千个 cell 可能发生样式切换，每次都计算这个过渡字符串 = 巨大的重复计算。

StylePool 做了两件事：

**① 样式驻留**：把一组样式（如 `[红色, 加粗]`）转成一个整数 ID。

```typescript
class StylePool {
  intern(styles: AnsiCode[]): number {
    const key = styles.map(s => s.code).join('\0')
    return this.ids.get(key) ?? this.insert(key, styles)
  }
}
```

**② ANSI 过渡缓存**：从 style 42 切换到 style 99 需要的序列预先算好并缓存。

```typescript
transition(fromId: number, toId: number): string {
  const key = fromId * 0x100000 + toId    // 把两个 ID 打包成唯一 key
  let str = this.transitionCache.get(key)
  if (str === undefined) {
    str = ansiCodesToString(diffAnsiCodes(this.get(fromId), this.get(toId)))
    this.transitionCache.set(key, str)
  }
  return str   // 后续调用直接拿缓存字符串，零计算
}
```

**类比前端**：这就像 CSS-in-JS 库（styled-components, Emotion）把样式规则 hash 成一个类名并缓存对应的 CSS 文本。但 fork 更进一步——它不仅缓存"这个样式长什么样"，还缓存了"从样式 A 变到样式 B 需要发出的指令序列"。

总结：Screen buffer 的三个池（CharPool、HyperlinkPool、StylePool）协作——char 是数字索引、hyperlink 是数字索引、style 也是数字索引。比较两个 cell 是否相同变成了比较 2 个 Int32，而不是比较 3 个字符串 + 1 个 AnsiCode 数组。


---

## 第三章：Blit Cache——不变的组件跳过渲染


React reconciler 知道哪个组件变了、哪个没变。开源 ink 没有利用这个信息——它每帧都全量重建 screen。Fork 利用了这个信息。

### 3.1 核心思想：组件级别的渲染缓存

每个 `DOMElement`（ink 的虚拟终端节点）可以缓存它上一帧的渲染结果。如果这个组件没变：
- 不重新遍历它的子树
- 不重新写 cell
- 直接从缓存的 Screen buffer 中**拷贝一块连续内存**到当前帧的 buffer

```typescript
// 不是"重绘"，是 TypedArray.set——一次内存拷贝
dstCells.set(srcCells.subarray(srcStart, srcStart + bytes), dstStart)
```

### 3.2 脏标记传播（Dirty Flag）

类似 React 的 `shouldComponentUpdate`，但更底层：

```typescript
function markDirty(node: DOMElement): void {
  node.dirty = true
  // 向上传播到根节点——祖先也需要重新渲染
  if (node.parentNode) markDirty(node.parentNode)
}
```

渲染时判断：
- 节点干净 → 从 `nodeCache` 取出上一帧的渲染区域 → **blit**（内存拷贝）
- 节点脏 → 递归渲染子树 → 写入当前帧的 screen buffer → 存回 `nodeCache`

### 3.3 缓存增删处理

当组件被删除时，上一帧它在 screen 上占据的区域需要被清除。`pendingClears` 跟踪：

```typescript
const pendingClears = new WeakMap<DOMElement, Rectangle[]>()

function addPendingClear(parent, rect, isAbsolute) {
  // 记录"这个父节点下有一个子节点消失了，需要清除它的屏幕区域"
  const list = pendingClears.get(parent) || []
  list.push(rect)
  pendingClears.set(parent, list)
}
```

**类比前端**：Blit Cache 就像是把 `React.memo` + `shouldComponentUpdate` 搬到了渲染层。但比 React 的 memo 更强——它不仅跳过 React 的重新执行，还跳过了整个渲染管线（布局 + rasterize + diff）。一个 80 行 10 列的 Box 如果不变化，渲染成本是 0。

### 3.4 实际效果

在一个典型的聊天界面中，50 条历史消息不会变化，只有最后一条消息在新增内容。开源 ink 每帧渲染 50 条消息，fork 只渲染 1 条——另外 49 条通过 blit 直接从缓存拷贝。


---

## 第四章：Damage Tracking——只 diff 脏区

### 4.1 开源 ink 的问题：全量 diff

开源 ink 对比新旧 screen 时，遍历全部 cell（80*24=1920 个）。大部分 cell 没变化，但 diff 函数不知道——它必须检查每个 cell。

### 4.2 Fork 的方案：自动追踪的脏矩形

Fork 在 `setCellAt` 函数里自动维护一个 "damage rectangle"：

```typescript
function setCellAt(screen, x, y, cell) {
  cells[ci] = internChar(screen, cell.char)
  cells[ci + 1] = packWord1(cell.styleId, cell.hyperlinkId, cell.width)

  // 自动扩展 damage 矩形
  if (screen.damage) {
    screen.damage = unionRect(screen.damage, { x, y, width: 1, height: 1 })
  } else {
    screen.damage = { x, y, width: 1, height: 1 }
  }
}
```

之后 `diffEach` 只在 damage 矩形范围内做对比：

```typescript
function diffEach(prev, next, cb) {
  const region = next.damage   // 只检查这块区域
  for (let y = region.y; y < region.y + region.height; y++)
    for (let x = region.x; x < region.x + region.width; x++)
      // 对比两个 Int32
```

在稳态帧下（例如一个 spinner 动画在角落转），damage 可能只覆盖 2*1 个 cell——diff 几乎瞬时完成。

### 4.3 findNextDiff：批量跳过未变 cell

diff 内部还有一个微优化。对比相邻 cell 时，用 `findNextDiff` 一口气跳过连续的相同 cell：

```typescript
function findNextDiff(a, b, offset, count) {
  for (let i = 0; i < count; i++, offset += 2) {
    // 每个 cell 是 2 个 Int32，一次比较两个整数
    if (a[offset] !== b[offset] || a[offset | 1] !== b[offset | 1]) return i
  }
  return count
}
```

**类比前端**：这就是 DOM diff 里的"跳过相同 key 的节点"，但对 TypedArray 做了专门优化——Int32 比较是 CPU 原生指令，不需要解引用字符串或对象。


---

## 第五章：为什么开源 ink 会闪烁，Fork 不会


这个问题是迫使 mica-code 写 `useScheduleState.ts` 的根本原因。

### 5.1 闪烁的根源

开源 ink 在内容变化时，发送一个 clear screen 序列（`\x1b[2J`）擦除整个终端，然后逐行写入新内容。用户看到的是：

```
[旧画面] → 清屏 → [空白, 几毫秒] → [新画面]
```

那个几毫秒的空白就是闪烁。在 streaming 文本场景中，每帧 screen height 都在变化（新内容追加），触发 clear → 每帧都闪烁。

### 5.2 解决方案一：增量 Diff（最根本）

不开 clear screen。每帧对比新旧 buffer，只把**真正变化的 cell**发送给终端：

```typescript
// 不是: clear screen → 写全部 24000 个 cell
// 而是: 找到变化的 30 个 cell → 移动光标 → 写样式 → 写字符

diffEach(prev.screen, next.screen, (x, y, removed, added) => {
  moveCursorTo(x, y)          // 跳到目标位置
  writeStyleTransition(from, to)  // 切换样式
  writeChar(added.char)       // 写字符
})
```

对比开源 ink 和 fork 在相同场景下的终端写操作：

| | 开源 ink | Fork |
|---|---|---|
| 终端写操作 | clear(2ms) + 24000 个 cell(8ms) | 30 个 cell(~0.1ms) |
| 视觉 | 闪烁 | 无感 |

### 5.3 解决方案二：同步输出（BSU/ESU）

浏览器有 `requestAnimationFrame` 确保在帧渲染前完成所有 DOM 变更。终端也有类似的机制——DEC 2026 同步输出。

BSU = `\x1b[?2026h` = Begin Synchronized Update
ESU = `\x1b[?2026l` = End Synchronized Update

```typescript
function writeDiffToTerminal(terminal, diff) {
  let buffer = BSU              // "终端，先别渲染"
  for (const patch of diff)
    buffer += serializePatch(patch)
  buffer += ESU                 // "好了，现在一起渲染"
  terminal.stdout.write(buffer)
}
```

终端在 BSU 和 ESU 之间把内容画到离屏 buffer，收到 ESU 后**原子性地翻转**到屏幕上。用户永远看不到中间状态。

`isSynchronizedOutputSupported()` 对 12+ 种终端返回 true（iTerm2、kitty、WezTerm、Windows Terminal、VTE 0.68+、Ghostty、foot 等），覆盖绝大多数用户。

**类比前端**：BSU/ESU 就像浏览器的合成器——你把所有 DOM 变更都操作完，浏览器在 vsync 前一次性合成并显示。你不会看到某个 div 先变宽、再变红、再变高——你只看最终结果。BSU/ESU 给终端带来了同样的原子性保证。

### 5.4 解决方案三：渲染层限流

React 状态能以任意频率更新（每秒 1000 次 setState），但渲染被 throttle 到最多 60fps：

```typescript
// 渲染不是实时的，是 throttled + microtask 延迟的
const deferredRender = () => queueMicrotask(this.onRender)
this.scheduleRender = throttle(deferredRender, 16, {
  leading: true,   // 第一次立即执行
  trailing: true,  // 最后一次也执行
})
```

`queueMicrotask` 让 React 的 effect 阶段（`useLayoutEffect`、`useEffect`）在渲染前跑完。如果同一个 tick 内多次 setState，它们合并为一次 commit，只触发一次 `onRender`。

**类比前端**：这是 React 18 的自动批处理（automatic batching）在终端渲染层的延伸。React 管组件层的批处理更新，ink 管渲染层的限流输出。

### 5.5 解决方案四：硬件滚动（DECSTBM）

当 ScrollBox 翻页时，不需要重绘整个滚动区域。终端支持"硬件滚动"——设置一个滚动区域，然后发指令让终端自己滚：

```typescript
// 设置滚动区域：第 5 行到第 20 行
setScrollRegion(5, 20)
// 硬件向上滚动 3 行
csiScrollUp(3)
// 然后只重绘新出现的那 3 行
```

**类比前端**：就像 `overflow: scroll` 用 `transform: translateY(-3em)` 由 GPU 合成层完成，不触发 layout/paint。终端的硬件滚动完全绕过软件渲染。

### 5.6 useScheduleState 的本质

回头看 mica-code 的 `src/components/ui/hooks/useScheduleState.ts`：

```typescript
const THROTTLE_INTERVAL = 16
// 把 nanostores atom 的 setState 调用合并到 16ms 一批
scheduleFlush() -> batch setState
```

这是在**业务状态层**手动限流——减少 React 渲染次数来减少 ink 的 clear+repaint 次数，从而减少闪烁。

换上 `@anthropic/ink` 后，这个 workaround 原则上不再需要。React 可以自由更新，渲染引擎自己保证原子性和帧率。

把 `useScheduleState` 类比为：因为你的老式显卡不支持垂直同步，你必须在 JS 里用 `setTimeout(fn, 16)` 手动控制帧率。换上支持 vsync 的显卡（fork）后直接用 `requestAnimationFrame` 就行。


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
