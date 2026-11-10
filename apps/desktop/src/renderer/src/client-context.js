/** 客户端能力由隔离 preload 提供，不能只凭 Electron UA 判断是否可用。 */
export function createClientContextApi(pluginId, { bridge = globalThis.window?.micaClient } = {}) {
  if (!bridge || typeof bridge.context !== 'function') return null
  const request = async (operation, ...args) => {
    const body = await bridge[operation](...args)
    if (body?.ok !== true) throw new Error(body?.error || '桌面客户端请求失败')
    return body.result
  }
  return {
    context: () => request('context'),
    readData: () => request('readData', pluginId),
    writeData: (value, options) =>
      request(
        'writeData',
        pluginId,
        value,
        options && Object.hasOwn(options, 'expectedVersion')
          ? { expectedVersion: options.expectedVersion }
          : undefined
      ),
    probe: (address) => request('probe', address),
    open: (url) => request('open', url),
    local: () => request('local')
  }
}
