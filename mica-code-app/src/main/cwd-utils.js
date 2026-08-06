import { homedir } from 'os'
import { dirname } from 'path'
import { statSync } from 'fs'

/** 判断路径是否为真实存在的目录（只接受目录，文件或不存在均视为无效） */
export function isDirectory(p) {
  if (typeof p !== 'string' || !p.trim()) return false
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 把可能失效的 cwd 归一化为可用的目录：
 * - 目录存在则原样返回；
 * - 失效时向上回溯最近一个仍存在的祖先目录；
 * - 连祖先都失效则回退到用户主目录。
 * 返回 { cwd, original, changed }，changed 表示是否发生过回退。
 */
export function resolveUsableCwd(dir) {
  const original = typeof dir === 'string' && dir.trim() ? dir.trim() : process.cwd()
  if (isDirectory(original)) return { cwd: original, original, changed: false }
  let probe = original
  while (probe && probe !== '/' && probe !== dirname(probe)) {
    probe = dirname(probe)
    if (isDirectory(probe)) return { cwd: probe, original, changed: true }
  }
  const home = homedir()
  return { cwd: home, original, changed: original !== home }
}
