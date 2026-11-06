import { createPluginSettingsStore } from '@packages/mica-plugin/PluginSettings.js'
import { readPluginData, writePluginData } from './plugin-data-store.js'

/** One runtime per enabled bundled launcher, independent of chat hosts. */
export function createPluginLauncherRuntime({ manifests, loaders, home, readDisabled }) {
  const handlers = new Map()
  let closed = false

  async function sync() {
    const disabled = readDisabled()
    for (const [id, pending] of handlers) {
      if (!disabled.has(id)) continue
      handlers.delete(id)
      const handler = await pending.catch(() => null)
      await handler?.dispose?.()
    }
  }

  function manifestOf(pluginId) {
    if (closed) throw new Error('桌面启动器运行时已关闭')
    const manifest = manifests.find((item) => item.id === pluginId && item.desktopLauncher)
    if (!manifest || readDisabled().has(pluginId)) throw new Error('插件已停用或没有桌面启动器')
    return manifest
  }

  async function request(pluginId, action, input) {
    await sync()
    const manifest = manifestOf(pluginId)
    if (typeof action !== 'string' || !action || action.length > 80)
      throw new Error('启动器动作无效')
    const loader = loaders.get(pluginId)
    if (!loader) throw new Error('这个插件没有随包桌面启动器模块')
    let pending = handlers.get(pluginId)
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        const module = await loader()
        const handler = await module.default({
          pluginId,
          settings: createPluginSettingsStore(pluginId, manifest.settings, { configDir: home }),
          readData: async () => readPluginData(home, pluginId),
          writeData: async (value, options) => writePluginData(home, pluginId, value, options)
        })
        if (typeof handler?.request !== 'function') throw new Error('启动器没有提供 request 处理器')
        return handler
      })
      handlers.set(pluginId, pending)
    }
    let handler
    try {
      handler = await pending
    } catch (error) {
      if (handlers.get(pluginId) === pending) handlers.delete(pluginId)
      throw error
    }
    manifestOf(pluginId)
    return handler.request(action, input)
  }

  return {
    request,
    sync,
    manifestOf,
    async close() {
      closed = true
      const pending = [...handlers.values()]
      handlers.clear()
      await Promise.all(pending.map(async (item) => (await item.catch(() => null))?.dispose?.()))
    }
  }
}
