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
  的随机 token 校验通信，不授予 same-origin，也不开放宿主 API。
- **主题**：`web/theme.ts` 读宿主 `data-theme` / `data-appearance` 与 CSS 变量，经 `theme` 消息下发；
  亮暗和六套主题跟随 Mica，runtime 不维护第二套皮肤。
- **降级**：CDN 或构建产物不可用时组件退回朴素 textarea，仍能继续编辑源码，`status` 为 `fallback`。
- **保存**：文件宿主可传 `onSave`；runtime 捕获 ⌘/Ctrl+S 并先交出最新 Markdown，再调用该回调。
  自动保存的设置页不必提供回调。切换或关闭文档前仍需等待 `flush()`，完成后才能换 `documentId`。
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

Notebook 富文本画布使用分区工作台排版（`runtime/src/workspace/notebook-workbench.css`）：紧凑工具栏、限宽正文、表格与图注排版及底部字数栏。样式限定富文本画布，不改变文件或配置页 Markdown 模式的布局。宿主大纲通过现有身份校验消息桥接收标题、当前位置和内容块元数据，并按节点 key 请求跳转；这些信息不写入正文，也不改变编辑器选区或撤销历史。

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
