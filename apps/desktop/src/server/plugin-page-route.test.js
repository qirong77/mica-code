import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { servePluginPage, withRootBase } from './plugin-page-route.js'

const INDEX = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`

function response() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      return this
    },
    end(body) {
      this.body = body
      return this
    }
  }
}

describe('plugin page route', () => {
  it('rechecks authorization after the asynchronous HTML read before responding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-plugin-page-recheck-'))
    try {
      writeFileSync(join(dir, 'index.html'), INDEX)
      const res = response()
      await servePluginPage({ method: 'GET' }, res, dir, () => false)
      expect(res.status).toBe(404)
      expect(res.body).not.toContain('root')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('pins relative asset urls to the product root', () => {
    const html = withRootBase(INDEX)
    // 深路径 `/plugins/pages/notebook` 下 `./assets/x.js` 会解析到
    // `/plugins/pages/assets/x.js`，这条 base 是它能取到资源的唯一原因。
    expect(html).toContain('<head>\n    <base href="/" />')
    expect(html).toContain('src="./assets/index-abc.js"')
  })

  it('leaves a document that already declares a base alone', () => {
    const own = INDEX.replace('<head>', '<head>\n    <base href="/mica-web/" />')
    expect(withRootBase(own)).toBe(own)
  })

  it('still serves the document when there is no head tag', () => {
    expect(withRootBase('<div id="root"></div>')).toBe('<div id="root"></div>')
  })

  it('serves index.html for a plugin page address', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-plugin-page-'))
    writeFileSync(join(dir, 'index.html'), INDEX)
    const res = response()
    await servePluginPage({ method: 'GET' }, res, dir)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toContain('<base href="/" />')
  })
})
