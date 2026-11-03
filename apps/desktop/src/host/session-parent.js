import { constants, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isValidSessionId } from './session-delete'
import { readTopLevelParentId } from './session-file-head'

/**
 * 会话树的父子关系：会话文件顶层的 `parentSessionId` 是唯一事实来源。
 *
 * 侧栏里把一个会话拖到另一个会话上写的就是这个字段——它只决定会话树怎么排，
 * 和「谁派生了谁」（sidecar 子会话、fork 分支）共用同一份数据，语义上不再区分。
 *
 * 直接改盘只在这个会话没有任何 turn lease 时成立：活着的宿主会用内存快照整份覆盖
 * 文件，那是唯一会把这一行改掉的写者。`updatedAt` 故意不动——侧栏按它排 Recent，
 * 调整层级不是「有新消息」，不该把会话顶到最前面。
 */
export function createSessionParentWriter({ sessionsDir, hasLiveTurnLease, withTurnLease }) {
  const fileOf = (sessionId) =>
    isValidSessionId(sessionId) ? join(sessionsDir(), `${sessionId}.json`) : null

  return ({ sessionId, parentId = null } = {}) => {
    const file = fileOf(sessionId)
    if (!file) throw new Error('Invalid session id')
    const next = normalizeParentId(parentId)
    if (next === sessionId) throw new Error('Cannot nest a session into itself')
    if (next) {
      const parentFile = fileOf(next)
      if (!parentFile || !existsSync(parentFile)) throw new Error('Parent session not found')
      if (isDescendantOf(readsParentId, next, sessionId))
        throw new Error('Cannot nest a session into its own descendant')
    }

    const write = () => {
      const session = readSession(file)
      if (!session) throw new Error('Session not found')
      const updated = withParent(session, next)
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
      renameSync(temporary, file)
      return { parentSessionId: next }
    }
    // 能拿到 lease 就拿着写：检查与写盘之间起的一轮否则会把这次的层级改回旧值。
    if (typeof withTurnLease === 'function') {
      try {
        return withTurnLease(sessionId, write)
      } catch (error) {
        if (error?.code === 'TURN_LEASE_BUSY') throw busyError()
        throw error
      }
    }
    if (typeof hasLiveTurnLease === 'function' && hasLiveTurnLease(sessionId)) throw busyError()
    return write()
  }

  /** 读一个会话文件顶层的父会话 id；读不到（不存在 / 坏文件）当作没有父会话。 */
  function readsParentId(sessionId) {
    const file = fileOf(sessionId)
    return file ? readTopLevelParentId(file) : null
  }
}

function busyError() {
  return new Error('该会话正在运行，请等这一轮结束再调整会话层级')
}

function normalizeParentId(parentId) {
  if (parentId === null || parentId === undefined) return null
  if (typeof parentId !== 'string') throw new Error('Invalid parent session id')
  const trimmed = parentId.trim()
  if (!trimmed) return null
  if (!isValidSessionId(trimmed)) throw new Error('Invalid parent session id')
  return trimmed
}

/** `startId` 的祖先链里有没有 `targetId`：有的话挂过去会成环。链本身坏掉时提前收手。 */
function isDescendantOf(readParentId, startId, targetId) {
  const seen = new Set()
  let current = readParentId(startId)
  while (current && !seen.has(current) && seen.size < 64) {
    if (current === targetId) return true
    seen.add(current)
    current = readParentId(current)
  }
  return false
}

function readSession(file) {
  let raw
  try {
    raw = JSON.parse(
      readFileSync(file, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW })
    )
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error('Cannot read session file')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid session file')
  return raw
}

/**
 * 写回时把 `parentSessionId` 固定在 `snapshot` 之前：头部读取只扫前 8KB，
 * 追加到文件末尾的话，下一轮成环判定就读不到这条关系了。
 */
function withParent(session, parentId) {
  const ordered = {}
  for (const [key, value] of Object.entries(session)) {
    if (key === 'parentSessionId') continue
    if (key === 'snapshot' && parentId) ordered.parentSessionId = parentId
    ordered[key] = value
  }
  if (parentId && !('parentSessionId' in ordered)) ordered.parentSessionId = parentId
  ordered.revision = (Number.isInteger(session.revision) ? session.revision : 0) + 1
  return ordered
}
