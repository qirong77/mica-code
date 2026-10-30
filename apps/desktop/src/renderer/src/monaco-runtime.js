/**
 * monaco 本体（含 15 种基础语言、JSON 语言服务与两个 worker）。
 *
 * 这个模块只会经由 `monaco.js` 的 loadMonaco() 动态 import，或由同样按需加载的
 * GitDiffEditor 静态 import —— 两条路径都不在入口图里，所以启动不必解析 monaco。
 * 直接静态 import 它会把 ~4MB（压缩后）重新拖回启动路径，不要再这么做。
 *
 * 与 xterm 一样读不到 CSS 变量，主题色只能手工同步：两套主题（mica-dark / mica-light）
 * 的十六进制值分别对应 assets/app.css 的 @theme 块与 html[data-theme='light'] 覆盖块。
 * 当前用哪套由 theme.js 决定，并跟着订阅实时切换——编辑器自己不要再写死 theme。
 */
import { currentThemeName, subscribeTheme } from './theme'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution'
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution'
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution'
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution'
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution'
// JSON 不在 basic-languages 里（没有 basic-languages/json），它是独立语言服务：
// 少了这一行，`language: 'json'` 没有 tokenizer，配置页与 .json 文件会整篇单色。
import 'monaco-editor/esm/vs/language/json/monaco.contribution'

// label 是 'json' 时必须给 JSON 的 worker（语言服务：诊断/补全/格式化），
// 其余（editorWorkerService）仍走编辑器 worker。
self.MonacoEnvironment = {
  getWorker: (_moduleId, label) => (label === 'json' ? new JsonWorker() : new EditorWorker())
}

// Monaco cannot resolve CSS custom properties, so this mirrors the Darcula
// tokens from assets/app.css by hand. Keep it in sync when the palette changes.
monaco.editor.defineTheme('mica-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#2b2b2b',
    'editorGutter.background': '#2b2b2b',
    'editorLineNumber.foreground': '#606366',
    'editorLineNumber.activeForeground': '#999999',
    // JetBrains Darcula selection blue.
    'editor.selectionBackground': '#214283'
    // 这里刻意没有差分配色（diffEditor.*）：Darcula 的 #294436 / #4b2d2d 本身就压得
    // 很暗，再叠一层 30% 透明度（曾经的取值）落在 #2b2b2b 上几乎看不出左右两侧的区别，
    // 而 vs-dark 的默认值（行背景 rgba(155,185,85,.2) / rgba(255,0,0,.2)，字符背景
    // #9ccc2c33 / #ff000033）跟你用 VS Code 默认主题看到的一致，且行背景与字符背景各叠
    // 一次，「整行变了」和「行内某几个字变了」还能分出强弱，就不要在这里另配一套了。
  }
})

// 亮色主题：取值来自 app.css 的 `html[data-theme='light']` 覆盖块（白色内容面、
// neutral-bluish 前景阶梯、#4176e6 强调）。base 'vs' 自带亮色语法高亮，这里只覆盖
// 编辑器外壳（内容面/行号/选中/当前行/缩进线/悬浮与控制台/滚动条）。
monaco.editor.defineTheme('mica-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#ffffff',
    'editorLineNumber.foreground': '#979da6',
    'editorLineNumber.activeForeground': '#61666b',
    // 与 --color-accent-region（deepseek 18%）同源的选中色。
    'editor.selectionBackground': '#4176e633',
    'editor.lineHighlightBackground': '#f1f3f5',
    'editorIndentGuide.background1': '#00000014',
    'editorIndentGuide.activeBackground1': '#00000029',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#0000001a',
    'scrollbarSlider.background': '#00000029',
    'scrollbarSlider.hoverBackground': '#0000003d',
    'scrollbarSlider.activeBackground': '#00000052'
  }
})

/** theme.js 报出来的是最终主题（light/dark），这里映射到 monaco 注册的主题名。 */
function monacoThemeName(theme) {
  return theme === 'light' ? 'mica-light' : 'mica-dark'
}

// 新建的编辑器不传 theme 时取全局主题；这里在 monaco 装载完成的第一时间对齐当前主题，
// 之后每次切换（含 auto 跟随系统）都实时 setTheme，已经开着的编辑器会一起换色。
monaco.editor.setTheme(monacoThemeName(currentThemeName()))
subscribeTheme((theme) => monaco.editor.setTheme(monacoThemeName(theme)))

export { monaco }
