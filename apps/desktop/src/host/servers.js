import { app, ipcMain } from 'electron'
import {
  mergeServerUrl,
  normalizeServerUrl,
  probeServer,
  readServerStore,
  removeServerUrl,
  setServerNote,
  writeServerStore
} from './servers-core'

/**
 * 「切换 Mica 服务器」的 IPC 面：清单读写 + 备注 + 目标探活。
 *
 * 清单与 workspace.json / session-pins.json 同目录（`app.getPath('userData')`，
 * 服务端模式下由 electron-shim 解析到同一个 `mica-code-app` 目录），因此 Electron
 * 与 `npm run start:web` 两种运行方式共享同一份清单。逻辑本身在 servers-core.js。
 */

const STORE_VERSION = 1

function storePath() {
  return app.getPath('userData')
}

export function registerServersIpc() {
  ipcMain.handle('app:servers:list', () => readServerStore(storePath()).servers)

  ipcMain.handle('app:servers:remember', (_event, payload) => {
    const url = normalizeServerUrl(payload?.url)
    if (!url) throw new Error('地址格式不正确')
    const store = readServerStore(storePath())
    const next = { version: STORE_VERSION, servers: mergeServerUrl(store.servers, url) }
    writeServerStore(storePath(), next)
    return next.servers
  })

  ipcMain.handle('app:servers:forget', (_event, payload) => {
    const store = readServerStore(storePath())
    const next = {
      version: STORE_VERSION,
      servers: removeServerUrl(store.servers, String(payload?.url ?? '').trim())
    }
    writeServerStore(storePath(), next)
    return next.servers
  })

  ipcMain.handle('app:servers:note', (_event, payload) => {
    const url = normalizeServerUrl(payload?.url)
    if (!url) throw new Error('地址格式不正确')
    const store = readServerStore(storePath())
    const next = {
      version: STORE_VERSION,
      servers: setServerNote(store.servers, url, payload?.note)
    }
    writeServerStore(storePath(), next)
    return next.servers
  })

  ipcMain.handle('app:servers:probe', (_event, payload) => probeServer(payload?.url))
}
