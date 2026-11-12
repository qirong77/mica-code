# mica-editor

共享的 Lexical 编辑器。两种模式共用同一份 runtime、同一份 CDN 依赖与同一套主题适配，数据契约各自独立：

| 模式 | 入口 | 文档格式 | 谁在用 |
| --- | --- | --- | --- |
| 富文本 | `/editor/index.html` | Lexical JSON | `plugins/notebook`（笔记正文） |
| Markdown | `/editor/index.html?mode=markdown` | Markdown 字符串 | 文件视图 `.md`、配置页 Role / Skill 编辑 |

## 目录

```text
packages/mica-editor/
  index.ts            # 浏览器侧公共 API（只导出 MarkdownEditor，不引入 Lexical）
  protocol.ts         # Markdown 模式的宿主 ⇄ runtime 消息契约
  build.mjs           # 构建产物与两个宿主共用的 vite 插件 editorWebAssets()
  web/                # 宿主组件：iframe + postMessage 桥 + 主题读取
  runtime/            # 隔离页面本体（Lexical、Arco、CDN import map、测试）
    src/playground/   # 富文本模式：官方 Playground 节点与插件
    src/markdown/     # Markdown 模式：工具栏、策略、转换口径
```

## 宿主怎么用

```tsx
const ref = useRef<MarkdownEditorHandle>(null);
<MarkdownEditor ref={ref} documentId={role.name} value={content} onChange={setContent} readOnly={!editable} />;
await ref.current?.flush(); // 切换条目/离开页面前把最后一批输入交出来
```

`MarkdownEditor` 只收发 Markdown 字符串：`value` 进、`onChange` 出，中间没有任何 Lexical 结构穿过宿主。
宿主侧不 import Lexical，避免把编辑器依赖拖进主 React 图。

- **隔离**：runtime 跑在 `sandbox="allow-scripts allow-popups"` 的 iframe 里，宿主通过 `window.postMessage`
  的来源窗口和随机 token 校验通信，不授予 same-origin，也不开放宿主 API。每次加载有独立请求身份，
  同一文档重载前的旧正文与保存快捷键消息不会写入新编辑器；切换时未完成的 flush 会明确失败。
- **主题**：`web/theme.ts` 读宿主 `data-theme` / `data-appearance` 与 CSS 变量，经 `theme` 消息下发；
  亮暗和六套主题跟随 Mica，runtime 不维护第二套皮肤。
- **降级**：CDN 或构建产物不可用时组件退回朴素 textarea，仍能继续编辑源码，`status` 为 `fallback`。
- **保存**：文件宿主可传 `onSave`；runtime 捕获 ⌘/Ctrl+S 并先交出最新 Markdown，再调用该回调。
  自动保存的设置页不必提供回调。切换或关闭文档前仍需等待 `flush()`，完成后才能换 `documentId`。
  若 `onChange` 在收集最后输入时同步切换文档，旧 `flush()` 会拒绝，避免调用方把新文档内容保存到旧文件。
- **尺寸**：宿主提供确定高度和 `min-height: 0` 的容器，组件与 runtime 填满剩余区域；源码和排版只滚正文，工具栏与字数栏固定。

## Markdown 模式的取舍

- 打开文档先过 `src/markdown/markdownPolicy.ts`：frontmatter、HTML、引用式链接、脚注、图片、公式、复杂表格等
  无法无损表达的写法默认留在**源码模式**，保证「看一眼不会改坏 prompt」。标题、列表、表格、代码块可排版编辑。
- 引用（`>`）按 GFM 当**块容器**解析：引用里的列表、代码块、表格和嵌套引用都是真正的节点，
  单独一个 `>` 是引用内部的空行。`src/markdown/transformers.ts` 里的 `MARKDOWN_QUOTE` 负责整块
  导入与逐行加 `>` 导出，往返原样；因此「引用里套列表」的文档也直接可编辑，不再整篇降到源码。
