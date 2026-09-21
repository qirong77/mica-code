/**
 * monaco 本体（含 15 种基础语言、JSON 语言服务与两个 worker）。
 *
 * 这个模块只会经由 `monaco.js` 的 loadMonaco() 动态 import，或由同样按需加载的
 * GitDiffEditor 静态 import —— 两条路径都不在入口图里，所以启动不必解析 monaco。
 * 直接静态 import 它会把 ~4MB（压缩后）重新拖回启动路径，不要再这么做。
 *
 * 与 xterm 一样读不到 CSS 变量，主题色只能手工同步：同一组十六进制值见
 * assets/app.css 的 @theme 块与 apps/config-web/web/src/styles.css 的 :root。
 */
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
    'editor.selectionBackground': '#214283',
    'diffEditor.insertedTextBackground': '#2944364f',
    'diffEditor.removedTextBackground': '#4b2d2d4f',
    'diffEditor.insertedLineBackground': '#2944364d',
    'diffEditor.removedLineBackground': '#4b2d2d4d'
  }
})

export { monaco }
