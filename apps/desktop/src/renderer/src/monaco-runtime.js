/**
 * monaco 本体（含 15 种基础语言、JSON 语言服务与两个 worker）。
 *
 * 这个模块只会经由 `monaco.js` 的 loadMonaco() 动态 import，或由同样按需加载的
 * GitDiffEditor 静态 import —— 两条路径都不在入口图里，所以启动不必解析 monaco。
 * 直接静态 import 它会把 ~4MB（压缩后）重新拖回启动路径，不要再这么做。
 *
 * 与 xterm 一样读不到 CSS 变量，主题色只能手工同步：每个主题注册一个 monaco 主题
 * （`mica-<id>`），十六进制值对应 assets/app.css 里同 id 的 `html[data-theme='<id>']` 块。
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

/*
 * Monaco 读不到 CSS 变量，所以每个主题在这里镜像一遍「编辑器外壳」那一层颜色
 * （内容面 / 行号 / 选中 / 当前行 / 缩进线 / 悬浮与控制台 / 滚动条），取值对应
 * assets/app.css 同 id 块里的 canvas / panel / line / fg 阶梯 / accent。
 *
 * 刻意不配 diffEditor.*：vs-dark 与 vs 的默认差分色（行背景 20% 的绿/红，字符背景
 * 再叠一层）在两种底色上都分得出「整行变了」与「行内某几个字变了」，另配一套反而更糊。
 */
const EDITOR_SHELLS = {
  dark: {
    base: 'vs-dark',
    canvas: '#2b2b2b',
    lineNumber: '#606366',
    lineNumberActive: '#999999',
    // JetBrains Darcula selection blue.
    selection: '#214283'
  },
  light: {
    base: 'vs',
    canvas: '#ffffff',
    lineNumber: '#979da6',
    lineNumberActive: '#61666b',
    // 与 --color-accent-region（deepseek 18%）同源的选中色。
    selection: '#4176e633',
    lineHighlight: '#f1f3f5',
    indent: '#00000014',
    indentActive: '#00000029',
    widget: '#ffffff',
    widgetBorder: '#0000001a',
    scrollbar: ['#00000029', '#0000003d', '#00000052']
  },
  mocha: {
    base: 'vs-dark',
    canvas: '#1e1e2e',
    lineNumber: '#6c7086',
    lineNumberActive: '#cba6f7',
    selection: '#585b7066',
    lineHighlight: '#ffffff12',
    indent: '#45475a',
    indentActive: '#585b70',
    widget: '#181825',
    widgetBorder: '#45475a',
    scrollbar: ['#585b7066', '#7f849c99', '#9399b2cc']
  },
  latte: {
    base: 'vs',
    canvas: '#eff1f5',
    lineNumber: '#8c8fa1',
    lineNumberActive: '#8839ef',
    selection: '#acb0be66',
    lineHighlight: '#4c4f690f',
    indent: '#ccd0da',
    indentActive: '#bcc0cc',
    widget: '#e6e9ef',
    widgetBorder: '#bcc0cc',
    scrollbar: ['#bcc0cc99', '#acb0bec4', '#9ca0b0e0']
  },
  'tokyo-night': {
    base: 'vs-dark',
    canvas: '#1a1b26',
    lineNumber: '#363b54',
    lineNumberActive: '#7aa2f7',
    selection: '#515c7e66',
    lineHighlight: '#1e202e',
    indent: '#2a2e42',
    indentActive: '#3d59a1',
    widget: '#16161e',
    widgetBorder: '#292e42',
    scrollbar: ['#868bc422', '#868bc444', '#868bc466']
  },
  'tokyo-night-light': {
    base: 'vs',
    canvas: '#e6e7ed',
    lineNumber: '#9da0ab',
    lineNumberActive: '#2959aa',
    selection: '#acb0bf66',
    lineHighlight: '#dcdee3',
    indent: '#cfd1d8',
    indentActive: '#acb0bf',
    widget: '#d6d8df',
    widgetBorder: '#c1c2c7',
    scrollbar: ['#90929633', '#90929655', '#90929677']
  }
}

for (const [id, shell] of Object.entries(EDITOR_SHELLS)) {
  // 没配的键留空，让 base（vs / vs-dark）的默认值接管——Darcula 一直就是这么来的。
  const colors = {
    'editor.background': shell.canvas,
    'editorGutter.background': shell.canvas,
    'editorLineNumber.foreground': shell.lineNumber,
    'editorLineNumber.activeForeground': shell.lineNumberActive,
    'editor.selectionBackground': shell.selection,
    'editor.lineHighlightBackground': shell.lineHighlight,
    'editorIndentGuide.background1': shell.indent,
    'editorIndentGuide.activeBackground1': shell.indentActive,
    'editorWidget.background': shell.widget,
    'editorWidget.border': shell.widgetBorder,
    'scrollbarSlider.background': shell.scrollbar?.[0],
    'scrollbarSlider.hoverBackground': shell.scrollbar?.[1],
    'scrollbarSlider.activeBackground': shell.scrollbar?.[2]
  }
  monaco.editor.defineTheme(`mica-${id}`, {
    base: shell.base,
    inherit: true,
    rules: [],
    colors: Object.fromEntries(Object.entries(colors).filter(([, value]) => value))
  })
}

/** theme.js 报出来的是最终主题 id，这里映射到 monaco 注册的主题名。 */
function monacoThemeName(theme) {
  return `mica-${theme}`
}

// 新建的编辑器不传 theme 时取全局主题；这里在 monaco 装载完成的第一时间对齐当前主题，
// 之后每次切换（含 auto 跟随系统）都实时 setTheme，已经开着的编辑器会一起换色。
monaco.editor.setTheme(monacoThemeName(currentThemeName()))
subscribeTheme((theme) => monaco.editor.setTheme(monacoThemeName(theme)))

export { monaco }
