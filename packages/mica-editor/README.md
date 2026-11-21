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
- **粘贴 Markdown**：Notebook 识别到 Markdown 源码时先按原文插入，在可见编辑区右侧显示「识别到 Markdown：按 Markdown 渲染 / 保留原文」；长粘贴也不会把提示挤到屏幕外。
  转换只替换这一次粘贴的内容，一次撤销回到原文。粘贴记的是那段正文在文档纯文本里的位置，不是节点 key——
  Lexical 会把插入的段落与相邻段落合并、建出来的节点全部失效，所以按内容核对：文本被改动、删掉或撤销后
  提示自动消失，点击提示外或按 Esc 也可关闭，键盘聚焦提示按钮不会关闭。篇名只接收纯文本，表格单元格与只读状态仍走原有粘贴。
- Notebook 富文本对单独粘贴的 `http(s)` / `www.` 地址走明确的自动链接路径：显示文本保持原样、`www.` 自动补成 `https://`，而 Markdown 链接、已有富文本链接、代码块和多行内容不被误判。

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
- 表格行列把手按实际单元格边界分段：每行、每列各有一段浅灰把手，细边界与 2px 间隔明确区分，窄尺寸也保留所有可见分段。
  指针所在行列显示浅蓝条，选中后变成实色选择条；端头是六点拖动把手，拖动时跟随「正在移动 1 行 / 1 列」提示与落点线。
- 横向溢出的渐变由 `TableScrollShadowPlugin` 画在单元格上方，包含有底色的表头；顶部列把手使用相同的方向与宽度。
  到达左端只提示右侧，到达右端只提示左侧，中间两侧都提示，表格不溢出时不显示；覆盖层遵守正文与表格的嵌套裁切，不接收指针。
- 行/列把手的「＋ / 删除」各自是一枚独立的中性描边按钮：行的加号在左侧下边界、删除在表格上方；列的加号在顶部右边界、删除在表格左侧。按钮按行列索引作用于
  那条行列本身（`$applyTableBandAction`），不要求先挪光标；只剩一行/一列时不显示删除，整表删除仍走右键与「更多」。
- 悬停列与列的边界时画一条蓝色列线，顶端一个「＋」直接在边界插入列；最外侧边界留给行列把手与全选方块。
- 插入表格是直接插入：工具栏与 `/` 菜单都给默认 3×3、首行为标题的表（`tableInsert.ts`），不再弹尺寸选择；
  需要更多行列时再用把手上的「＋」或右键菜单加。
- 笔记富文本的新表格默认占满阅读栏，列宽仍按内容加权分配，避免短表格缩成窄块；手动设置的列宽保持不变。文件与配置页的 Markdown 短表格仍按内容收紧。
- Markdown 链接编辑保留 `./README.md`、`../docs/guide.md`、`README.md` 和 `#锚点`，不自动改成网址。
- Notebook 手输链接按语雀的 `[标题](URL)` + 空格转换（`linkShortcut.ts`），保留空格并让后续输入回到链接外；Markdown 导入导出仍用标准 transformer。
  富文本链接编辑同样原样保留 `#锚点`、`./`、`../` 和 `/` 开头的目标，不给它们补 `https://`；仅网页、邮箱、电话提供新窗口打开动作。

## Mermaid 与代码块

Notebook 富文本画布使用分区工作台排版（`runtime/src/workspace/notebook-workbench.css`）：紧凑工具栏、限宽正文、表格与图注排版及底部字数栏。首个顶层 H1 是与笔记文件名同步的固定标题，不进入正文大纲；标题可以被用户整段清空（`workspace/notebookTitle.ts` 保持标题结构与纯文本、不把旧名字填回去；清空时笔记名回落成「未命名笔记」），只有宿主显式改名才把文字写进标题块；宿主大纲通过现有身份校验消息桥接接收其余标题、当前位置和内容块元数据，并按节点 key 请求跳转；这些信息不写入正文，也不改变编辑器选区或撤销历史。宿主把与工具栏同一行的文档栏两段实测宽度经 `layout` 消息下发，工具栏据此在自己的行内让出左右两端（`--notebook-bar-inset-*`、`--notebook-bar-height`），宽度变化时重发，不在两个文档里各写一份固定留白。实际编辑区不超过 580px 时文档栏改成独立一行，不再预留两端；桥接直接读取最终 CSS 布局，避免目录与大纲同时展开时把工具挤到操作栏下。

