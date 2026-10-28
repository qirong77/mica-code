/**
 * 常驻 host 进程在应答某个请求之前就退出时的结算。
 *
 * 两类请求要分开处理：
 * - 带了 `resolve` 的（`chat:edit-message` 这类 IPC 往返）：直接回失败，别让调用方一直
 *   等到自己的超时，界面上的编辑框/按钮会一直转。
 * - `turn/start` / `turn/steer`：消息**从未**进入 host 队列，渲染层必须撤回乐观气泡。
 *   否则那条消息看起来"已发送"，会话文件里却永远没有它，双击编辑时还会撞上"找不到要
 *   编辑的消息"—— 用户完全看不出真正的原因是这一轮根本没跑起来。
 */
export function settlePendingHostRequests(run, message) {
  const rejectedTurns = []
  const pending = run?.pendingRequests
  if (!pending || typeof pending.values !== 'function') return { rejectedTurns }
  const entries = [...pending.values()]
  pending.clear()
  for (const entry of entries) {
    if (!entry) continue
    if (typeof entry.resolve === 'function') {
      entry.resolve({ ok: false, error: message })
      continue
    }
    if (entry.method !== 'turn/start' && entry.method !== 'turn/steer') continue
    rejectedTurns.push({
      method: entry.method,
      clientMessageId: entry.params?.clientMessageId || null,
      text: entry.params?.input?.[0]?.text || null
    })
  }
  return { rejectedTurns }
}
