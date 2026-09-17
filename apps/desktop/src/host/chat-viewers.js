/**
 * Chat run 的「按 session 附着」纯逻辑。
 *
 * `runs` 以「创建这个 run 的 chat 节点 id」为 key，而 chat 节点是每个页面/窗口冷启动时
 * 随机生成的（renderer 的 createColdStartTerminal）：同一个会话在第二个页签打开时，那个
 * 页签的 node id 找不到 run。但 run 本身是**会话级资源**——所有客户端共享同一份 SSE 广播
 * （web 运行时的 `event.sender` 是进程内单例），所以缺的只是把事件按 session 认领回来，
 * 让第二个页签成为这个 run 的**观察者**而不是「什么都看不见」。
 *
 * 这里只放可单测的判定，进程管理与收发留在 chat.js。
 */

/** 观察者多久没露面就算走了（渲染层每 3s 复查一次 is-running，用它的心跳）。 */
export const VIEWER_TTL_MS = 45_000
/** 回收扫描间隔。 */
export const VIEWER_SWEEP_MS = 60_000
/** 所有权转让过、观察者也全走了的 run：在跑的 turn 给一段宽限期再回收。 */
export const TRANSFERRED_REAP_GRACE_MS = 30 * 60_000

export function runSessionId(run) {
  return run?.sessionId || run?.requestedSessionId || null
}

/** run 的所有者：默认是创建它的节点，所有权转让后是接手观察者的节点。 */
export function ownerIdOf(keyId, run) {
  return run?.ownerId || keyId
}

/** 观察者露面。自己不算自己的观察者，否则回收判定会把所有者自己当成看着的人。 */
export function touchViewer(run, keyId, nodeId, now = Date.now()) {
  if (!run || !nodeId || ownerIdOf(keyId, run) === nodeId) return
  if (!run.viewers) run.viewers = new Map()
  run.viewers.set(nodeId, now)
}

export function liveViewerIds(run, { now = Date.now(), ttl = VIEWER_TTL_MS } = {}) {
  const viewers = run?.viewers
  if (!viewers?.size) return []
  const live = []
  for (const [id, at] of viewers) if (now - (Number(at) || 0) <= ttl) live.push(id)
  return live
}

/** 清掉超时观察者（它们只在回收判定里起作用），返回还活着的。 */
export function pruneViewers(run, { now = Date.now(), ttl = VIEWER_TTL_MS } = {}) {
  const viewers = run?.viewers
  if (!viewers?.size) return []
  for (const [id, at] of viewers) if (now - (Number(at) || 0) > ttl) viewers.delete(id)
  return [...viewers.keys()]
}

/**
 * 哪个 run 持有这个 session：优先「正在跑」的那个，否则第一个空闲的。
 * `excludeId` 是提问者自己的 node id（本节点已经通过 `runs.get(id)` 找过了）。
 */
export function findRunForSession(runs, sessionId, excludeId) {
  if (!sessionId) return null
  let idle = null
  for (const [id, run] of runs) {
    if (id === excludeId) continue
    if (runSessionId(run) !== sessionId) continue
    if (run.running) return { id, run }
    if (!idle) idle = { id, run }
  }
  return idle
}

/** 所有权已经转给这个节点、但 `runs` 的 key 还是原来那个节点的 run。 */
export function findRunByOwnerId(runs, nodeId) {
  if (!nodeId) return null
  for (const [id, run] of runs) {
    if (id === nodeId) continue
    if (ownerIdOf(id, run) === nodeId) return { id, run }
  }
  return null
}

/**
 * `chat:dispose(nodeId)` 该怎么处理这个 run：
 * - 不是所有者 → `detach`：观察者关页签只摘掉自己，不动别人的 run；
 * - 所有者走人但还有活着的观察者 → `transfer`：所有权交给最近露面的那个，而不是把
 *   还在跑的 turn 一起杀掉（正在看的那个人应该能看完这一轮）；没有观察者时交给
 *   回收扫描兜底；
 * - 其余 → `dispose`。
 */
export function planRunRelease({
  keyId,
  nodeId,
  ownerId,
  viewers,
  now = Date.now(),
  ttl = VIEWER_TTL_MS
}) {
  if ((ownerId || keyId) !== nodeId) return { action: 'detach', keyId }
  const live = []
  for (const [id, at] of viewers || []) {
    if (id === nodeId) continue
    if (now - (Number(at) || 0) <= ttl) live.push(id)
  }
  if (live.length === 0) return { action: 'dispose', keyId }
  let nextOwnerId = live[0]
  for (const id of live) {
    if ((viewers.get(id) || 0) > (viewers.get(nextOwnerId) || 0)) nextOwnerId = id
  }
  return { action: 'transfer', keyId, nextOwnerId }
}

/** 所有权转让过的 run：观察者全走了就回收，否则常驻 app-server 会一直挂着。 */
export function shouldReapTransferredRun(
  run,
  { now = Date.now(), ttl = VIEWER_TTL_MS, graceMs = TRANSFERRED_REAP_GRACE_MS } = {}
) {
  const transferredAt = Number(run?.ownerTransferredAt) || 0
  if (!transferredAt) return false
  if (liveViewerIds(run, { now, ttl }).length > 0) return false
  // 在跑的 turn 给它跑完：中途 kill 会让这一轮既不落盘也看不到结果。
  if (run.running && now - transferredAt < graceMs) return false
  return true
}