富文本工具栏按语雀参考截图排列：圆形插入「+」、撤销/重做与清除格式、段落样式与字号、加粗/斜体/删除线/下划线与更多文字格式、文字与背景色、对齐/无序与有序列表/缩进、任务/链接/引用/分隔线，末尾保留溢出「更多」。字体、行内代码与上下标等放进文字格式菜单，标题级别统一从段落样式选择。32px 按钮、18px 原始 SVG、14px 标签与折角下拉箭头共用一套尺寸，禁用状态只变淡。清除格式、段落样式、加粗/斜体、插入与溢出入口常驻，其余由 `ResizeObserver` 按真实宽度逐组收进「更多」，窄尺寸先缩小分组间距；低优先级的更多文字格式、缩进、引用等先收，字号与常用文字格式留得更久。收起的字号、颜色与对齐在同一菜单内进入选项。

篇名始终是大号纯文本：旧标题中的 code、加粗、链接、颜色、字号和对齐缩进在同一次更新内清理，保留可见字符。篇名中的格式操作禁用，手输 Markdown 标记保持字面量，粘贴只读取纯文本并把换行合成空格；正文格式与 Markdown 快捷输入照常工作。

Notebook 粘贴代码只检查开头最多 4096 个字符，用固定关键字识别 JavaScript、Python、Go、TypeScript 和 SQL，不引入识别库或后台扫描。Markdown 围栏与 HTML 代码块的显式语言优先，未标语言的围栏在确认渲染时补全；纯代码粘贴可直接生成代码块，无语言代码块内的粘贴也会补语言，已选语言不覆盖，证据不足则保持原样。异步语法高亮合并到本次粘贴/渲染的撤销记录。

富文本正文默认 15px、1.74 行高，H1–H6 为 28/24/20/16/15/15px。`workspace/notebook-document.css` 管理正文默认样式；工具栏优先显示显式字号，再读取实际继承字号，混合选区留空。文档「样式设置」提供标宽/超宽、正文大小、行高和段距，保存在标准 Lexical root NodeState `notebookStyle` 中，可随正文撤销与保存，不覆盖文字的显式格式；未设置的文档直接采用默认值，不重写历史正文。

笔记富文本的视觉基调保持当前主题画布与无卡片、无大阴影的阅读面：工具栏普通按钮使用中性色，激活、悬停与键盘焦点保留强调色；标宽正文限宽 900px，桌面留出 48px 顶部与 48–64px 侧边留白，窄屏回落到 28px 顶部、26/20px 侧边留白。引用、代码块与表格使用中性的细边界，不改变 Markdown 模式或用户显式行内格式。

`workspace/blockEditing.ts` 只在笔记富文本主编辑器注册：普通标题/引用块首的 Enter 或 Backspace 将当前块转为正文，不插入额外空行，保留文本、链接和显式行内格式；固定一级标题不会被清除。块中/块尾分段、Shift+Enter、列表和代码块仍由各自的 Lexical 扩展处理；输入法组合态、只读和嵌套图注编辑器不触发块首转换。

富文本工具栏与 `/` 菜单的「HTML 页面」入口由 `HtmlExtension` 提供：`runtime: 'html'` 渲染 HTML/CSS，`runtime: 'react'` 使用 `function App({React, Arco, html})` 快速组合 Arco 组件；本地 HTML 文件在浏览器内读取后以内联源码写入文档，网页链接生成受限 iframe HTML 块。两者都仍由 `HtmlNode` 的 sandbox iframe 渲染，源码随 Lexical JSON 保存，块内脚本不能访问宿主 DOM、文件系统或笔记状态。

