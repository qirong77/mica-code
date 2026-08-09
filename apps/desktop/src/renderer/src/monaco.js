import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
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

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

const languages = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  css: 'css',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml'
}

monaco.editor.defineTheme('mica-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0e0e0e',
    'editorGutter.background': '#0e0e0e',
    'editorLineNumber.foreground': '#555555',
    'editorLineNumber.activeForeground': '#a0a0a0',
    'editor.selectionBackground': '#4a4a4a80',
    'diffEditor.insertedTextBackground': '#1f6b403f',
    'diffEditor.removedTextBackground': '#9b33413f',
    'diffEditor.insertedLineBackground': '#183d2b66',
    'diffEditor.removedLineBackground': '#49242a66'
  }
})

export const editorOptions = {
  theme: 'mica-dark',
  automaticLayout: true,
  minimap: { enabled: false },
  fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
  fontSize: 12,
  lineHeight: 20,
  scrollBeyondLastLine: false,
  renderOverviewRuler: false,
  stickyScroll: { enabled: false },
  padding: { top: 8 }
}

export function fileName(path) {
  return String(path).split(/[\\/]/).filter(Boolean).at(-1) || String(path)
}

export function languageFor(path) {
  const name = fileName(path)
  const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : ''
  return languages[extension] || 'plaintext'
}

export { monaco }
