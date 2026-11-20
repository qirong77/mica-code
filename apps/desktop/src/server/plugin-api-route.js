import {
  PLUGIN_API_METHODS,
  PluginApiError,
  isPluginApiMethod,
  pluginApiId,
  pluginApiPath,
  pluginApiSegments
} from '@packages/mica-plugin/PluginApi.js'
import { observePluginOperation, startPluginOperation } from '@packages/mica-diagnostics/operation.js'
import { PluginApiRuntimeError } from '../host/plugin-api-runtime.js'

export const PLUGIN_API_TIMEOUT_MS = 30_000
export const PLUGIN_API_MAX_BODY_BYTES = 8 * 1024 * 1024
export const PLUGIN_API_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
// 与只读查询同一套上限：机读接口的输入不该比查询参数更宽松。
const MAX_PARAMS = 16
const MAX_PARAM_KEY = 64
const MAX_PARAM_VALUE = 2048
const MAX_QUERY_CHARS = 8 * 1024
const ALLOWED_METHODS = [...PLUGIN_API_METHODS, 'HEAD'].join(', ')
const EMPTY_QUERY = Object.freeze(Object.create(null))

/** 文档端点自己也要出现在文档里：调用方读到的第一个响应就是它的说明书。 */
const DOCUMENT_ENDPOINT = Object.freeze({
  method: 'GET',
  path: '/api',
  summary: '接口文档（本响应）',
  returns: '{ plugin, base, description, guide, endpoints }'
})

/**
 * 随包插件的机读接口：`/plugin/<id>/api` 及其子路径。
 *
 * 只接管 `pluginApiId` 认得的路径，其余一律返回 false（不消费）：同名的 `/plugins/*`
 * 复数命名空间是只读查询与插件页面，两者互不越界。
 */
