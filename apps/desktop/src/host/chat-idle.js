/**
 * 闲置宿主的回收判定。
 *
 * 每个页签的 app-server 是常驻进程（一个进程约 50–270MB），而它只在有轮次、压缩、
 * 排队消息或后台线程时才真正干活。开着不用的页签会一直占着内存，一天下来能堆到
 * 好几百 MB —— 在这台 swap 已经用满的机器上这是实打实的代价。
 *
 * 回收的边界：
 * - 任何「正在干活」的宿主都不碰（轮次、压缩、中止、排队、btw 线程）；
 * - 永远留至少 `minKeep` 个宿主，按最近活动时间取最新的。插件只载在会话宿主里
 *   （手机桥、定时循环），全收干净会让它们凭空停摆；
 * - 只在没有活动超过 `idleMs` 之后才收。收掉之后用户再发消息，宿主按需重新 spawn，
 *   代价是那一句话多等一次冷启动。
 */
export const IDLE_REAP_MS = 30 * 60 * 1000

/** 硬上限：闲置再久也至少留这么多宿主（见下方 `maxKeep` 的取舍）。 */
export const IDLE_MAX_KEEP = 3

export function resolveIdleReap(
  entries,
  now,
  { idleMs = IDLE_REAP_MS, minKeep = 1, maxKeep = Infinity } = {}
) {
  if (!Array.isArray(entries) || entries.length === 0) return []
  const alive = entries.filter((entry) => isAlive(entry?.run))
  if (alive.length <= minKeep) return []
  // 最近活动过的那几个先保住：用户刚切走又切回来是常态，不该在这里吃一次冷启动。
  const ordered = alive.slice().sort((left, right) => activityAt(right.run) - activityAt(left.run))
  const reap = []
  for (let index = minKeep; index < ordered.length; index += 1) {
    const entry = ordered[index]
    if (isBusy(entry)) continue
    // 超过 `maxKeep` 的那几个不看闲置时长：进程数量本身就是代价（每个 50–270MB），
    // 而插件只活在最近活动的宿主里，多留几个只是白占内存。
    if (index < maxKeep && now - activityAt(entry.run) < idleMs) continue
    reap.push(entry.id)
  }
  return reap
}

// 与 chat-warm 的判据一致：stdin 可写表示宿主还能接 turn。
function isAlive(run) {
  return run?.child?.stdin?.writable === true
}

function activityAt(run) {
  const at = Number(run?.lastActivityAt)
  return Number.isFinite(at) ? at : 0
}

function isBusy(entry) {
  const run = entry?.run
  if (!run) return true
  if (run.running || run.compacting || run.aborting) return true
  if (run.currentTurnId) return true
  if (run.hostPending?.length) return true
  if (run.btwBusyThreads?.size) return true
  if ((entry.queuedCount || 0) > 0) return true
  return false
}
