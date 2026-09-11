import { readFileSync } from 'node:fs'
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
    if (typeof sessionId !== 'string' || !sessionId) return false
    let owner
    try {
      owner = JSON.parse(readFile(join(lockDir(), `${sessionId}.lock`)))
    } catch {
      // 没有锁文件 / 内容损坏都按「无人持有」处理，与回收逻辑一致。
      return false
    }
    return isAlive(owner?.pid)
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