export function createPluginApiRoute({
  runtime,
  verifyOrigin,
  timeoutMs = PLUGIN_API_TIMEOUT_MS,
  maxBodyBytes = PLUGIN_API_MAX_BODY_BYTES,
  maxResponseBytes = PLUGIN_API_MAX_RESPONSE_BYTES
}) {
  return async (req, res, pathname) => {
    const pluginId = pluginApiId(pathname)
    if (!pluginId) return false
    const origin = verifyOrigin(req)
    if (!origin.ok) {
      sendJson(res, origin.status, { ok: false, error: origin.error })
      return true
    }

    // HEAD 按 GET 处理：`curl -I` 是探活/自检的常用手法，正文由 sendText 省掉。
    const head = req.method === 'HEAD'
    const method = head ? 'GET' : req.method
    if (!isPluginApiMethod(method)) {
      fail(res, 'method_not_allowed', { allow: ALLOWED_METHODS })
      return true
    }
    if (!runtime.has(pluginId)) {
      fail(res, 'unavailable')
      return true
    }
    const segments = pluginApiSegments(pathname)
    if (segments === null) {
      fail(res, 'invalid_path')
      return true
    }
    // 根路径是宿主的文档端点，永远不转发给插件（契约里 path 至少一段）。
    if (segments.length === 0 && method !== 'GET') {
      fail(res, 'method_not_allowed', { allow: 'GET, HEAD' })
      return true
    }

    let query = EMPTY_QUERY
    let body
    if (segments.length > 0) {
      const parsed = queryParams(req)
      if (!parsed) {
        fail(res, 'invalid_params')
        return true
      }
      query = parsed
      if (method === 'GET' || method === 'DELETE') {
        // 这两个方法没有 body 的位置：带了就是调用方拼错了，别悄悄忽略。
        if (hasBody(req)) {
          fail(res, 'invalid_body')
          return true
        }
      } else {
        try {
          body = await readJsonBody(req, maxBodyBytes)
        } catch (error) {
          if (!(error instanceof PluginApiRuntimeError)) throw error
          fail(res, error.code)
          return true
        }
      }
    }

    const caller = new AbortController()
    const signal = AbortSignal.any([caller.signal, runtime.signal])
    const abort = () => {
      if (!res.writableEnded) caller.abort(new DOMException('Plugin api caller disconnected', 'AbortError'))
    }
    req.once('aborted', abort)
    res.once('close', abort)
    if (req.aborted || res.destroyed) abort()
    const timer = setTimeout(
      () => caller.abort(new DOMException('Plugin api request timed out', 'TimeoutError')),
      timeoutMs
    )
    timer.unref?.()
    let version
    try {
      const manifest = runtime.manifestOf(pluginId)
      version = manifest.version
      const context = { plugin: pluginId, pluginVersion: manifest.version, surface: 'api', signal }
      const handler = await observePluginOperation({ ...context, operation: 'api.load' }, () =>
        runtime.load(pluginId)
      )

      let answer
      if (segments.length === 0) {
        // 文档端点只读：加载 handler 只为拿端点表，不产生任何写入。
        answer = {
          status: 200,
          text: encodeEnvelope({
            ok: true,
            data: {
              plugin: { id: pluginId, name: manifest.name, version: manifest.version },
              base: pluginApiPath(pluginId),
              // 没写就是没写：null 比缺字段更好被机器判断。
              description: handler.description ?? null,
              guide: handler.guide ?? null,
              endpoints: [...handler.endpoints, DOCUMENT_ENDPOINT]
            }
          })
        }
      } else {
        const result = await runtime.invoke(pluginId, { method, path: segments, query, body }, { signal })
        // 这一条记的是「整次请求成功 + 序列化完成」，不是产品语义上的成功。
        answer = await observePluginOperation(
          {
            ...context,
            operation: 'api.request',
            classify: () => ({ outcome: 'success', code: 'request_complete' })
          },
          async () => ({
            status: result.status ?? 200,
            text: encodeEnvelope({ ok: true, data: result.body === undefined ? null : result.body })
          })
        )
      }
      // 先算长度再回包：宁可 413，也不要发出半个响应或一个已经写了一半的 body。
      if (Buffer.byteLength(answer.text) > maxResponseBytes) throw new PluginApiRuntimeError('response_too_large')
      signal.throwIfAborted()
      if (!runtime.has(pluginId)) throw new PluginApiRuntimeError('unavailable')
      sendText(res, answer.status, answer.text, {}, head)
    } catch (error) {
      const failure = signal.aborted ? signal.reason : error
      if (failure?.name === 'TimeoutError') {
        sendJson(res, 504, { ok: false, code: 'timeout', error: '插件接口调用超时，请稍后重试' })
      } else if (failure?.name === 'AbortError') {
        sendJson(res, 499, { ok: false, code: 'cancelled', error: '插件接口调用已取消' })
      } else if (failure instanceof PluginApiError) {
        // 插件自己声明的状态与文案原样透出；越界的 status 是写不进响应头的，按 500 处理。
        const status =
          Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599
            ? failure.status
            : 500
        sendJson(res, status, { ok: false, code: failure.code, error: failure.message })
      } else {
        const safe = failure instanceof PluginApiRuntimeError ? failure : new PluginApiRuntimeError('request_failed')
        // 并发预算拒绝记一条 busy：它和「插件自己报错」不是一回事，排查时要能分开数。
        if (safe.code === 'busy') {
          startPluginOperation({
            plugin: pluginId,
            pluginVersion: version,
            operation: 'api.request',
            surface: 'api'
          }).finish({ outcome: 'busy', code: 'busy' })
        }
        sendJson(res, safe.status, { ok: false, code: safe.code, error: safe.message })
      }
    } finally {
      clearTimeout(timer)
      req.off('aborted', abort)
      res.off('close', abort)
    }
    return true
  }
}

function fail(res, code, headers) {
  const error = new PluginApiRuntimeError(code)
  sendJson(res, error.status, { ok: false, code: error.code, error: error.message }, headers)
}

function encodeEnvelope(value) {
  try {
    return JSON.stringify(value)
  } catch {
    throw new PluginApiRuntimeError('invalid_result')
  }
}

function hasBody(req) {
  return Number(req.headers?.['content-length'] || 0) > 0 || Boolean(req.headers?.['transfer-encoding'])
}

/** 参数上限与只读查询一致；同名参数取第一个（`?x=1&x=2` 取 1，不因此拒绝整次请求）。 */
function queryParams(req) {
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.search.length > MAX_QUERY_CHARS) return null
  const params = Object.create(null)
  let count = 0
  for (const [key, value] of url.searchParams) {
    if (++count > MAX_PARAMS || !key || key.length > MAX_PARAM_KEY || value.length > MAX_PARAM_VALUE) return null
    if (!Object.hasOwn(params, key)) params[key] = value
  }
  return Object.freeze(params)
}

/** 空 body 读成 undefined（GET 语义上的「没有 body」），非空必须是合法 JSON。 */
async function readJsonBody(req, limit) {
  if (Number(req.headers?.['content-length'] || 0) > limit) throw new PluginApiRuntimeError('body_too_large')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new PluginApiRuntimeError('body_too_large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new PluginApiRuntimeError('invalid_json')
  }
}

function sendJson(res, status, value, headers) {
  return sendText(res, status, JSON.stringify(value), headers)
}

function sendText(res, status, text, headers = {}, head = false) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers
  })
  // HEAD 只回头部：content-length 仍是 GET 会返回的长度，正文在这里省掉。
  res.end(head ? undefined : text)
}
