import { ipcMain } from 'electron'
import { listMcpCandidates } from './mcp-candidates-core.js'

/**
 * `mcp:candidates` 的 IPC 装配层（纯扫描逻辑在 mcp-candidates-core.js，单独可测）。
 */
export function registerMcpCandidatesIpc() {
  ipcMain.handle('mcp:candidates', () => listMcpCandidates())
}
