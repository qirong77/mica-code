import { ipcMain } from 'electron'
import { isConfigWebAction, runConfigWebAction } from './configWebData.js'

/**
 * 配置页（packages/mica-config-ui）在桌面端的数据面。
 *
 * 页面组件由 renderer 直接渲染 —— 不再拉起 config-web worker，也没有 iframe：数据来自
 * 页面所连的那台运行时（这台机器上的 `$MICA_HOME`），所以「切到另一台服务器」之后，设置页
 * 改的就是那一台的配置。浏览器端有另一份传输层实现（apps/config-web 的 HTTP 路由）。
 */
export function registerConfigWebIpc() {
  ipcMain.handle('config-web:invoke', (_event, payload) => {
    const action = payload?.action
    if (!isConfigWebAction(action)) throw new Error(`未知的配置操作：${String(action)}`)
    return runConfigWebAction(action, payload?.input ?? {})
  })
}
