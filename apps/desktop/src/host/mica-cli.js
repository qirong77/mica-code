import { statSync } from 'fs'
import os from 'os'
import path from 'path'

function isExecutable(file) {
  try {
    const stats = statSync(file)
    return stats.isFile() && (stats.mode & 0o111) !== 0
  } catch {
    return false
  }
}

export function resolveMicaExecutable({ env = process.env, homeDirectory = os.homedir() } = {}) {
  const explicit = (env.MICA_CLI_PATH || '').trim()
  if (explicit && isExecutable(explicit)) return explicit
  const defaultPath = path.join(homeDirectory, '.local', 'bin', 'mica')
  return isExecutable(defaultPath) ? defaultPath : null
}

/** 归一化初始命令：`mica` 用绝对路径替换（Dock 启动的应用 PATH 精简） */
export function normalizeMicaCommand(value, mica = resolveMicaExecutable()) {
  if (typeof value !== 'string') return null
  const command = value.trim()
  if (!command) return null
  if (/^mica(?:\s|$)/.test(command) && mica) {
    return command.length === 4 ? `'${mica}'` : `'${mica}' ${command.slice(4).trim()}`
  }
  return command
}
