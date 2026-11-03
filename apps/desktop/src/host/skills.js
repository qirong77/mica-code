import { ipcMain } from 'electron'
import { listSkills } from './skills-core.js'
import { listPluginCompletions } from './plugin-completions-core.js'

/**
 * 输入框补全的 IPC 装配层：`/` 的 skill 候选（`skills-core.js`）与插件清单声明的条目
 * （`plugin-completions-core.js`）。纯扫描逻辑都在各自的 core 模块里，单独可测。
 */
export function registerSkillsIpc() {
  // `role` 是会话事实：插件随包分发的 skill 可以只属于某些角色，候选列表跟着会话走。
  ipcMain.handle('skills:list', (_event, payload = {}) => listSkills(payload?.cwd, payload?.role))
  // `/` 里插件挂的条目与 skill 是同一份输入框补全，所以在这里一起装配；数据源在
  // plugin-completions-core.js（只读清单，不启动插件）。
  ipcMain.handle('completions:list', (_event, payload = {}) => listPluginCompletions(payload?.role))
}
