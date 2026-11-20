import { createPluginDataApi } from '@packages/mica-plugin/PluginData.js'
import { createPluginSettingsStore } from '@packages/mica-plugin/PluginSettings.js'
import { PluginApiError, isPluginApiMethod } from '@packages/mica-plugin/PluginApi.js'
import { awaitOperation, observePluginOperation } from '@packages/mica-diagnostics/operation.js'

/**
 * 失败文案只在这张表里写一次。
 *
 * 前五个是运行时自己的失败（加载、并发、结果形状），后面几个是路由层的传输失败：
 * `response_too_large`、`invalid_json` 这类判断只有路由做得出来，但同一个 code 若在两个
 * 文件里各写一句文案，迟早会漂移，所以表放在最靠近插件的那一层，路由直接借用一个 code。
 */
const ERRORS = {
  unavailable: [404, '插件已停用或没有这个接口'],
  initialization_failed: [503, '插件接口暂时无法初始化，请稍后重试'],
  busy: [429, '插件接口繁忙，请稍后重试'],
  invalid_result: [500, '插件接口返回了无效的结果'],
  request_failed: [500, '插件接口调用失败，请稍后重试'],
  response_too_large: [413, '插件接口响应超过大小上限'],
  invalid_path: [400, '插件接口路径无效'],
  invalid_params: [400, '插件接口查询参数无效或过长'],
  invalid_body: [400, '插件接口的这个方法不接受请求体'],
  invalid_json: [400, '插件接口请求体不是合法 JSON'],
  body_too_large: [413, '插件接口请求体超过大小上限'],
  method_not_allowed: [405, '插件接口不接受这个方法']
}

const EMPTY_QUERY = Object.freeze(Object.create(null))

/** Only these fixed messages/codes cross the HTTP boundary; never an internal exception. */
export class PluginApiRuntimeError extends Error {
  constructor(code) {
    const known = Object.hasOwn(ERRORS, code)
    const [status, message] = ERRORS[known ? code : 'request_failed']
    super(message)
    this.name = 'PluginApiRuntimeError'
    this.code = known ? code : 'request_failed'
    this.status = status
  }
}

/**
 * 一个随包 api.ts 模块的懒加载运行时：应用端口上的机读接口，与会话无关。
 *
 * 与 web runtime 的区别只在「handler 有几个」——只读查询是每个 query 一个函数，
 * 这里是一个 `handle` 自己按方法 + 路径分派。除此之外的生命周期完全相同：
 * 用到才加载、插件停用就释放、退出时取消在跑的请求。
 */
