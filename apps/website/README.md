# Mica Code website

Astro 静态官网与使用文档。产品首页解释能力与工作方式；文档围绕安装、日常任务、扩展和集成组织。

## 本地开发

在本目录执行：

```bash
bun install
bun run dev
```

验证与预览：

```bash
bun run check
bun run format:check
bun run build
bun run preview
```

模拟 GitHub Pages 的仓库子路径：

```bash
PAGES_BASE_PATH=/mica-code bun run build
PAGES_BASE_PATH=/mica-code bun run preview
```

网站相对路径始终使用 `import.meta.env.BASE_URL`，并保留目录尾斜杠。不要在页面中写死 `/docs/` 或 `/screenshots/`。`astro.config.mjs` 会将部署传入的基础路径归一化。

## 内容与组件

| 位置 | 职责 |
| --- | --- |
| `src/pages/index.astro` | 产品首页，工作区预览、能力与评测入口 |
| `src/pages/docs/` | 使用指南；`index.astro` 为文档概览 |
| `src/content/docs.ts` | 分组、顺序、标题与摘要的唯一导航来源 |
| `src/layouts/BaseLayout.astro` | 页面元数据、全局导航、主题与复制代码 |
| `src/layouts/DocLayout.astro` | 文档侧栏、面包屑、本页目录、搜索与相邻文章 |
| `src/scripts/docs.ts` | 标题链接、目录定位、响应式导航和正文搜索 |
| `src/components/CodeBlock.astro` | 构建时语法高亮的代码块，支持深浅主题 |
| `src/styles/` | 共享颜色与字号、产品页面、文档阅读样式 |

新增指南时创建对应页面，用 `DocLayout` 并给出 `title`、`description` 和 `active`，再登记导航。文档搜索按需读取这些页面的标题、摘要与正文，无需第三方搜索服务。

代码示例使用 `CodeBlock`，例如：

```astro
---
import CodeBlock from '../../components/CodeBlock.astro';
---

<CodeBlock code={'mica exec "检查测试入口"'} lang="bash" />
```

标题尽量表达任务。重要外链锚点显式填写 `id`；其他标题在浏览器中生成稳定的章节链接。卡片标题不进入本页目录。

## 视觉与交互

默认深色主题，可通过导航栏切换浅色并保存偏好。颜色来自 `global.css` 的语义变量，不在页面里另建一套主题。

修改后检查 390px、768px、1440px 等视口：页面不应整体横向滚动；长代码与表格在自己的区域内滚动。搜索支持 `⌘/Ctrl+K`、方向键、Enter 与 Esc，预览页签支持方向键与 Home / End。保留可见焦点与减少动态效果的偏好。

## 图片与数据

- 品牌标志统一引用 `../desktop/resources/icon.svg`。
- 产品截图保存在 `public/screenshots/`，README 对应产物在根目录 `images/`；复现方法见 [demo-assets.md](../../docs/demo-assets.md)。
- 评测唯一数据源为 `public/benchmark-data.json`。运行根目录的 `bun scripts/generate-eval-chart.mjs` 更新 SVG；首页数字直接读取该 JSON。
- 架构图只编辑 `architecture/*.architecture.json`，经 Archify 生成 `public/architecture/*.html`，不手改生成文件。
- GitHub Pages 流程位于 [deploy-pages.yml](../../.github/workflows/deploy-pages.yml)，发布前应完成本地检查与预览。
