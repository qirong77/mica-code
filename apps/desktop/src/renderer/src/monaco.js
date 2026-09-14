/**
 * 编辑器的纯逻辑与按需装载入口。
 *
 * 这里**不**静态 import monaco：monaco 压缩后仍有约 4MB，而它只在用户真正打开
 * 文件（或 Git diff）时才需要。启动路径只用到 fileName / languageFor / editorOptions，
 * 这些都不依赖 monaco 本体，所以把它们和 `loadMonaco()` 放在同一个模块是安全的。
 */

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

export const editorOptions = {
  theme: 'mica-dark',
  automaticLayout: true,
  minimap: { enabled: false },
  // Scrollbars are hidden app-wide (see assets/app.css); Monaco paints its own
  // DOM scrollbars, so it needs the option instead of the CSS rule.
  scrollbar: { vertical: 'hidden', horizontal: 'hidden' },
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

let pending = null

/** 按需加载 monaco 本体；重复调用共享同一次装载（含 worker 与 15 种基础语言）。 */
export function loadMonaco() {
  if (!pending) pending = import('./monaco-runtime').then((module) => module.monaco)
  return pending
}