export function createPluginApiRuntime({
  manifests = [],
  loaders = new Map(),
  home,
  readDisabled = () => new Set(),
  maxConcurrent = 16,
  maxPluginConcurrent = 8
} = {}) {
  // 声明与模块缺一不可：清单没有 `api: true` 的插件即使目录里躺着 api.ts 也不会被加载。
  const manifestById = new Map(manifests.filter((entry) => entry?.api === true).map((entry) => [entry.id, entry]))
  const entries = new Map()
  const lifecycle = new AbortController()
  const activeByPlugin = new Map()
  const disposing = new Set()
  const retiringByPlugin = new Map()
  let active = 0
  let closed = false

  function disabledIds() {
    const ids = readDisabled()
    return ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids : [])
  }

  function has(pluginId) {
    return (
      !closed &&
      manifestById.has(pluginId) &&
      typeof loaders.get(pluginId) === 'function' &&
      !disabledIds().has(pluginId)
    )
  }

  function manifestOf(pluginId) {
    if (!has(pluginId)) throw new PluginApiRuntimeError('unavailable')
    return manifestById.get(pluginId)
  }

  function dispose(entry) {
    if (!entry.original || entry.disposal) return entry.disposal ?? Promise.resolve()
    entry.disposal = observePluginOperation(
      {
        plugin: entry.id,
        pluginVersion: entry.version,
        surface: 'api',
        operation: 'api.dispose'
      },
      () => entry.original.dispose?.()
    ).catch(() => {})
    disposing.add(entry.disposal)
    retiringByPlugin.set(entry.id, entry.disposal)
    void entry.disposal.finally(() => {
      disposing.delete(entry.disposal)
      if (retiringByPlugin.get(entry.id) === entry.disposal) retiringByPlugin.delete(entry.id)
    })
    return entry.disposal
  }

  function retire(entry) {
    entry.retired = true
    entry.controller.abort(new DOMException('Plugin api instance stopped', 'AbortError'))
    if (entries.get(entry.id) === entry) entries.delete(entry.id)
    // A stalled factory has no signal in its public contract. Do not block shutdown
    // on it, but dispose its handler if/when the factory eventually returns.
    return dispose(entry)
  }

  async function sync() {
    const retired = []
    for (const entry of entries.values()) if (!has(entry.id)) retired.push(retire(entry))
    await Promise.all(retired)
  }

  async function load(pluginId) {
    // Invalidate synchronously before any await, including disable -> enable races.
    for (const entry of entries.values()) if (!has(entry.id)) void retire(entry)
    // Disable -> enable cannot overlap a new instance with requests still draining
    // inside the previous instance's asynchronous dispose.
    await retiringByPlugin.get(pluginId)
    const manifest = manifestOf(pluginId)
    let entry = entries.get(pluginId)
    if (!entry) {
      entry = {
        id: pluginId,
        version: manifest.version,
        controller: new AbortController(),
        retired: false
      }
      entries.set(pluginId, entry)
      entry.pending = Promise.resolve()
        .then(async () => {
          const module = await loaders.get(pluginId)()
          if (typeof module?.default !== 'function') throw new PluginApiRuntimeError('initialization_failed')
          const settings = createPluginSettingsStore(pluginId, manifest.settings ?? [], {
            configDir: home
          })
          const handler = await module.default(
            Object.freeze({
              pluginId,
              pluginVersion: manifest.version,
              data: createPluginDataApi(home, pluginId),
              // 只读设置：改配置是插件设置项与配置页的事，接口运行期不该顺手改自己的配置。
              settings: Object.freeze({ get: () => ({ ...settings.get() }) })
            })
          )
          // Set the original first so an invalid shape can still be disposed below.
          entry.original = handler && typeof handler === 'object' ? handler : null
          entry.handler = normalizeHandler(handler)
          if (entry.retired || entries.get(pluginId) !== entry || !has(pluginId)) {
            await retire(entry)
            throw new PluginApiRuntimeError('unavailable')
          }
          return entry.handler
        })
        .catch(async (error) => {
          await retire(entry)
          throw error instanceof PluginApiRuntimeError
            ? error
            : new PluginApiRuntimeError('initialization_failed')
        })
    }
    const handler = await entry.pending
    if (entry.retired || entries.get(pluginId) !== entry || !has(pluginId)) {
      await retire(entry)
      throw new PluginApiRuntimeError('unavailable')
    }
    return handler
  }

  async function invoke(pluginId, request, { signal } = {}) {
    const entry = entries.get(pluginId)
    if (!has(pluginId) || !entry || entry.retired || !entry.handler)
      throw new PluginApiRuntimeError('unavailable')
    const requestSignal = AbortSignal.any([entry.controller.signal, ...(signal ? [signal] : [])])
    requestSignal.throwIfAborted()
    const count = activeByPlugin.get(pluginId) ?? 0
    if (active >= maxConcurrent || count >= maxPluginConcurrent) throw new PluginApiRuntimeError('busy')
    active += 1
    activeByPlugin.set(pluginId, count + 1)
    const handler = entry.handler
    // 冻结请求对象：插件拿到的是数据，不是路由里还能被后续代码改动的引用。
    const call = Object.freeze({
      method: request.method,
      path: Object.freeze([...(request.path ?? [])]),
      query: request.query ?? EMPTY_QUERY,
      body: request.body,
      signal: requestSignal
    })
    const task = Promise.resolve().then(() => {
      requestSignal.throwIfAborted()
      return observePluginOperation(
        {
          plugin: pluginId,
          pluginVersion: entry.version,
          surface: 'api',
          operation: 'api.handle',
          signal: requestSignal
        },
        () => handler.handle(call)
      )
    })
    // Keep the slot until the actual handler settles, even if it ignores abort.
    // A timed-out HTTP waiter must not enable unlimited abandoned plugin work.
    const settled = task.finally(() => {
      active -= 1
      const remaining = (activeByPlugin.get(pluginId) ?? 1) - 1
      if (remaining > 0) activeByPlugin.set(pluginId, remaining)
      else activeByPlugin.delete(pluginId)
    })
    return awaitOperation(() => settled, requestSignal)
      .then((value) => normalizeResult(value))
      .catch((error) => {
        // 调用方自己的取消/超时原样上抛，由路由翻译成 499 / 504。
        if (requestSignal.aborted) throw requestSignal.reason
        // 插件抛 PluginApiError 就是它想回给调用方的状态，不在这里改写。
        if (error instanceof PluginApiError || error instanceof PluginApiRuntimeError) throw error
        // 其它异常一律归一：内部 message、堆栈与路径都不该出现在 HTTP 响应里。
        throw new PluginApiRuntimeError('request_failed')
      })
  }

  return {
    has,
    manifestOf,
    load,
    invoke,
    sync,
    signal: lifecycle.signal,
    async close() {
      if (closed) return
      closed = true
      lifecycle.abort(new DOMException('Plugin api runtime closed', 'AbortError'))
      await Promise.all([...entries.values()].map(retire))
      await Promise.all([...disposing])
    }
  }
}

