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

### 1.4 对比新旧两帧，找出真正变了的部分

拿到当前帧的 Screen Buffer 后，和上一帧做逐 cell 对比：

```typescript
diffEach(prev.screen, next.screen, (x, y, removed, added) => {
  // 对每个变化的 cell，生成一个操作指令（Patch）
  // Patch 类型：移动光标到 (x,y)、切换样式、写一个字符、清除区域...
})
```

结果是一个 `Patch[]` 数组——只包含"真正变了"的 cell，不是全部 cell。

### 1.5 把操作指令序列化成 ANSI 字节流，写入终端

`Patch[]` 还不能直接送进终端。先做一轮合并优化（两个连续的"移动光标"合成一个），然后序列化成 ANSI 转义序列字符串，写入 `stdout`：

```typescript
let buffer = BSU   // 告诉终端："先别急着显示，后面还有"
for (const patch of optimized) {
  buffer += serializePatch(patch)  // 每个 Patch → 一段 ANSI 序列
}
buffer += ESU      // "好了，现在一起显示出来"
terminal.stdout.write(buffer)
```

终端收到这串字节流后，解析执行——移动光标到指定位置、切换颜色、写字符——屏幕上的 UI 就更新了。

### 1.6 双缓冲：画和看分开

最后一步，交换前后帧：

```typescript
this.backFrame = this.frontFrame    // 把"当前正在显示的"存起来
this.frontFrame = frame             // 把"刚画好的"设为当前帧
```

- `frontFrame`：当前显示在屏幕上的那一帧。下一轮 diff 时用它做参考。
- `backFrame`：备用 buffer。下一帧渲染前先用 `resetScreen()` 清零，然后承载新的渲染结果，画完后 swap 变成 frontFrame。

这种"画完再换"的策略叫做双缓冲。如果直接在屏幕上画（一边擦一边写），用户会看到画面中间状态——这就是闪烁的来源之一。

### 1.7 实战问题：终端缩小后边框为什么不自适应？

在实际开发中有一个高频踩坑点：输入框用 `borderStyle: 'single'` 画了边框，终端窗口缩小后，边框不会自适应缩窄——右侧会残留多余的边框字符。

这个问题的根源在 **Yoga 布局重算（1.2）→ Screen Buffer 渲染（1.3）→ diff（1.4）三步的衔接断层**：

**第一步，Yoga 重算布局没问题。** 终端 resize 触发 `calculateLayout(新列数)`，Yoga 正确算出了新宽度下每个节点的位置和尺寸。边框组件的新宽度是对的。

**第二步，渲染也没问题。** `renderNodeToOutput` 按新布局把内容写进 `backFrame` 的 screen buffer，边框字符只写到新宽度以内。

**第三步，diff 出了问题。** diff 对比 `frontFrame`（旧帧，宽窗口时的 buffer）和 `backFrame`（新帧，窄窗口的 buffer）。但 damage rectangle 只覆盖了 `backFrame` 中被写入的区域——也就是新宽度以内。旧帧中**超出新宽度**的那些 cell——包括之前画在右边的边框字符——不在 damage 范围内，diff 判断它们"没变化"，不清除。

结果：终端只更新了新宽度内的内容，右侧残留了旧帧的边框字符。用户看到边框"延伸出去了"。

**解决方案：**

1. **全量复位**：resize 时调用 `resetScreen()` 把整个 buffer 清零。简单但有闪烁。
2. **扩展 damage**：resize 时检测新宽度 < 旧宽度，把"右侧超出区域"显式标为 damaged。下一帧 diff 会检测到残留字符并发送清除序列。
3. **结合 blit cache**：在 `renderNodeToOutput` 开始前，先把 `backFrame` 中超出新宽度的列填充为空格，确保后续 blit 操作不会从旧帧拷贝脏数据。

Fork 选择了方案 2 和 3 的组合——利用已有的 damage tracking 机制最小化重绘，同时保证不残留脏数据。理解了从布局到 diff 的完整链路，这类边界问题就可以在正确的环节被拦截。

---

## 接下来

这篇文章串起了从 `setState` 到终端屏幕的完整渲染管线。从 React reconciler 到 Yoga 布局，再到 Screen Buffer 绘制、diff、ANSI 序列化，最后通过双缓冲输出——每一步都是必要的。1.7 节的边框问题也印证了：这个链路里任何一环对边界条件处理不周，就会在终端上产生可见的 bug。

但这条管线在性能上有明显短板：每帧创建几千个对象导致 GC 压力、未变组件被全量重绘、逐 cell 全量对比、以及清屏导致的闪烁。下一篇《性能优化四板斧：Packed Buffer、缓存与闪烁消除》会深入 fork 如何在这四个环节做极致优化。