- 文本进出只有一条路径：`src/markdown/markdownDocument.ts` 的 `$importMarkdown` / `$exportMarkdown`。
  转换不保留 Markdown 空行（否则空行会变成空段落、排版撑成双倍行距），导出时由块分隔补回，
  并沿用文件原本的收尾换行；只有连续多行空行会收敛成一个空行。
- 源码模式是权威：在源码里改的内容原样回传，不经过富文本往返。
- 查看源码后直接返回排版，不重新导入文档，也不清除撤销、选区和手动表格列宽；源码有修改才重新解析。
  源码区的 Tab / Shift+Tab 支持缩进及取消缩进，使用浏览器文本事务以保留撤销。
- GFM 表格按内容和可用区域分配初始列宽，行距紧凑；支持拖动行高、列宽，宽表格在表格内部横向滚动。
  手动列宽只属于本次编辑状态，不写入标准 Markdown；重新打开后会按内容重新计算。
- Markdown 链接编辑保留 `./README.md`、`../docs/guide.md`、`README.md` 和 `#锚点`，不自动改成网址。

## Mermaid 与代码块

Notebook 富文本画布使用分区工作台排版（`runtime/src/workspace/notebook-workbench.css`）：紧凑工具栏、限宽正文、表格与图注排版及底部字数栏。样式限定富文本画布，不改变文件或配置页 Markdown 模式的布局。宿主大纲通过现有身份校验消息桥接收标题、当前位置和内容块元数据，并按节点 key 请求跳转；这些信息不写入正文，也不改变编辑器选区或撤销历史。宿主把与工具栏同一行的文档栏两段实测宽度经 `layout` 消息下发，工具栏据此在自己的行内让出左右两端（`--notebook-bar-inset-*`、`--notebook-bar-height`），宽度变化时重发，不在两个文档里各写一份固定留白。

富文本工具栏按插入、编辑历史与清除格式、字体与段落、文字格式、颜色、段落结构及快捷插入分组，始终保持一行。`ResizeObserver` 按工具栏实际内容宽度与控件实测宽度决定展开哪些组：窗口及两侧面板改变大小时，低优先级操作收进「更多」，空间恢复时自动展开。收起的字体、字号、颜色和对齐在同一菜单内进入对应选项，不叠加第二层弹窗。

富文本正文默认 15px、1.74 行高，H1–H6 为 28/24/20/16/15/15px。`workspace/notebook-document.css` 管理正文默认样式；工具栏优先显示显式字号，再读取实际继承字号，混合选区留空。文档「样式设置」提供标宽/超宽、正文大小、行高和段距，保存在标准 Lexical root NodeState `notebookStyle` 中，可随正文撤销与保存，不覆盖文字的显式格式；未设置的文档直接采用默认值，不重写历史正文。

`workspace/blockEditing.ts` 只在笔记富文本主编辑器注册：标题/引用块首的 Enter 或 Backspace 将当前块转为正文，不插入额外空行，保留文本、链接和显式行内格式。块中/块尾分段、Shift+Enter、列表与代码块仍由各自的 Lexical 扩展处理；输入法组合态、只读和嵌套图注编辑器不触发块首转换。

笔记文档只有 `version` 与 `editorState` 两个字段：整篇正文序列化在 `editorState` 里，讨论、评论锚点等界面状态不再写入文档。`editorState` 为空表示尚未初始化的新笔记；非空值必须是合法 JSON 且根节点是 Lexical root，损坏或带未知字段的文档按错误上报，不会被当作空文档覆盖。

顶栏「演示」按一级/二级标题和分页符分屏（仅有更小标题时按可用层级分屏），方向键、空格、PageUp/PageDown、Home/End 翻页，Esc 退出。演示复用当前编辑器与节点，仅临时切换只读和可见块，不重建正文、不清除选区或撤销历史；退出恢复原滚动位置与编辑状态，保存冻结与演示只读叠加时按各自生命周期恢复。

