import { PLUGIN_MCP_PREFIX, pluginMcpId } from '@packages/mica-plugin/PluginMcp.js'

/** 在应用的 remoteGate 之后调用；插件路径不允许回落到 SPA 静态页面。 */
export function createPluginMcpRoute({ runtime, handle, verifyOrigin }) {
  return async (req, res, pathname) => {
    if (pathname !== PLUGIN_MCP_PREFIX && !pathname.startsWith(`${PLUGIN_MCP_PREFIX}/`)) return false
    const origin = verifyOrigin(req)
    if (!origin.ok) {
      sendJson(res, origin.status, { ok: false, error: origin.error })
      return true
    }
    const pluginId = pluginMcpId(pathname)
    if (!pluginId || !runtime.has(pluginId)) {
      sendJson(res, 404, { ok: false, error: '插件已停用或没有这个 MCP 端点' })
      return true
    }
    await handle(pluginId, req, res)
    return true
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
