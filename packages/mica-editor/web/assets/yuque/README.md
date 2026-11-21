# 语雀界面图标来源

按用户要求，从语雀公开帮助页的实际 SVG 提取，采集日期 2026-11-21：
https://www.yuque.com/yuque/gpvawt/wbsu70

| 文件 | 原页面标识 | 使用位置 |
| --- | --- | --- |
| `more.svg` | `larkui-icon-new-ellipsis` | 笔记目录、正文与表格的更多菜单 |
| `outline.svg` | `Rightboard` / `larkui-icon-rightboard` | 笔记右侧大纲显隐 |

另外 37 枚工具栏图标提取自该公开页面所用的 `Editor*` 等图标模块，完整组件名与带哈希的原始资源 URL 见 `toolbar-sources.json`：撤销重做、清除格式、粗体斜体下划线删除线、链接和行内代码、引用分隔线、三类列表、缩进、三类对齐、正文与 H1–H6、文字色与背景色、上下标、插入、表格、图片、公式、日历与方向箭头。

提取时只解析静态 SVG 的 AST，不执行下载的 JavaScript；仅保留 SVG 图形、文字与本地图形引用。保留原始 viewBox、path、分组、遮罩和文本；移除页面类名、内联尺寸和宿主标识。使用本地 CSS mask 跟随当前主题字色，颜色按钮在原图形的色条位置叠加当前色值，不请求语雀资源，也不引入语雀脚本。

`runtime/src/playground/ui/EditorIcon.tsx` 让主工具栏和菜单共用这些图标，浮动文字工具栏也用相同资源。未找到对应原始图标的独有操作（如拼音、大小写、两端对齐）保持项目自己的图形；没有用相近含义的语雀图标替换。
