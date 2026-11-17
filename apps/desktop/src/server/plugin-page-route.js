import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 插件整页（`/plugins/pages/<插件 id>`）。
 *
 * 页面产物只有一份：应用里点开插件页、浏览器打开这个地址、手机上（口令对了之后）打开
 * 这个地址，走的都是同一份 index.html + 同一个渲染层入口，由页面按 pathname 决定画哪个
 * 插件页。所以这里只做一件事——把产物交出去，顺带把深路径下的相对地址拉回根。
 */

/**
 * 给「深路径下打开的产物」补一条根基路径。
 *
 * `index.html` 里的资源是相对地址（`./assets/x.js`，因为 Electron 也走 file:// 加载），
 * 在 `/plugins/pages/notebook` 这种两段以上的地址下会被解析成
 * `/plugins/pages/assets/x.js` 而 404。一条 `<base href="/">` 就把它们拉回产物根，
 * 也不影响根路径与单段别名（那些地址下相对地址本来就落在根上）。
 */
export function withRootBase(html) {
  if (/<base\s/i.test(html)) return html
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (tag) => `${tag}\n    <base href="/" />`)
    : html
}

/** 回应插件整页请求；产物目录里没有 index.html 时抛出，由调用方转成 500。 */
export async function servePluginPage(req, res, rendererRoot) {
  const html = await readFile(join(rendererRoot, 'index.html'), 'utf8')
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(withRootBase(html))
}
