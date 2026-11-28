# mica-editor

隔离运行的 Lexical Markdown 编辑器：只收发 Markdown 字符串，用于文件视图的 `.md` 与配置页 Role / Skill 编辑。
宿主是 iframe，编辑器本体跑在同一份 runtime 里，第三方依赖按固定版本从 CDN 加载。

## 目录

```text
packages/mica-editor/
  index.ts            # 浏览器侧公共 API（只导出 MarkdownEditor，不引入 Lexical）
  protocol.ts         # 宿主 ⇄ runtime 的消息契约
  build.mjs           # 构建产物与宿主共用的 vite 插件 editorWebAssets()
  web/                # 宿主组件：iframe + postMessage 桥 + 主题读取
  runtime/            # 隔离页面本体（Lexical、Arco、CDN import map、测试）
    src/markdown/     # 入口：工具栏、策略、转换口径
    src/playground/   # 与 Markdown 共用的 Lexical 节点、插件、主题与控件
    src/workspace/    # 编辑器外壳的 CSS 与主题适配
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

## 编辑口径

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
  需要更多行列时再用把手上的「＋」或右键菜单加。短表格按内容收紧列宽。
- Markdown 链接编辑保留 `./README.md`、`../docs/guide.md`、`README.md` 和 `#锚点`，不自动改成网址。

## Mermaid 与代码块

语言为 `mermaid` 的 Lexical CodeNode 默认显示紧凑图表卡片，
标出流程图、时序图等类型，沿用宿主画布、文字和边框颜色；小图不拉伸，长图限制概览高度。
点「源码」展开实际代码，下方实时预览，上方「完成」收起；Alt+F10 可从源码进入图表工具条。代码块不提供单独的「退出代码块」按钮或快捷动作。
编辑中遇到临时语法错误时保留上次成功的图，并明确标注和提示错误行；首次失败则展开原始源码，CDN 失败提供重试，正文不丢失。
预览的 SVG 位于 contenteditable 之外；原 CodeNode 始终是文档数据，Markdown 导出仍为 `mermaid` 围栏。

点击图表或右上角放大入口可打开查看器，支持适应窗口、原始尺寸、缩放、拖动平移和双指缩放。
键盘方向键平移、加减号缩放、0 复位、1 原始尺寸、Esc 关闭；缩放仅在查看器内接管滚轮，不影响正文滚动。
查看器复用已清洗的 SVG，不再请求渲染；打开期间移除卡片中的 SVG 以避免重复 ID，关闭后恢复卡片与焦点。
缩放、平移、源码展开状态只属于界面，不进入 Markdown 正文。

Mermaid 与 DOMPurify 用固定版本 jsDelivr ESM 按需加载（版本见插件 `mermaid.ts`），不进入宿主或编辑器产物。
图表使用宿主主题，严格渲染并清洗 SVG，不执行图表中的点击回调或加载外部图像。复制操作复制 Mermaid 源码。

代码块语言菜单里的 Bash 与 `sh` / `shell` 共用同一份 Prism 语法：grammar 走 import map 里的
`prismjs/components/prism-bash.js`，第一次出现 bash 代码块时才加载，与其它语言一样按需拉取，
工具栏与行内语言菜单都不为它增加静态依赖。

## 构建与静态资源

宿主用 `editorWebAssets()`（`build.mjs`）产出 `/editor/` 资源：

- `apps/desktop`：renderer 构建写入 `out/renderer/editor/`，开发期按需构建到 `temp/editor-web-dev/`。
- `apps/config-web`：写入 `apps/config-web/web/dist/editor/`，由 `scripts/generate-config-web-assets.mjs`
  一并打进 `generatedStaticAssets.ts`。

第三方库不进产物：`runtime/cdn.mjs` 固定版本，页面用 import map 从 esm.sh 加载 ESM、jsDelivr 加载样式与字体；
产物只含一方代码、图标与主题资源。首次打开需要联网。首屏 HTML 只加载 Arco 样式，KaTeX 等特性样式在对应节点真正挂载时才注入，
完整 emoji 元数据只在用户开始 `:` 搜索时加载，Markdown 快捷转换使用单独的紧凑别名表。

## 开发与验证

runtime 有独立依赖，不并入 Mica 主运行时：

```sh
cd packages/mica-editor/runtime
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

主仓库的 `bun run typecheck` 覆盖 `web/` 与宿主的接线。Markdown 往返口径由
`runtime/tests/markdownDocument.test.ts` 盯住（常见写法必须原样回到磁盘）。

上游 Lexical Playground 代码保留 Meta MIT 版权头，许可证见 [LICENSE.lexical](./LICENSE.lexical)。
