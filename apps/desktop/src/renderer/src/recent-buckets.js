// Recent 分区按「最近更新」排，一屏几十条会话排下来只有行尾的 1h / 昨天 / 3d 这些零散时间，
// 想找「上周那件」只能一行行扫。这里把它切成 今天 / 昨天 / 近七天 / 更早，让时间顺序本身
// 成为可读的分段——排序规则不变（仍是 updatedAt 降序），只是把同一档的时间聚在一起。
//
// 分桶只按「根会话」切：派生会话（子会话、fork）永远跟在它的父会话下面，跨桶拆开会让
// 「结构」和「时间」互相打架（子会话可能比父会话晚很多天）。
const DAY_MS = 24 * 60 * 60 * 1000

export const RECENT_BUCKET_LABELS = ['今天', '昨天', '近七天', '更早']

/** 本地时区的当天 0 点：用户说的「今天」是本地日，不是 UTC 日。 */
function startOfDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 0 = 今天，1 = 昨天，2 = 近七天，3 = 更早；时间戳缺失或非法一律算更早。 */
export function recentBucketOf(updatedAtMs, now = Date.now()) {
  const value = Number(updatedAtMs)
  if (!Number.isFinite(value) || value <= 0) return 3
  const today = startOfDay(now)
  if (value >= today) return 0
  if (value >= today - DAY_MS) return 1
  if (value >= today - 6 * DAY_MS) return 2
  return 3
}

/**
 * 给 `nestSessions` 的输出插入分桶标题。
 *
 * 输入是带 `depth` 的扁平行（父在前、子在后），输出是 `{ kind: 'label' | 'row' }` 的序列：
 * 只在根行（`depth === 0`）处切桶，且同一个桶只插一次；空数组不产生任何标题。
 */
export function groupRecentRows(rows = [], now = Date.now()) {
  const blocks = []
  let current = -1
  for (const row of rows) {
    const depth = row?.depth ?? 0
    if (depth === 0) {
      const bucket = recentBucketOf(row?.session?.updatedAtMs, now)
      if (bucket !== current) {
        current = bucket
        blocks.push({ kind: 'label', label: RECENT_BUCKET_LABELS[bucket], bucket })
      }
    }
    blocks.push({ kind: 'row', row })
  }
  return blocks
}