图片共用 `ImageComponent` 的选中框、四角缩放与浮动工具栏。宽高、描述、图注、源图、段落对齐和链接均复用现有 ImageNode / LinkNode 字段，不新增笔记存储格式。旋转与裁剪只在用户操作时通过 Canvas 生成 PNG，单次操作以同一条撤销记录提交源图和尺寸；异步完成前重新检查目标节点、源图与可编辑状态。宽高和描述使用锚定图片的小浮层，点外或 Esc 关闭；替换、裁剪和预览等需要更大空间的操作仍使用弹窗。图片链接可在同一表单中修改或移除；图注继承父编辑器的只读状态。双击可用原始大小或适应窗口预览，网络图片不能跨域处理时保留原图；GIF/SVG 经像素编辑后成为静态 PNG。

富文本下拉菜单复用 `mica-config-ui` 的 `MenuList` / `MenuItem` / `MenuSeparator` 与同一份 Arco 主题样式；运行时只保留锚点定位和 Lexical 命令执行，方向键导航由共享菜单处理，焦点离开 iframe 时收起浮层。

富文本入口只装配实际使用的编辑器：旧 Playground 分享与版本演示、实验设置、测试录制和重复表格菜单已移除；现存节点的解析与当前编辑能力继续由相应节点和扩展负责，大纲统一由宿主工作台呈现。旧源码预览的 DOM 状态检查与切换时的重复快照不再保留；正文快照采集失败会向宿主明确报告。

两种模式共用 `MermaidPreviewPlugin`：语言为 `mermaid` 的 Lexical CodeNode 默认显示紧凑图表卡片，
标出流程图、时序图等类型，沿用宿主画布、文字和边框颜色；小图不拉伸，长图限制概览高度。
点「源码」展开实际代码，下方实时预览，上方「完成」收起；Alt+F10 可从源码进入图表工具条，⌘/Ctrl+Enter 退出代码块继续正文。
编辑中遇到临时语法错误时保留上次成功的图，并明确标注和提示错误行；首次失败则展开原始源码，CDN 失败提供重试，正文不丢失。
预览的 SVG 位于 contenteditable 之外；原 CodeNode 始终是文档数据，Markdown 导出仍为 `mermaid` 围栏，富文本仍为代码节点。

点击图表或右上角放大入口可打开查看器，支持适应窗口、原始尺寸、缩放、拖动平移和双指缩放。
键盘方向键平移、加减号缩放、0 复位、1 原始尺寸、Esc 关闭；缩放仅在查看器内接管滚轮，不影响正文滚动。
查看器复用已清洗的 SVG，不再请求渲染；打开期间移除卡片中的 SVG 以避免重复 ID，关闭后恢复卡片与焦点。
缩放、平移、源码展开状态只属于界面，不进入 Markdown / Lexical 正文。

Mermaid 与 DOMPurify 用固定版本 jsDelivr ESM 按需加载（版本见插件 `mermaid.ts`），不进入宿主或编辑器产物。
图表使用宿主主题，严格渲染并清洗 SVG，不执行图表中的点击回调或加载外部图像。复制操作复制 Mermaid 源码。

## 构建与静态资源

两个宿主都用 `editorWebAssets()`（`build.mjs`）产出同一份 `/editor/` 资源：

- `apps/desktop`：renderer 构建写入 `out/renderer/editor/`，开发期按需构建到 `temp/editor-web-dev/`。
- `apps/config-web`：写入 `apps/config-web/web/dist/editor/`，由 `scripts/generate-config-web-assets.mjs`
  一并打进 `generatedStaticAssets.ts`。

第三方库不进产物：`runtime/cdn.mjs` 固定版本，页面用 import map 从 esm.sh 加载 ESM、jsDelivr 加载样式与字体；
产物只含一方代码、图标与主题资源。首次打开需要联网。

## 开发与验证

runtime 有独立依赖，不并入 Mica 主运行时：

```sh
cd packages/mica-editor/runtime
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

主仓库的 `bun run typecheck` 覆盖 `web/` 与两个宿主的接线，`packages/mica-editor/web/bridge.test.ts` 覆盖宿主桥。
Markdown 往返口径由 `runtime/tests/markdownDocument.test.ts` 盯住（常见写法必须原样回到磁盘）。

上游 Playground 代码保留 Meta MIT 版权头，许可证见 `plugins/notebook/LICENSE.lexical`。
