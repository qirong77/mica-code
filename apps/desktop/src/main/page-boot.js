/**
 * 窗口里「页面到底起来没有」的判定与自救节奏。
 *
 * 判定只有渲染层答得上：外壳看不到页面内部，只能问一句。自救按**地址**记额度 —— 同一个
 * 地址只自动重载一次、只提示一次。这一条是必需的：有的页面自己会定时重载（中转机在
 * 目标机器离线时给的就是「5 秒后自动重试」那一页），每次重载都会重新走一遍探测，不设门槛
 * 的话一次失败之后那个模态框会一直往下弹。
 */

/**
 * 页面此刻是什么状态：
 * - `booted`：脚本跑过、`window.mica` 已装上（正常）
 * - `page`：页面在显示自己的东西 —— Mica 自己的报错页（`#root` 有内容），或者压根不是
 *   Mica 页面的静态页（中转机的「暂时不可用」页 / 口令页 / 选机器页）。这类页面自己会
 *   把状况说清楚，别当成「没起来」去重载
 * - `blank`：什么都没有 —— 新建窗口首次加载偶发失败时就是这个样子：导航其实「成功」了，
 *   `did-finish-load` 照常触发、`document.readyState` 也是 complete，但页面停在
 *   空白状态，窗口只剩自己的底色（`#0e0e0e`），看上去就是一块黑屏
 *
 * 这种状态只有问渲染层才知道（`executeJavaScript` 走页面主世界，不需要 preload）。
 */
export const PAGE_STATE_PROBE = `(() => {
  if (typeof window.mica === 'object') return 'booted'
  const root = document.getElementById('root')
  if (root && root.children.length > 0) return 'page'
  return document.body && String(document.body.innerText || '').trim() ? 'page' : 'blank'
})()`

/**
 * 一个窗口的自救额度。`next(target)` 每次加载失败时问一句该做什么：
 * - `reload`：这个地址还没重载过，就地重载一次
 * - `report`：重载过了还是不行，如实告诉用户（同一个地址只报一次）
 * - `ignore`：这个地址已经报过，别再弹了
 *
 * 页面真的起来时调 `recovered()` 把额度还回去，之后再出问题还能重载、还能再报一次。
 */
export function createBootGuard() {
  // 记的是集合而不是「上一个地址」：窗口会在页面内换路径，来回切时会交替着失败，
  // 只记最后一条的话 A→B→A 就能无限重载。
  const reloaded = new Set()
  const reported = new Set()
  const remember = (set, target) => {
    set.add(target)
    // 长会话里窗口会走过不少地址，留最近一小批就够（被挤掉的地址最多再被照顾一次）
    if (set.size > 32) set.delete(set.values().next().value)
  }
  return {
    next(target) {
      if (!target) return 'ignore'
      if (!reloaded.has(target)) {
        remember(reloaded, target)
        return 'reload'
      }
      if (reported.has(target)) return 'ignore'
      remember(reported, target)
      return 'report'
    },
    recovered() {
      reloaded.clear()
      reported.clear()
    }
  }
}
