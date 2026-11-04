import { relativeTimeShort } from '@packages/mica-web-shared/index.js'

export { relativeTimeShort }

/**
 * 归档型分区（Recent 之外的 Pinned / Projects）只给这段时间内活跃过的时间。
 *
 * 那些分区里躺的是长期归档的会话，一行「15d」「4d」既不说明什么，又把整列时间挤成噪声；
 * 更早的只留条数，具体时刻挂在行的 tooltip 上。Recent 本身按最近更新排序，时间就是它的
 * 语义，不受这条限制。
 */
export const ACTIVE_WINDOW_MS = 86_400_000

/** 24 小时内活跃过才给相对时间，否则空串。 */
export function activeTimeLabel(timestamp, now = Date.now()) {
  const at = Number(timestamp) || 0
  if (!at || now - at > ACTIVE_WINDOW_MS) return ''
  return relativeTimeShort(at, now)
}
