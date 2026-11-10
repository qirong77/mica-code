import { isElectronShell } from './shell-env'

/** 客户端能力不随页面切到远程运行时；普通浏览器没有原生客户端。 */
export function createClientContextApi(
  pluginId,
  { userAgent = globalThis.navigator?.userAgent, fetch = globalThis.fetch } = {}
) {
  if (!isElectronShell(userAgent)) return null
  const request = async (operation, payload = {}) => {
    const response = await fetch(`mica-client://host/${operation}`, {
      method: 'POST',
      referrerPolicy: 'origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const body = await response.json()
    if (!response.ok || body?.ok !== true) throw new Error(body?.error || '桌面客户端请求失败')
    return body.result
  }
  return {
    context: () => request('context'),
    readData: () => request('read-data', { pluginId }),
    writeData: (value, options) =>
      request('write-data', {
        pluginId,
        value,
        ...(options && Object.hasOwn(options, 'expectedVersion')
          ? { expectedVersion: options.expectedVersion }
          : {})
      }),
    probe: (address) => request('probe', { address }),
    open: (url) => request('open', { url }),
    local: () => request('local')
  }
}
