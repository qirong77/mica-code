# 从 React 到终端字符：ink 渲染管线全景

> 作为一个前端开发，你可能觉得"在终端里渲染 React 组件"就是把 JSX 转成字符串然后 `console.log`。直到你发现**终端不是浏览器**——它没有 CSS、没有 DOM、没有 `requestAnimationFrame`、甚至没有"像素"的概念。

mica-code 的终端 UI 基于开源 [ink](https://github.com/vadimdemedes/ink) 库，但我们 fork 了一个自己的版本（`@anthropic/ink`）。本系列文章从前端工程师的视角，逐层解释为什么需要 fork、fork 做了什么。

这是第一篇，聚焦**基础概念和渲染管线**——先搞清楚数据是怎么从 React 状态变成终端屏幕上的字符的。后续两篇分别深入性能优化和交互能力。

本文假设你熟悉 React 的基本概念（组件、JSX、虚拟 DOM、state 更新），但对终端工作原理不熟悉。先讲终端基础，再讲完整渲染流程。

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

## 第一章：从 setState 到屏幕上的字符

在你深入后面的优化章节之前，先把整个流程串起来：当你调用 `setState({ text: 'hello' })` 之后，终端怎么知道要在哪个位置显示什么文字？

### 1.1 React 算完谁变了，通知 ink

`setState` 触发后，React 的核心引擎（reconciler）开始计算哪些组件需要更新。这个 reconciler 和浏览器里的 React DOM 用的是同一个 `react-reconciler` 包，但它不操作真实的 DOM，而是调用 ink 提供的一套"翻译函数"：

```typescript
// 浏览器里：document.createElement('div')
// ink 里：createInstance('ink-box', props, root, hostContext)

// 浏览器里：parent.appendChild(child)
// ink 里：appendChild(parentNode, childNode)

// 浏览器里：element.setAttribute('title', 'hello')
// ink 里：commitUpdate(node, oldProps, newProps)
```

这套函数叫做 host config。它把 React 的"增删改查"操作翻译成对一棵虚拟终端树的操作。这棵树由 `DOMElement` 节点组成——你可以把它理解成浏览器 DOM 的终端版本，每个节点附带布局信息。

### 1.2 算出每个组件放在哪、占多大

React 更新完虚拟树后，`resetAfterCommit` 钩子触发布局计算。ink 用 Yoga（Facebook 的 Flexbox 引擎）来算位置和尺寸：

```typescript
rootNode.yogaNode.setWidth(terminalColumns)     // 告诉 Yoga 终端有多宽
rootNode.yogaNode.calculateLayout(terminalColumns) // 开算
```

Yoga 会遍历整棵节点树，根据 Flexbox 规则（`flexDirection`、`flexGrow`、`alignItems` 等）算出每个节点的 `left`、`top`、`width`、`height`。

**Fork 的 Yoga 和开源有什么不同？**

开源 ink 用 Facebook 的 Yoga，但它是以 WASM 二进制文件的形式加载的。Fork 删掉了这个依赖，用了一个纯 TypeScript 实现（`yoga-layout/index.ts`，约 2500 行）。

为什么要自己写？

- **启动更快**：省去 WASM 加载时间，实测约 8-15ms
- **只保留需要的功能**：Fork 的 Yoga 只实现了 ink 真正用到的 Flexbox 子集，删掉了 `aspect-ratio`、`box-sizing: content-box`、RTL（从右到左的文字排版）等用不上的特性
- **加了多层缓存**：引入了单槽缓存 `_hasL`、多槽缓存 `_cIn/_cOut`、flex-basis 缓存 `_fbBasis`。遇到脏节点时，大量干净的子树可以跳过。实测效果：500 条消息的 ScrollBox 里只有一个叶子节点变了，重新布局的调用次数从 76000 次降到了 4000 次

### 1.3 把组件"画"到 Screen Buffer 上

布局算完了，该"画"了。`onRender` 被触发，遍历整棵虚拟终端树，把每个节点的文字、样式、位置转化成对 Screen Buffer 的写入操作：

```
renderNodeToOutput(rootNode, output, { prevScreen })
  → 遇到 Text 组件：算它能铺满几个 cell，把字符和样式写进对应 cell
  → 遇到 Box 组件：如果没变，直接 blit（从缓存拷贝一块连续内存）
                   如果变了或删了，擦除旧区域，写入新内容
  → 所有操作收集到 Output 队列里
  → output.get() 把队列里的所有操作合起来，一次性应用到 Screen Buffer
```

**Screen Buffer 就是渲染的"画布"**。它是一个二维数组，每个元素代表一个 cell 的最终状态——包含显示什么字符、什么颜色、是否粗体等。后面的 diff（对比新旧两帧）、文本选择、搜索高亮，都是在这块 buffer 上操作的。

但这里有个问题：你不能直接在用户正在看的那个画布上改。一边擦一边画，用户会看到中间状态——闪。

### 1.4 双缓冲：一块画、一块看

ink 用两块 Screen Buffer 交替工作：

```typescript
this.backFrame  // 后台 buffer：渲染时往这块画，用户看不见
this.frontFrame // 前台 buffer：当前显示在屏幕上的那一帧
```

每轮渲染的流程是：

1. **清空 `backFrame` 的 screen buffer**（`resetScreen()`），准备接收新内容
2. **`renderNodeToOutput` 往 `backFrame` 上画**（1.3 节描述的过程）
3. **diff `backFrame` 和 `frontFrame`**，找出哪些 cell 变了（1.5 节）
4. **把差异序列化成 ANSI 字节流写入终端**（1.6 节）
5. **swap**：`frontFrame = backFrame`，刚画好的变成"正在显示的"

这就是双缓冲——"先画后换，画的时候不给人看"。游戏引擎、浏览器合成器用的都是同一招。

### 1.5 diff：只更新真正变了的 cell

上一步把新帧画在了 `backFrame` 上。现在对比 `backFrame` 和 `frontFrame` 的 screen buffer，找出哪些 cell 变了：

```typescript
// 遍历当前帧中"被写入过"的区域（damage rectangle）
for (const [x, y] of backFrame.damagedCells()) {
  const old = frontFrame.screen[y][x]  // 旧 cell
  const cur = backFrame.screen[y][x]   // 新 cell
  if (old !== cur) {
    patches.push({
      type: 'cell',
      x, y,
      char: cur.char,
      style: cur.style,
      // 如果新 cell 是空格但旧 cell 有字符，生成"清除"指令
    })
  }
}
```

这里有一个关键概念——**damage rectangle（脏矩形）**。渲染过程（`renderNodeToOutput`）在往 `backFrame` 写入时，同步记录"哪些区域被碰过了"。diff 只检查这些区域，而不是遍历整屏所有 cell。

结果是一个 `Patch[]` 数组，每个 Patch 描述一个 cell 级别的变动：移动到 (x, y)、设置样式、写一个字符、清除一个区域……

### 1.6 把 Patch 序列化成 ANSI 字节流

`Patch[]` 还不能直接送进终端。先做一轮合并优化——比如两个连续的"移动光标"可以合成一个——然后逐个序列化成 ANSI 转义序列：

```typescript
// BSU = Begin Synchronized Update，Synchronized Output 协议的开场序列
// 告诉终端："下面有一批操作，先缓存起来别急着刷新"
let buffer = BSU

for (const patch of optimizedPatches) {
  // 每个 Patch → 一段 ANSI 序列，例如：
  //   移动光标：\x1b[5;10H  （跳到第 5 行第 10 列）
  //   切换颜色：\x1b[31m    （前景色变红）
  //   写字符：  直接拼字符本身
  buffer += serializePatch(patch)
}

// ESU = End Synchronized Update，告诉终端："好了，可以一起显示了"
buffer += ESU
terminal.stdout.write(buffer)
```

> **关于 BSU/ESU**：Synchronized Output 是 DEC 定义的终端协议扩展（`DECSET 2026`）。多行更新包在 BSU/ESU 之间，终端会等收到 ESU 后才一次性刷新屏幕，避免逐行更新时的撕裂感。不是所有终端都支持（比如原生 Windows Console 就不支持），ink 会在初始化时探测。

终端收到这串字节流后，解析执行——移动光标、切换颜色、写字符——用户看到 UI 平滑更新。

### 1.7 实战：终端缩小后边框为什么残留？

在实际开发中有一个高频踩坑点：输入框用 `borderStyle: 'single'` 画了边框，终端窗口缩小后，右侧会残留多余的边框字符。

问题的根源在 **Yoga 布局（1.2） → Screen Buffer 渲染（1.3） → diff（1.5）三步的衔接**。我们用上面刚建立的概念逐环节分析：

**第一步，Yoga 重算没问题。** 终端 resize → `calculateLayout(新列数)` → 每个节点的新宽度已算对。

**第二步，渲染也没问题。** `renderNodeToOutput` 按新布局把内容写进 `backFrame.screen`，边框字符只写到新宽度以内。`backFrame` 的 damage rectangle 也只覆盖了新宽度的范围。

**第三步，diff 出了问题。** diff 对比 `frontFrame`（宽窗口时的旧 buffer）和 `backFrame`（窄窗口的新 buffer），但它只检查 damage rectangle 覆盖的区域——即新宽度以内。旧帧中**超出新宽度**的那些 cell（之前画在右边的边框字符）不在 damage 范围里，diff 判定它们"没变"，不生成清除 Patch。

结果：终端更新了新宽度内的内容，但右侧残留了旧帧的边框字符。

**解决方案：**

1. **全量复位**：resize 时把整个 screen buffer 清零。简单但有闪烁。
2. **扩展 damage rectangle**：resize 时检测新宽度 < 旧宽度，把"右侧超出区域"显式标为 damaged。下一帧 diff 会检测到残留字符并生成清除 Patch。
3. **结合 blit cache**：`renderNodeToOutput` 开始前，先把 `backFrame.screen` 中超出新宽度的列填为空格，防止 blit 从旧帧拷贝脏数据。

Fork 用了方案 2 + 3——利用已有 damage tracking 机制做最小化重绘，同时从源头杜绝脏数据。

---

## 接下来

这篇文章串起了从 `setState` 到终端屏幕的完整渲染管线。React reconciler → Yoga 布局 → Screen Buffer 绘制到 `backFrame` → 双缓冲机制 → diff 对比新旧帧 → ANSI 序列化写入终端——每一步都是必要的。1.7 节的边框问题也印证了：这个链路里任何一环对边界条件处理不周，就会在终端上产生可见的 bug。

但这条管线在性能上有明显短板：每帧创建几千个对象导致 GC 压力、未变组件被全量重绘、逐 cell 全量对比、以及清屏导致的闪烁。下一篇《性能优化四板斧：Packed Buffer、缓存与闪烁消除》会深入 fork 如何在这四个环节做极致优化。
