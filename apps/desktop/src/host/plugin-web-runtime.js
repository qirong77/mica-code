import { join } from 'node:path'
import { createPluginSettingsStore } from '@packages/mica-plugin/PluginSettings.js'
import { isPluginWebQuery } from '@packages/mica-plugin/PluginWeb.js'
import { awaitOperation, observePluginOperation } from '@packages/mica-diagnostics/operation.js'

const ERRORS = {
  unavailable: [404, '插件已停用或没有这个只读接口'],
  not_found: [404, '没有这个插件只读查询'],
  initialization_failed: [503, '插件只读模块暂时无法初始化，请稍后重试'],
  query_failed: [500, '插件只读查询失败，请稍后重试'],
  busy: [429, '插件只读查询繁忙，请稍后重试'],
  invalid_result: [500, '插件只读查询返回了无效的 JSON'],
  response_too_large: [413, '插件只读查询结果超过 1 MiB 上限']
}

/** Only these fixed messages/codes cross the HTTP boundary; never an internal exception. */
export class PluginWebError extends Error {
  constructor(code) {
    const [status, message] = ERRORS[Object.hasOwn(ERRORS, code) ? code : 'query_failed']
    super(message)
    this.name = 'PluginWebError'
    this.code = Object.hasOwn(ERRORS, code) ? code : 'query_failed'
    this.status = status
  }
}

/** One lazily assembled, session-independent handler per enabled bundled plugin. */
export function createPluginWebRuntime({
  manifests = [],
  loaders = new Map(),
  home,
  readDisabled = () => new Set(),
  maxConcurrent = 8,
  maxPluginConcurrent = 4
} = {}) {
  const manifestById = new Map(
    manifests.filter((entry) => entry?.web === true).map((entry) => [entry.id, entry])
  )
  const catalog = Object.freeze(
    manifests.map(({ id, name, version }) => Object.freeze({ id, name, version }))
  )
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
    if (!has(pluginId)) throw new PluginWebError('unavailable')
    return manifestById.get(pluginId)
  }

  function dispose(entry) {
    if (!entry.original || entry.disposal) return entry.disposal ?? Promise.resolve()
    entry.disposal = observePluginOperation(
      {
        plugin: entry.id,
        pluginVersion: entry.version,
        surface: 'page',
        operation: 'web.dispose'
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
    entry.controller.abort(new DOMException('Plugin web instance stopped', 'AbortError'))
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
    // Disable -> enable cannot overlap a new instance with readers still
    // draining inside the previous instance's asynchronous dispose.
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
          if (typeof module?.default !== 'function')
            throw new PluginWebError('initialization_failed')
          const settings = createPluginSettingsStore(pluginId, manifest.settings ?? [], {
            configDir: home
          })
          const handler = await module.default(
            Object.freeze({
              pluginId,
              pluginVersion: manifest.version,
              paths: Object.freeze({ config: home, data: join(home, 'plugin-data', pluginId) }),
              settings: Object.freeze({ get: () => ({ ...settings.get() }) }),
              catalog
            })
          )
          entry.original = handler && typeof handler === 'object' ? handler : null
          entry.handler = normalizeHandler(handler)
          if (entry.retired || entries.get(pluginId) !== entry || !has(pluginId)) {
            await retire(entry)
            throw new PluginWebError('unavailable')
          }
          return entry.handler
        })
        .catch(async (error) => {
          await retire(entry)
          throw error instanceof PluginWebError
            ? error
            : new PluginWebError('initialization_failed')
        })
    }
    const handler = await entry.pending
    if (entry.retired || entries.get(pluginId) !== entry || !has(pluginId)) {
      await retire(entry)
      throw new PluginWebError('unavailable')
    }
    return handler
  }

  function read(pluginId, handler, query, params, { signal } = {}) {
    const entry = entries.get(pluginId)
    if (!has(pluginId) || !entry || entry.retired || entry.handler !== handler)
      throw new PluginWebError('unavailable')
    if (!isPluginWebQuery(query) || !Object.hasOwn(handler.queries, query))
      throw new PluginWebError('not_found')
    const requestSignal = AbortSignal.any([entry.controller.signal, ...(signal ? [signal] : [])])
    requestSignal.throwIfAborted()
    const count = activeByPlugin.get(pluginId) ?? 0
    if (active >= maxConcurrent || count >= maxPluginConcurrent) throw new PluginWebError('busy')
    active += 1
    activeByPlugin.set(pluginId, count + 1)
    const task = Promise.resolve().then(() => {
      requestSignal.throwIfAborted()
      return handler.queries[query](params, { signal: requestSignal })
    })
    // Keep the slot until the actual handler settles, even if it ignores abort.
    // A timed-out HTTP waiter must not enable unlimited abandoned plugin work.
    const settled = task.finally(() => {
      active -= 1
      const remaining = (activeByPlugin.get(pluginId) ?? 1) - 1
      if (remaining > 0) activeByPlugin.set(pluginId, remaining)
      else activeByPlugin.delete(pluginId)
    })
    return awaitOperation(() => settled, requestSignal).catch((error) => {
      if (requestSignal.aborted) throw requestSignal.reason
      throw error instanceof PluginWebError ? error : new PluginWebError('query_failed')
    })
  }

  return {
    has,
    manifestOf,
    load,
    read,
    sync,
    signal: lifecycle.signal,
    async close() {
      if (closed) return
      closed = true
      lifecycle.abort(new DOMException('Plugin web runtime closed', 'AbortError'))
      await Promise.all([...entries.values()].map(retire))
      await Promise.all([...disposing])
    }
  }
}

function normalizeHandler(handler) {
  if (
    !handler ||
    typeof handler !== 'object' ||
    !handler.queries ||
    typeof handler.queries !== 'object' ||
    Array.isArray(handler.queries)
  )
    throw new PluginWebError('initialization_failed')
  if (handler.dispose !== undefined && typeof handler.dispose !== 'function')
    throw new PluginWebError('initialization_failed')
  const queries = Object.create(null)
  for (const [query, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(handler.queries)
  )) {
    if (!isPluginWebQuery(query) || typeof descriptor.value !== 'function')
      throw new PluginWebError('initialization_failed')
    queries[query] = descriptor.value
  }
  return Object.freeze({ queries: Object.freeze(queries) })
}
