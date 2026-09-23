import { ipcMain } from 'electron'
import { listSkills } from './skills-core.js'

/**
 * `skills:list` 的 IPC 装配层（纯扫描逻辑在 skills-core.js，单独可测）。
 */
export function registerSkillsIpc() {
  ipcMain.handle('skills:list', (_event, payload = {}) => listSkills(payload?.cwd))
}