笔记文档只有 `version` 与 `editorState` 两个字段：整篇正文序列化在 `editorState` 里，讨论、评论锚点等界面状态不再写入文档。`editorState` 为空表示尚未初始化的新笔记；非空值必须是合法 JSON 且根节点是 Lexical root，损坏或带未知字段的文档按错误上报，不会被当作空文档覆盖。

顶栏「演示」按一级/二级标题和分页符分屏（仅有更小标题时按可用层级分屏），方向键、空格、PageUp/PageDown、Home/End 翻页，Esc 退出。演示复用当前编辑器与节点，仅临时切换只读和可见块，不重建正文、不清除选区或撤销历史；退出恢复原滚动位置与编辑状态，保存冻结与演示只读叠加时按各自生命周期恢复。

图片共用 `ImageComponent` 的选中框、四角缩放与浮动工具栏。宽高、描述、图注、源图、段落对齐和链接均复用现有 ImageNode / LinkNode 字段，不新增笔记存储格式。旋转与裁剪只在用户操作时通过 Canvas 生成 PNG，单次操作以同一条撤销记录提交源图和尺寸；异步完成前重新检查目标节点、源图与可编辑状态。宽高和描述使用锚定图片的小浮层，点外或 Esc 关闭；替换、裁剪和预览等需要更大空间的操作仍使用弹窗。图片链接可在同一表单中修改或移除；图注继承父编辑器的只读状态。双击可用原始大小或适应窗口预览，网络图片不能跨域处理时保留原图；GIF/SVG 经像素编辑后成为静态 PNG。

富文本下拉菜单复用 `mica-config-ui` 的 `MenuList` / `MenuItem` / `MenuSeparator` 与同一份 Arco 主题样式；运行时只保留锚点定位和 Lexical 命令执行，方向键导航由共享菜单处理，焦点离开 iframe 时收起浮层。

链接激活浮层在两种模式中共用双行卡片：上方显示省略后的地址，下方是编辑、按目标类型提供的打开和移除操作，按钮复用共享控件。普通动作使用中性色，保存使用强调色，移除使用危险色；选中态不会被普通悬停态覆盖。Markdown 工具栏、表格和拼音浮层沿用 28px 控件与 16px 图标，图片设置、公式和嵌入内容表单使用同一套 Arco 输入及主题，界面样式不写入文档。主工具栏、菜单与浮动文字工具栏共用从语雀公开资源提取的 SVG（38 枚工具图标，另有更多和大纲）；来源与对应标识见 `web/assets/yuque/README.md`。本地 mask 跟随主题字色，文字色与背景色保留原图形里的色条和当前色值预览；开发服务也观察这些资源以刷新隔离编辑器。

富文本入口只装配实际使用的编辑器：旧 Playground 分享与版本演示、实验设置、测试录制和重复表格菜单已移除；现存节点的解析与当前编辑能力继续由相应节点和扩展负责，大纲统一由宿主工作台呈现。旧源码预览的 DOM 状态检查与切换时的重复快照不再保留；正文快照采集失败会向宿主明确报告。

两种模式共用 `MermaidPreviewPlugin`：语言为 `mermaid` 的 Lexical CodeNode 默认显示紧凑图表卡片，
标出流程图、时序图等类型，沿用宿主画布、文字和边框颜色；小图不拉伸，长图限制概览高度。
点「源码」展开实际代码，下方实时预览，上方「完成」收起；Alt+F10 可从源码进入图表工具条。代码块不提供单独的「退出代码块」按钮或快捷动作。
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
产物只含一方代码、图标与主题资源。首次打开需要联网。首屏 HTML 只加载两种模式都需要的 Arco 样式，KaTeX、Excalidraw
和日期选择器的样式在对应节点真正挂载时才注入；Notebook 的表格布局 chunk 只在正文已有表格或首次插入表格后加载，
完整 emoji 元数据也只在用户开始 `:` 搜索时加载，Markdown 快捷转换使用单独的紧凑别名表。

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
