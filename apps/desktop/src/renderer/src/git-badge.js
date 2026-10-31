/**
 * 顶栏 Git 徽标（编辑器图标右边那对红绿数字）的显示规则。
 *
 * 要解决的问题是行数会失控：一次生成物改写、一次依赖重装就是五位数，
 * 原样贴上去会把顶栏撑坏。所以千位以上一律缩写，单侧最多 6 个字符
 * （`+999`、`+1.2k`、`+12k`、`+999k`、`+1.2M`），精确值放进 tooltip ——
 * 不丢信息，也不让徽标变成第二个需要眯着眼读的地方。
 *
 * 统计口径与 GIT 面板一致（相对 HEAD 的工作区变更，含未跟踪文件），
 * 因此徽标上的数字和面板里的合计永远对得上。
 */

const KILO = 1000
const MEGA = 1000 * 1000

/** 一位小数；向上进位会虚报变更量，所以先向下截断再补格式。 */
function tenths(value) {
  const floored = Math.floor(value * 10) / 10
  return Number.isInteger(floored) ? String(floored) : floored.toFixed(1)
}

/** tooltip 里的精确值：千位分组，读得出「到底多少行」。 */
function grouped(value) {
  return Math.floor(value).toLocaleString('en-US')
}

/**
 * 行数缩写。
 *
 * - 千位以下保持精确：`999` 本来就是能一眼读完的量级；
 * - 一千到十万留一位小数（`1.2k`），十万以上只留整数（`12k`）——
 *   到那个量级小数点已经没人关心，宽度才是稀缺的；
 * - 百万进位到 `M`，否则 `999k` 之后会冒出一串更长的数字。
 *
 * 全部向下取整：宁可少报一点，也不要把 12,345 说成 `12.4k`。
 */
export function formatGitCount(value) {
  const count = Math.max(0, Math.floor(Number(value) || 0))
  if (count < KILO) return String(count)
  if (count < 10 * KILO) return `${tenths(count / KILO)}k`
  if (count < MEGA) return `${Math.floor(count / KILO)}k`
  if (count < 10 * MEGA) return `${tenths(count / MEGA)}M`
  return `${Math.floor(count / MEGA)}M`
}

/**
 * 徽标内容；返回 `null` 表示「不画」（工作区干净）。
 *
 * `additions` / `deletions` 为 `null` 的那一侧不画：`+0` 只是噪声。
 * 两边都是 0 但确实有文件变更时（改权限、二进制、纯重命名）退回落成文件数，
 * 否则会出现「明明改了东西，图标旁边却什么都没有」。
 */
export function gitChangeBadge(counts) {
  const additions = Math.max(0, Math.floor(Number(counts?.additions) || 0))
  const deletions = Math.max(0, Math.floor(Number(counts?.deletions) || 0))
  const files = Math.max(0, Math.floor(Number(counts?.files) || 0))
  if (!additions && !deletions && !files) return null
  const hasLines = additions > 0 || deletions > 0
  const title = [`${files} 个文件已更改`]
  if (hasLines) {
    const lines = []
    if (additions > 0) lines.push(`+${grouped(additions)}`)
    if (deletions > 0) lines.push(`−${grouped(deletions)}`)
    title.push(`${lines.join(' ')} 行`)
  }
  return {
    additions: additions > 0 ? `+${formatGitCount(additions)}` : null,
    deletions: deletions > 0 ? `−${formatGitCount(deletions)}` : null,
    fallback: hasLines ? null : `${files} 个文件`,
    title: title.join(' · ')
  }
}
