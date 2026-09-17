import { ipcMain } from 'electron'
import { probeServer } from './servers-core'

/**
 * 「切换 Mica 服务器」的 IPC 面：目标探活。
 *
 * 页面可以从一台运行时的地址切到另一台（桌面应用里由外壳弹新窗口，浏览器里开新标签
 * 页），但探测目标上到底是不是一台 Mica Code 运行时，页面自己做不到：跨源
 * `fetch('http://other:8787/api/health')` 受 CORS 限制读不到结果，所以由运行时代查。
 * 逻辑本身在 servers-core.js（纯函数，便于单测）。
 */

export function registerServersIpc() {
  ipcMain.handle('app:servers:probe', (_event, payload) => probeServer(payload?.url))
}