/** 端点表就是文档本身：形状不对的 handler 一律按初始化失败处理，别等到调用时才 500。 */
function normalizeHandler(handler) {
  if (!handler || typeof handler !== 'object' || typeof handler.handle !== 'function')
    throw new PluginApiRuntimeError('initialization_failed')
  if (!Array.isArray(handler.endpoints) || handler.endpoints.length === 0)
    throw new PluginApiRuntimeError('initialization_failed')
  const endpoints = handler.endpoints.map((endpoint) => {
    if (!endpoint || typeof endpoint !== 'object') throw new PluginApiRuntimeError('initialization_failed')
    if (!isPluginApiMethod(endpoint.method)) throw new PluginApiRuntimeError('initialization_failed')
    const path = normalizeEndpointPath(endpoint.path)
    if (!path) throw new PluginApiRuntimeError('initialization_failed')
    if (typeof endpoint.summary !== 'string' || !endpoint.summary.trim())
      throw new PluginApiRuntimeError('initialization_failed')
    if (typeof endpoint.returns !== 'string' || !endpoint.returns.trim())
      throw new PluginApiRuntimeError('initialization_failed')
    return Object.freeze({ ...endpoint, path })
  })
  if (handler.description !== undefined && typeof handler.description !== 'string')
    throw new PluginApiRuntimeError('initialization_failed')
  if (handler.guide !== undefined && typeof handler.guide !== 'string')
    throw new PluginApiRuntimeError('initialization_failed')
  if (handler.dispose !== undefined && typeof handler.dispose !== 'function')
    throw new PluginApiRuntimeError('initialization_failed')
  return Object.freeze({
    ...(typeof handler.description === 'string' ? { description: handler.description } : {}),
    ...(typeof handler.guide === 'string' ? { guide: handler.guide } : {}),
    endpoints: Object.freeze(endpoints),
    handle: handler.handle
  })
}

/**
 * 文档里的路径相对 `/plugin/<id>/api`，所以必须以 `/` 开头；尾斜杠去掉，
 * 免得同一个端点因为写法不同在文档里出现两次。
 */
function normalizeEndpointPath(value) {
  if (typeof value !== 'string') return null
  const path = value.trim()
  if (!path.startsWith('/')) return null
  return path.replace(/\/+$/, '') || '/'
}

function normalizeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'body'))
    throw new PluginApiRuntimeError('invalid_result')
  if (
    value.status !== undefined &&
    (!Number.isInteger(value.status) || value.status < 100 || value.status > 599)
  )
    throw new PluginApiRuntimeError('invalid_result')
  return value
}
