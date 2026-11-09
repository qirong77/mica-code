import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { build } from 'vite'

const designName = process.argv[2] || 'stats-design'
if (!['stats-design', 'digest-design'].includes(designName)) {
  throw new Error('Choose stats-design or digest-design.')
}
const designDir = resolve(import.meta.dirname, '..', designName)
const entry = resolve(designDir, 'index.html')
const destination = resolve(designDir, 'preview.html')

function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(
      ([, name, doubleQuoted, singleQuoted, bare]) => [
        name.toLowerCase(),
        doubleQuoted ?? singleQuoted ?? bare,
      ],
    ),
  )
}

function readBody(html) {
  if (/<style\b/i.test(html)) {
    throw new Error('Import probe styles through CSS files instead of inline source HTML styles.')
  }
  let entries = 0
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (tag) => {
      const { src, type } = attributes(tag.slice(0, tag.indexOf('>') + 1))
      if (type !== 'module' || !/^(?:\.?\/)?main\.jsx$/.test(src ?? '')) {
        throw new Error('Only the main.jsx module entry is supported in the probe HTML.')
      }
      entries += 1
      return ''
    })
    .replace(/<link\b[^>]*>/gi, (tag) => {
      if (attributes(tag).rel?.toLowerCase() !== 'stylesheet') {
        throw new Error(`Cannot discard a non-stylesheet resource: ${tag}`)
      }
      return ''
    })
  const body = stripped.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1]?.trim()
  if (entries !== 1 || !body || !/\bid\s*=\s*(["'])root\1/i.test(body)) {
    throw new Error('Expected one main.jsx module entry and a body containing #root.')
  }
  if (/<(?:script|link|iframe|object|embed)\b/i.test(body)) {
    throw new Error('Unsupported embedded resource in the probe body.')
  }
  for (const [, tag] of body.matchAll(/<([a-z][^>]*)>/gi)) {
    for (const [name, value] of Object.entries(attributes(tag))) {
      if (['src', 'srcset', 'href', 'poster', 'data'].includes(name) && !/^(?:data:|#)/i.test(value)) {
        throw new Error(`The probe body contains a non-inline resource: ${name}=${value}`)
      }
    }
  }
  return body
}

function validateCss(css) {
  if (/@import\b/i.test(css)) {
    throw new Error('The exported CSS still contains an @import.')
  }
  for (const match of css.matchAll(/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const url = (match[1] ?? match[2] ?? match[3]).trim()
    if (!/^(?:data:|#)/i.test(url)) {
      throw new Error(`The exported CSS still references a non-inline resource: ${url}`)
    }
  }
}

function validateBuiltHtml(assets, chunk) {
  const asset = assets.find((item) => item.fileName === 'index.html')
  if (!asset) throw new Error('Vite did not emit the probe HTML.')
  const html = typeof asset.source === 'string' ? asset.source : Buffer.from(asset.source).toString('utf8')
  const cssFiles = new Set(assets.filter((item) => item.fileName.endsWith('.css')).map((item) => item.fileName))
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const { src, href, rel } = attributes(tag)
    const file = (src ?? href ?? '').replace(/^\.\//, '')
    if ((src && file === chunk.fileName) || (rel === 'stylesheet' && cssFiles.has(file))) continue
    throw new Error(`The built HTML references an unsupported resource: ${tag}`)
  }
}

function inlineScript(code) {
  return code
    .replace(/<\/script/gi, (match) => `<\\/${match.slice(2)}`)
    .replace(/<!--/g, '\\x3c!--')
    .replace(/<script/gi, (match) => `\\x3c${match.slice(1)}`)
}

async function main() {
  const sourceHtml = await readFile(entry, 'utf8')
  const body = readBody(sourceHtml)
  const bodyClass = attributes(sourceHtml.match(/<body\b[^>]*>/i)?.[0] || '').class || ''
  const result = await build({
    configFile: resolve(designDir, 'vite.config.mjs'),
    configLoader: 'runner',
    root: designDir,
    base: './',
    publicDir: false,
    plugins: [{
      name: 'probe:inline-explicit-assets',
      enforce: 'pre',
      transform(code, id) {
        if (id.includes('node_modules') || !code.includes('?url&no-inline')) return null
        return code.replaceAll('?url&no-inline', '?inline')
      },
    }],
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      cssCodeSplit: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      modulePreload: false,
      sourcemap: false,
      manifest: false,
      ssrManifest: false,
      watch: null,
      rollupOptions: {
        input: entry,
        external: [],
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  })
  if (Array.isArray(result) || !result?.output) {
    throw new Error('Expected a single in-memory Vite output, not a watcher or multiple builds.')
  }
  const chunks = result.output.filter((item) => item.type === 'chunk')
  if (chunks.length !== 1 || !chunks[0].isEntry) {
    throw new Error(`Expected exactly one entry chunk; received ${chunks.length} chunks.`)
  }
  const chunk = chunks[0]
  if (chunk.imports.length || chunk.dynamicImports.length || chunk.implicitlyLoadedBefore?.length) {
    throw new Error(`The JavaScript chunk still imports other modules: ${chunk.fileName}`)
  }
  const assets = result.output.filter((item) => item.type === 'asset')
  validateBuiltHtml(assets, chunk)
  let css = assets
    .filter((item) => item.fileName.endsWith('.css'))
    .map((item) => (typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('utf8')))
    .join('\n')
  let code = chunk.code
  const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff' }
  for (const asset of assets.filter((item) => item.fileName !== 'index.html' && !item.fileName.endsWith('.css'))) {
    const type = mime[extname(asset.fileName)]
    if (!type) throw new Error(`Unsupported inline resource: ${asset.fileName}`)
    const uri = `data:${type};base64,${Buffer.from(asset.source).toString('base64')}`
    let referenced = false
    for (const path of [`./${asset.fileName}`, `/${asset.fileName}`, asset.fileName, `./${basename(asset.fileName)}`, basename(asset.fileName)]) {
      if (css.includes(path) || code.includes(path)) referenced = true
      css = css.replaceAll(path, uri)
      code = code.replaceAll(path, uri)
    }
    if (!referenced) throw new Error(`Unreferenced resource: ${asset.fileName}`)
  }
  validateCss(css)
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
  <title>Mica ${designName === 'stats-design' ? 'Stats' : '长回复摘要'} - 方案对照</title>
  <style>${css.replace(/<\/style/gi, (match) => `<\\/${match.slice(2)}`)}</style>
</head>
<body class="${bodyClass.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">
${body}
<script type="module">${inlineScript(code)}</script>
</body>
</html>
`
  await writeFile(destination, html, 'utf8')
  console.log(`Exported ${destination} (${Buffer.byteLength(html)} bytes)`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
