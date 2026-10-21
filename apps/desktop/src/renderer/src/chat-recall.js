/**
 * 排队消息「撤回」该怎么落地。
 *
 * 排队行有两种来源：host 确认过的（`mica/queue/queued` / 本地 after_turn 槽）
 * 和渲染层还没拿到确认的乐观行（`pending`）。两者都必须能撤回，否则一旦确认
 * 通知没回来，界面上就留下一条既发不出去也撤不回的占位。
 *
 * 判定顺序：
 * - 撤回成功 → `restore`：摘掉这一行，原文放回输入框。
 * - host 明确回答队列里还有它 → `keep`：原样保留排队态并报错（用户可再试）。
 * - host 回答队列里没有它：turn 还在跑说明已经开始发送（`sent`，解除排队标记、
 *   留在对话里）；没有 turn 在跑说明这条根本没发出去，`restore` 交回输入框。
 * - 拿不到队列快照（host 请求失败）：确认过的行保守保留，乐观行按未发出处理。
 */
export function resolveQueueRecall({ id, pending, ok, queuedItems, runActive }) {
  if (ok) return 'restore'
  if (Array.isArray(queuedItems)) {
    if (queuedItems.some((item) => item?.id === id)) return 'keep'
    return runActive ? 'sent' : 'restore'
  }
  return pending ? 'restore' : 'keep'
}
