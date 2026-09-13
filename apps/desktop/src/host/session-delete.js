import * as nodeFs from 'node:fs'
import { join } from 'node:path'

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

/** 会话 id 的形状校验，与 chat.js / stats.js 里拼 `sessionFile` 的规则同源。 */
export function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId)
}

/** 会话的 turn lease 锁：`sessions/.turn-locks/<id>.lock`。 */
export function turnLockPath(lockDir, sessionId) {
  return join(lockDir, `${sessionId}.lock`)
}

/**
 * 删除一个会话：会话文件 + 它的 turn lease 锁。
 *
 * 返回会话文件是否真的存在过。文件已经不在了也照样清一次孤儿锁——另一个进程可能先删了
 * 文件，残留的锁会让同一 id 的后续 resume 误报「该会话正在另一个终端运行」。
 */
export function deleteSessionFiles({ directory, lockDir, sessionId, fileSystem = nodeFs }) {
  if (!isValidSessionId(sessionId)) throw new Error('Invalid session id')
  const file = join(directory, `${sessionId}.json`)
  let removed = false
  try {
    removed = fileSystem.existsSync(file)
    fileSystem.rmSync(file, { force: true })
  } catch {
    // 权限/并发删除等异常不让侧栏卡在这一步，下一次扫描会收敛到磁盘真实状态。
    removed = false
  }
  try {
    fileSystem.rmSync(turnLockPath(lockDir, sessionId), { force: true })
  } catch {
    // best-effort，与 SessionStore.delete 一致：孤锁会在下次 acquire 时随 pid 死亡回收。
  }
  return removed
}

/** 从侧栏手动排序里摘掉这个会话（每个 section 一份 id 列表）。 */
export function stripSessionFromSort(sort, sessionId) {
  const next = {}
  for (const [section, list] of Object.entries(sort || {}))
    next[section] = Array.isArray(list) ? list.filter((id) => id !== sessionId) : []
  return next
}
