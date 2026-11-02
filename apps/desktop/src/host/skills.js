import { ipcMain } from 'electron'
import { listSkills } from './skills-core.js'

/**
 * `skills:list` 的 IPC 装配层（纯扫描逻辑在 skills-core.js，单独可测）。
 */
export function registerSkillsIpc() {
  // `role` 是会话事实：插件随包分发的 skill 可以只属于某些角色，候选列表跟着会话走。
  ipcMain.handle('skills:list', (_event, payload = {}) => listSkills(payload?.cwd, payload?.role))
}
