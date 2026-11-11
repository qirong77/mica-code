# Notebook 界面设计预览

共保留 A–E 五种 Notebook 布局，使用同一份真实共享 Lexical runtime、同一套 Mica / Arco 控件和主题令牌。本轮以 C · 工作台为基准，新增 D · 分区工作台与 E · 一体工作台；默认打开 C，顶部主要切换 C / D / E。五版的示例内容完全一致，均可真实编辑。这是独立设计预览，不会自动替换正式 Notebook。

| 本轮方案           | 相对 C 的侧重                                                                         | 地址                     |
| ------------------ | ------------------------------------------------------------------------------------- | ------------------------ |
| C · 工作台（基准） | 紧凑间距，目录 / 正文 / 可收起大纲三栏                                                | `/?design=c&theme=light` |
| D · 分区工作台     | 保留 C 的三栏导航；轻灰底、间距与圆角分区、正文轻卡片、可操作的最近阅读页签、编号大纲 | `/?design=d&theme=light` |
| E · 一体工作台     | 保留 C 的三栏导航；一体画布、少边框、纤细侧栏与大纲、轻量工具栏、开阔正文             | `/?design=e&theme=light` |

A · 清透与 B · 书页仍可通过原地址 `/?design=a&theme=light`、`/?design=b&theme=light` 访问。对比页将它们收在底部“上一轮方案”，主卡片展示 C / D / E。

## 启动

```sh
cd apps/desktop
npx vite --config .probe/notebook-design/vite.config.mjs
```

预览：`http://127.0.0.1:5286/`，本轮对比：`http://127.0.0.1:5286/comparison.html`。
显式打开 C：`http://127.0.0.1:5286/?design=c&theme=light`。深色可将 `theme` 改为 `dark` 或 `tokyo-night`，五版仍支持现有六套主题。
项目与编辑器 runtime 的既有开发依赖需要已安装；首次访问隔离编辑器时，构建只输出到仓库的 `temp/notebook-design-runtime/`，第三方仍通过现有固定版本 CDN 加载。不会构建或覆盖已安装应用。

## 内容与交互

五篇构造示例：约 2,000 个中文字的产品设计手记，另有周计划、研发决策、阅读摘录与格式巡检。覆盖标题、各种行内格式、链接、嵌套有序 / 无序列表、任务、表格、TypeScript、Mermaid 流程图与时序图、引用、分割线、原创图片说明、行内与块级公式。

支持真实编辑、表格操作、Mermaid 查看 / 源码编辑、撤销重做，以及方案 / 六套主题切换、目录折叠、笔记搜索、收藏筛选、文档切换、新建预览笔记、大纲跳转、格式跳转、专注布局、JSON 下载和示例还原。切换方案不重挂载编辑器，切换笔记先走真实 `flush`。

D / E 均继承 C 的目录树导航与可收起的大纲。D 用分区间距、圆角和正文轻卡片区分目录、编辑区与大纲，提供可操作的最近阅读页签与编号大纲；E 用更窄的侧栏和大纲、更轻的工具栏与更少的边框，把空间留给连续正文。比较时可在同一篇笔记内切换 C / D / E，内容与编辑能力一致。

数据仅在当前页面的内存中，刷新恢复初始示例；没有真实宿主 API、本地笔记路径或写盘接口。`fixture.ts` 内嵌原创 SVG，原稿在 `assets/`。

## 对比页图片

对比页沿用现有结构与配色，顶部三张主卡片展示同一份示例在 1440×960 的真实截图，细节区展示 D 的表格与 E 的 Mermaid；深色与手机截图以链接提供，避免拉长页面。

| 图片                                       | 用途                            |
| ------------------------------------------ | ------------------------------- |
| `preview-c.png`                            | 本轮基准 C 的浅色全景           |
| `preview-d.png`、`preview-e.png`           | D / E 的浅色全景，与 C 并排比较 |
| `detail-d-table.png`                       | D 正文轻卡片中的表格细节        |
| `detail-e-mermaid.png`                     | E 连续正文中的 Mermaid 细节     |
| `preview-d-dark.png`、`preview-e-dark.png` | D / E 深色截图链接              |
| `mobile-d.png`、`mobile-e.png`             | D / E 手机窄屏截图链接          |

上一轮的 `preview-a.png`、`preview-b.png`、`preview-c-dark.png` 与 `mobile-{a,b,c}.png` 继续保留作参考。

## 边界与复核

- 宿主采用共享 `ArcoProvider` / `Button` / `Input` / `SelectMenu` / `Modal`，主题采用实际 `app.css` 和 `applyResolvedTheme()`。
- iframe 保持生产 sandbox。预览服务只给自己的 `/editor/index.html` 注入 `editor-preview.css`、`variants-editor.css`、经过 parent + token 校验的 `design-bridge.js`；不改正式 runtime。
- 限宽正文、表格间距、图片自适应和五种排版在预览 CSS；大纲、最近阅读页签和跳转也是预览辅助代码。
- `window.__notebookPreview.state` 提供当前布局 / 加载状态；`snapshot()` 调用真实 bridge 获取正文；`measure()` 请求 iframe 尺寸。仅用于复核，不暴露宿主。
- 本轮仅扩展独立预览中的布局、对比入口与图片，不引入新依赖，不接入用户数据。

确认设计后，再把选定的布局和样式整合回正式 Notebook。
