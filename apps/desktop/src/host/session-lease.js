import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

/**
 * 一个进程是否还活着。与 packages/mica-session/sessionStore.ts 的孤儿锁回收同源：
 * 只有 ESRCH 才是「不存在」，EPERM 等其它错误说明进程还在（只是不归我们管）。
 */
export function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

/**
 * turn lease 存活探测。mica 每个运行中的 turn 会在 `sessions/.turn-locks/<id>.lock`
 * 写入持有者 pid；pid 仍存活说明这一轮真的由某个进程跑着（本应用的 chat host，
 * 或另一终端里的 TUI），session 文件里的 `turnState: "running"` 就不是崩溃残留。
 */
export function createTurnLeaseProbe({
  lockDir,
  isAlive = isPidAlive,
  readFile = (path) => readFileSync(path, 'utf8')
}) {
  if (typeof lockDir !== 'function') throw new TypeError('lockDir must be a function')

  return function hasLiveTurnLease(sessionId) {
    const owner = readTurnLeaseOwner(sessionId, { lockDir, readFile })
    return owner ? isAlive(owner.pid) : false
  }
}

/**
 * 读出 turn lease 的持有者（`{ pid, token, createdAt }`），没有锁文件或内容损坏返回 null。
 * 需要知道「谁在跑」时用它：桌面的 host 自己从不取 lease（它的 turn 由 spawn 出去的
 * app-server 子进程持有），因此只看 pid 与存活即可判断是不是别的进程在写这个会话。
 */
export function readTurnLeaseOwner(
  sessionId,
  { lockDir, readFile = (path) => readFileSync(path, 'utf8') } = {}
) {
  if (typeof sessionId !== 'string' || !sessionId) return null
  if (typeof lockDir !== 'function') return null
  try {
    const owner = JSON.parse(readFile(join(lockDir(), `${sessionId}.lock`)))
    return owner && typeof owner === 'object' ? owner : null
  } catch {
    // 没有锁文件 / 内容损坏都按「无人持有」处理，与回收逻辑一致。
    return null
  }
}

/** A lease we could not take because someone else holds it. */
export function turnLeaseBusyError() {
  const error = new Error('turn lease is held by another process')
  error.code = 'TURN_LEASE_BUSY'
  return error
}

/**
 * 短时持有 turn lease 去做一次直接改盘。
 *
 * 「先看有没有人持有、再写盘」之间有窗口：刚起的一轮会把内存快照整份覆盖回去，
 * 用户拖出来的层级就白拖了。这里与 `mica-session` 的 turn lease 用同一份格式与
 * 抢占方式（`wx` 创建、只有持有者 pid 已死才算孤儿），所以跑着的宿主与这次写
 * 之间必然分出一个胜负，而不是两边都以为自己赢。
 *
 * 自己的 lease 按 token 释放：绝不删别人的锁。
 */
export function createTurnLeaseRunner({ lockDir, isAlive = isPidAlive }) {
  if (typeof lockDir !== 'function') throw new TypeError('lockDir must be a function')

  return function withTurnLease(sessionId, run) {
    const directory = lockDir()
    mkdirSync(directory, { recursive: true })
    const lockPath = join(directory, `${sessionId}.lock`)
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    for (let attempt = 0; attempt < 2; attempt++) {
      let fd
      try {
        fd = openSync(lockPath, 'wx')
      } catch (error) {
        if (error?.code !== 'EEXIST' || attempt > 0 || !removeStaleLease(lockPath, isAlive)) {
          throw turnLeaseBusyError()
        }
        continue
      }
      try {
        writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
          'utf8'
        )
      } finally {
        closeSync(fd)
      }
      try {
        return run()
      } finally {
        releaseOwnLease(lockPath, token)
      }
    }
    throw turnLeaseBusyError()
  }
}

/** 与 `mica-session` 的孤儿回收同一条判定：只有持有者 pid 已死才回收。 */
function removeStaleLease(lockPath, isAlive) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (!owner || typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0)
      return false
    if (isAlive(owner.pid)) return false
    rmSync(lockPath, { force: true })
    return true
  } catch {
    // 内容损坏可能正好撞上别人写入的那一刻：按 mtime 判定，别抢新锁。
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < 30_000) return false
      rmSync(lockPath, { force: true })
      return true
    } catch {
      return false
    }
  }
}

function releaseOwnLease(lockPath, token) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (owner?.token === token) rmSync(lockPath, { force: true })
  } catch {
    // Never remove a lock unless its token proves that we own it.
  }
}

/**
 * 一轮有没有「正常跑完」，供侧栏的红色指示灯使用：
 * - error：上一轮以错误收尾；
 * - running 且无人持有 turn lease：进程被中断/崩溃留下的残留（持有者还活着说明另有进程
 *   正在跑这一轮，例如另一个终端里的 TUI，不能误标成异常）；
 * - aborted（用户主动中断）与 completed 都算正常，不点红灯。
 *
 * `hasLiveTurnLease` 只在 running 时调用，避免给每个会话都去读锁文件。
 */
export function isInterruptedSession(row, hasLiveTurnLease) {
  if (row?.turnState === 'error') return true
  if (row?.turnState !== 'running') return false
  return !hasLiveTurnLease(row.id)
}
