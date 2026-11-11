import { readFileSync } from 'node:fs'

export const LEXICAL_VERSION = '0.53.0'
const exports = JSON.parse(readFileSync(new URL('./lexical-exports.json', import.meta.url), 'utf8'))
const esm = (name, version, sub = '', external = 'react,react-dom') =>
  `https://esm.sh/${name}@${version}${sub}?target=es2022&bundle&external=${external}`

/**
 * Lexical 的 extension/context 都有单例身份；精确映射每个导出，并将 .js 别名归一。
 * external=* 保留这些包间的裸导入，由同一张表解析，禁止 CDN 各自内联出第二份 core。
 */
export const cdnImports = {}
for (const [name, entries] of Object.entries(exports)) {
  for (const entry of entries) {
    const sub = entry === '.' ? '' : entry.slice(1).replace(/\.js$/, '')
    cdnImports[name + (entry === '.' ? '' : entry.slice(1))] =
      `https://esm.sh/${name}@${LEXICAL_VERSION}${sub}?target=es2022&external=*`
  }
}
Object.assign(cdnImports, {
  react: esm('react', '19.2.5', '', '*'),
  'react/jsx-runtime': esm('react', '19.2.5', '/jsx-runtime', 'react'),
  'react/jsx-dev-runtime': esm('react', '19.2.5', '/jsx-dev-runtime', 'react'),
  'react-dom': esm('react-dom', '19.2.5'),
  'react-dom/client': esm('react-dom', '19.2.5', '/client'),
  'lucide-react': esm('lucide-react', '0.542.0'),
  '@arco-design/web-react': esm('@arco-design/web-react', '2.66.18'),
  '@arco-design/web-react/icon': esm('@arco-design/web-react', '2.66.18', '/icon'),
  '@arco-design/web-react/es/locale/zh-CN': esm('@arco-design/web-react', '2.66.18', '/es/locale/zh-CN'),
  '@arco-design/web-react/es/_util/react-19-adapter': esm('@arco-design/web-react', '2.66.18', '/es/_util/react-19-adapter'),
  '@preact/signals-core': esm('@preact/signals-core', '1.14.4', '', '*'),
  '@floating-ui/react': esm('@floating-ui/react', '0.27.19'),
  '@atlaskit/drag-and-drop-indicator/box': esm('@atlaskit/drag-and-drop-indicator', '0.11.1', '/box'),
  '@atlaskit/pragmatic-drag-and-drop/element/adapter': esm('@atlaskit/pragmatic-drag-and-drop', '1.7.7', '/element/adapter'),
  // 使用上游原生 ESM，避开转换服务对其分片依赖的错误重写。
  '@excalidraw/excalidraw': 'https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.1/dist/prod/index.js',
  'date-fns': esm('date-fns', '4.4.0'),
  'react-day-picker': esm('react-day-picker', '9.14.0'),
  katex: esm('katex', '0.16.10'),
  'lodash-es': esm('lodash-es', '4.18.1'),
  prettier: esm('prettier', '3.6.2'),
  'prettier/standalone': esm('prettier', '3.6.2', '/standalone'),
  yjs: esm('yjs', '13.6.31'),
  'y-websocket': esm('y-websocket', '2.1.0', '', 'yjs'),
  '@shikijs/core': esm('@shikijs/core', '4.4.3'),
  '@shikijs/engine-javascript': esm('@shikijs/engine-javascript', '4.4.3'),
  'shiki/langs': esm('shiki', '4.4.3', '/langs'),
  'shiki/themes': esm('shiki', '4.4.3', '/themes'),
  prismjs: esm('prismjs', '1.30.0'),
  'lib0/': 'https://esm.sh/lib0@0.2.114/'
})
const drawingImports = JSON.parse(readFileSync(new URL('./excalidraw-imports.json', import.meta.url), 'utf8'))
for (const [specifier, entry] of Object.entries(drawingImports)) {
  cdnImports[specifier] = esm(entry.package, entry.version, entry.subpath, 'react,react-dom,jotai')
}
cdnImports['jotai/vanilla'] = esm('jotai', '2.11.0', '/vanilla', 'react,react-dom,jotai')
cdnImports['jotai/react'] = esm('jotai', '2.11.0', '/react', 'react,react-dom,jotai')
cdnImports['jotai/react/utils'] = esm('jotai', '2.11.0', '/react/utils', 'react,react-dom,jotai')
cdnImports['jotai/utils'] = esm('jotai', '2.11.0', '/utils', 'react,react-dom,jotai')
cdnImports['jotai/vanilla/utils'] = esm('jotai', '2.11.0', '/vanilla/utils', 'react,react-dom,jotai')
for (const name of ['babel', 'html', 'markdown', 'postcss', 'typescript']) {
  cdnImports[`prettier/parser-${name}`] = esm('prettier', '3.6.2', `/plugins/${name}`)
}
cdnImports['prettier/plugins/estree'] = esm('prettier', '3.6.2', '/plugins/estree')
for (const name of ['c', 'clike', 'cpp', 'css', 'java', 'javascript', 'markdown', 'markup', 'objectivec', 'powershell', 'python', 'rust', 'sql', 'swift', 'typescript']) {
  cdnImports[`prismjs/components/prism-${name}.js`] = esm('prismjs', '1.30.0', `/components/prism-${name}.js`)
}

export const cdnStyles = [
  'https://cdn.jsdelivr.net/npm/@arco-design/web-react@2.66.18/dist/css/arco.css',
  'https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.css',
  'https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.1/dist/prod/index.css',
  'https://cdn.jsdelivr.net/npm/react-day-picker@9.14.0/src/style.css'
]
