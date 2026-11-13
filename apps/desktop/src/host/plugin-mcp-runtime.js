import { createPluginDataApi } from '@packages/mica-plugin/PluginData.js'
import { createPluginSettingsStore } from '@packages/mica-plugin/PluginSettings.js'

/**
 * Lazy runtime for bundled plugin MCP modules.
 *
 * This is deliberately separate from HeadlessPluginHost: a plugin MCP endpoint
 * belongs to the application runtime, not to one chat session.  The runtime only
 * loads a module after its endpoint is actually used and keeps one handler per
 * plugin until the plugin is disabled or the application exits.
 */
export function createPluginMcpRuntime({ manifests = [], loaders = new Map(), home, readDisabled = () => new Set() } = {}) {
  const manifestById = new Map(manifests.filter((manifest) => manifest?.mcp === true).map((manifest) => [manifest.id, manifest]))
  const handlers = new Map()
  const disposedHandlers = new WeakSet()
  let closed = false

  function disabledIds() {
    const value = readDisabled?.()
    if (value instanceof Set) return value
    return new Set(Array.isArray(value) ? value : [])
  }

  function manifestOf(pluginId) {
    if (closed) throw new Error('插件 MCP 运行时已关闭')
    const manifest = manifestById.get(pluginId)
    if (!manifest || disabledIds().has(pluginId)) throw new Error('插件已停用或没有这个 MCP 端点')
    if (typeof loaders.get(pluginId) !== 'function') throw new Error('这个插件没有随包 MCP 模块')
    return manifest
  }

  function has(pluginId) {
    if (closed || typeof pluginId !== 'string') return false
    return manifestById.has(pluginId) && typeof loaders.get(pluginId) === 'function' && !disabledIds().has(pluginId)
  }

  async function disposePending(pending) {
    const handler = await pending.catch(() => null)
    if (!handler || disposedHandlers.has(handler)) return
    disposedHandlers.add(handler)
    await handler?.dispose?.()
  }

  async function sync() {
    if (closed) return
    const disabled = disabledIds()
    const disposing = []
    for (const [pluginId, pending] of handlers) {
      if (!disabled.has(pluginId)) continue
      handlers.delete(pluginId)
      disposing.push(disposePending(pending))
    }
    await Promise.all(disposing)
  }

  async function load(pluginId) {
    await sync()
    const manifest = manifestOf(pluginId)
    let pending = handlers.get(pluginId)
    if (!pending) {
      const loader = loaders.get(pluginId)
      pending = Promise.resolve().then(async () => {
        const module = await loader()
        if (typeof module?.default !== 'function') {
          throw new Error(`插件 ${pluginId} 的 mcp.ts 没有 default createMcp(context)`) 
        }
        const handler = await module.default({
          pluginId,
          data: createPluginDataApi(home, pluginId),
          settings: createPluginSettingsStore(pluginId, manifest.settings ?? [], { configDir: home })
        })
        validateHandler(pluginId, handler)
        return handler
      })
      handlers.set(pluginId, pending)
    }
    let handler = null
    try {
      handler = await pending
      // A plugin can be disabled while its module is being imported.  Do not
      // hand the newly loaded handler to a request after that transition.
      manifestOf(pluginId)
      return handler
    } catch (error) {
      if (handlers.get(pluginId) === pending) handlers.delete(pluginId)
      if (handler) await disposePending(Promise.resolve(handler))
      throw error
    }
  }

  return {
    has,
    manifestOf,
    load,
    sync,
    async close() {
      if (closed) return
      closed = true
      const pending = [...handlers.values()]
      handlers.clear()
      await Promise.all(pending.map(disposePending))
    }
  }
}

function validateHandler(pluginId, handler) {
  if (!handler || typeof handler !== 'object' || !Array.isArray(handler.tools)) {
    throw new Error(`插件 ${pluginId} 的 MCP handler 必须返回 tools 数组`)
  }
  if (handler.dispose !== undefined && typeof handler.dispose !== 'function') {
    throw new Error(`插件 ${pluginId} 的 MCP handler dispose 必须是函数`)
  }
  const names = new Set()
  for (const tool of handler.tools) {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !tool.name.trim()) {
      throw new Error(`插件 ${pluginId} 的 MCP 工具缺少 name`)
    }
    if (names.has(tool.name)) throw new Error(`插件 ${pluginId} 的 MCP 工具重名：${tool.name}`)
    names.add(tool.name)
    if (typeof tool.execute !== 'function') throw new Error(`插件 ${pluginId} 的 MCP 工具 ${tool.name} 缺少 execute`)
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
      throw new Error(`插件 ${pluginId} 的 MCP 工具 ${tool.name} 缺少 inputSchema`)
    }
  }
}
