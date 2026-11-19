import { isPluginWebQuery } from '@packages/mica-plugin/PluginWeb.js'
import { matchesPluginPagePath, readPluginPageId } from '@packages/mica-web-shared/app-paths.js'
import { observePluginOperation, startPluginOperation } from '@packages/mica-diagnostics/operation.js'
import { PluginWebError } from '../host/plugin-web-runtime.js'

export const PLUGIN_WEB_MAX_BYTES = 1024 * 1024
export const PLUGIN_WEB_TIMEOUT_MS = 15_000
const MAX_PARAMS = 16
const MAX_PARAM_KEY = 64
const MAX_PARAM_VALUE = 2048

/** Entire /plugins namespace is private and terminal: it never falls back to the SPA. */
export function createPluginWebRoute({
  runtime, manifests = [], readDisabled = () => new Set(),
  verifyOrigin, servePage, timeoutMs = PLUGIN_WEB_TIMEOUT_MS, maxConcurrent = 16
}) {
  const pages = new Map(manifests.filter((manifest) => manifest.desktopPage || manifest.desktopLauncher).map((manifest) => [manifest.id, manifest]))
  const versions = new Map(manifests.map((manifest) => [manifest.id, manifest.version]))
  let pending = 0
  return async (req, res, pathname) => {
    let namespace = pathname
    try { namespace = decodeURIComponent(pathname) } catch { /* malformed paths remain terminal */ }
    if (namespace !== '/plugins' && !namespace.startsWith('/plugins/')) return false
    const origin = verifyOrigin(req)
    if (!origin.ok) {
      sendJson(res, origin.status, { ok: false, error: origin.error })
      return true
    }

    const api = /^\/plugins\/([a-z0-9][a-z0-9._-]*)\/api\/([^/]+)$/.exec(pathname)
    if (!api) {
      const pluginId = readPluginPageId(pathname)
      const manifest = pages.get(pluginId)
      const allowed = () => manifest && !runtime.signal.aborted && !readDisabled().has(pluginId) &&
        matchesPluginPagePath(pathname, pluginId, manifest.desktopPage?.route)
      if (!allowed()) sendJson(res, 404, { ok: false, error: '没有这个插件页面' })
      else if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: '插件页面只接受 GET / HEAD' }, { allow: 'GET, HEAD' })
      } else {
        try { await servePage(req, res, allowed) }
        catch { sendJson(res, 500, { ok: false, error: '插件页面暂时无法读取' }) }
      }
      return true
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: '插件只读接口只接受 GET' }, { allow: 'GET' })
      return true
    }
    const [, pluginId, query] = api
    if (!isPluginWebQuery(query) || !runtime.has(pluginId)) {
      sendJson(res, 404, { ok: false, error: '插件已停用或没有这个只读接口' })
      return true
    }
    let params
    try { params = queryParams(req) }
    catch {
      sendJson(res, 400, { ok: false, code: 'invalid_params', error: '插件只读查询参数无效或过长' })
      return true
    }
    if (pending >= maxConcurrent) {
      startPluginOperation({ plugin: pluginId, pluginVersion: versions.get(pluginId),
        operation: `web.read.${query}`, surface: 'page' }).finish({ outcome: 'busy', code: 'busy' })
      sendJson(res, 429, { ok: false, code: 'busy', error: '插件只读查询繁忙，请稍后重试' })
      return true
    }

    pending += 1
    const caller = new AbortController()
    const signal = AbortSignal.any([caller.signal, runtime.signal])
    const abort = () => {
      if (!res.writableEnded) caller.abort(new DOMException('Plugin web caller disconnected', 'AbortError'))
    }
    req.once('aborted', abort)
    res.once('close', abort)
    if (req.aborted || res.destroyed) abort()
    const timer = setTimeout(() => caller.abort(new DOMException('Plugin web query timed out', 'TimeoutError')), timeoutMs)
    timer.unref?.()
    try {
      const manifest = runtime.manifestOf(pluginId)
      const context = { plugin: pluginId, pluginVersion: manifest.version, surface: 'page', signal }
      const handler = await observePluginOperation({ ...context, operation: 'web.load' }, () => runtime.load(pluginId))
      if (!Object.hasOwn(handler.queries, query)) throw new PluginWebError('not_found')
      const text = await observePluginOperation({
        ...context, operation: `web.read.${query}`,
        // This records successful transport/serialization, not product acceptance.
        classify: () => ({ outcome: 'success', code: 'read_complete' })
      }, async () => {
        const result = await runtime.read(pluginId, handler, query, params, { signal })
        let encoded
        try { encoded = JSON.stringify({ ok: true, result: result === undefined ? null : result }) }
        catch { throw new PluginWebError('invalid_result') }
        if (Buffer.byteLength(encoded) > PLUGIN_WEB_MAX_BYTES) throw new PluginWebError('response_too_large')
        return encoded
      })
      signal.throwIfAborted()
      if (!runtime.has(pluginId)) throw new PluginWebError('unavailable')
      sendText(res, 200, text)
    } catch (error) {
      const failure = signal.aborted ? signal.reason : error
      if (failure?.name === 'TimeoutError') sendJson(res, 504, { ok: false, code: 'timeout', error: '插件只读查询超时，请稍后重试' })
      else if (failure?.name === 'AbortError') sendJson(res, 499, { ok: false, code: 'cancelled', error: '插件只读查询已取消' })
      else {
        const safe = failure instanceof PluginWebError ? failure : new PluginWebError('query_failed')
        sendJson(res, safe.status, { ok: false, code: safe.code, error: safe.message })
      }
    } finally {
      clearTimeout(timer)
      req.off('aborted', abort)
      res.off('close', abort)
      pending -= 1
    }
    return true
  }
}

function queryParams(req) {
  if (Number(req.headers?.['content-length'] || 0) > 0 || req.headers?.['transfer-encoding']) throw new Error('body')
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.search.length > 8192) throw new Error('query')
  const params = Object.create(null)
  let count = 0
  for (const [key, value] of url.searchParams) {
    if (++count > MAX_PARAMS || !key || key.length > MAX_PARAM_KEY || value.length > MAX_PARAM_VALUE || Object.hasOwn(params, key)) throw new Error('params')
    params[key] = value
  }
  return Object.freeze(params)
}

function sendJson(res, status, value, headers) {
  return sendText(res, status, JSON.stringify(value), headers)
}

function sendText(res, status, text, headers = {}) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text), ...headers
  })
  res.end(text)
}
