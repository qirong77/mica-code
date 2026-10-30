/**
 * 常驻宿主预热：决定要不要为这个节点真的启动一个 app-server。
 *
 * 预热的目的只有一个——「App 开着就至少有一个宿主」。插件（mobile-relay 的桥、定时
 * 循环等）只载在会话宿主里，而宿主是按需 spawn 的：重启桌面端后只要没人发消息就没有
 * 宿主，桥随之停摆，手机端看到「暂时不可用」。所以这里不追求「每个页签都预热」：
 * 只要还有别的宿主活着就直接跳过，内存不随页签数增长。
 *
 * 返回：
 * - `reused`：这个节点自己就有活着的宿主，只需换一下事件的接收方；
 * - `skipped`：别的节点已经养着宿主，不需要再起一个；
 * - `spawn`：一个活着的宿主都没有，该起了。
 */
export function resolveWarmAction(runs, nodeId) {
  if (!nodeId || !runs?.get) return 'spawn'
  const current = runs.get(nodeId)
  if (isAlive(current)) return 'reused'
  for (const run of runs.values()) {
    if (isAlive(run)) return 'skipped'
  }
  return 'spawn'
}

// stdin 可写就是宿主还能接 turn 的判据，与 ensureBtwRun / ensureCapabilityRun 一致。
function isAlive(run) {
  return run?.child?.stdin?.writable === true
}
