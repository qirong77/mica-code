/**
 * 从 visualViewport 与布局视口的快照算出窄屏根容器要的可见区高度与位移（供 hooks.js
 * 写进 `--vvh` / `--vvh-top`，测试也走这里）。
 *
 * 高度优先取 visualViewport（正常情况下它是唯一跟着软键盘缩的值），按 `scale` 还原成
 * 布局像素：双指缩放同样会让它变小，但那不是键盘，根容器不需要跟着缩（缩放时高度不变）。
 *
 * 但这条链子在真机上并不总是成立 —— iOS 26 起键盘弹起时 visualViewport 的高度可能压根
 * 不变（WebKit 的已知回归），反倒是不跟键盘走的布局视口（`window.innerHeight` /
 * `documentElement.clientHeight`）矮了一截。所以两个信号都看，取**明显更小**的那个当
 * 可见区高度：只要有一个信号说「屏幕矮了一截」，就把输入条让上来。差得不多（不到一个
 * 键盘的量级，见 KEYBOARD_MIN_INSET）就不认，避免 iOS 上十几二十几像素的视口抖动把应用
 * 整体缩出一截空白。
 *
 * 位移是 iOS 弹软键盘时为露出被聚焦的输入框而对布局视口做的整体上移
 * （`visualViewport.offsetTop`），必须补偿，否则应用会偏出屏幕上方、底部空出一块。
 *
 * 但只该在**高度确实把键盘算了进去**（应用已经比布局视口矮了一截）时才补偿：那时应用
 * 正好铺满可见区，那次上移只会把应用推出屏幕。反过来，高度没算进键盘时（上面那条回归
 * 路径也没救回来），那次上移正是把底部输入条露出来的那一步，抵消掉等于亲手把输入条推到
 * 键盘底下 —— 此时宁可让应用按 iOS 自己的节奏上移。拿不到布局视口信息时按老规矩补偿。
 *
 * 缩放时的同一个值来自用户平移而不是键盘，套用会把应用推离布局原点，所以只在未缩放时取。
 */
const UNZOOMED_EPSILON = 0.02

/** 布局视口比可见区至少矮这么多，才算「这一截是键盘」。 */
const KEYBOARD_MIN_INSET = 80

export function viewportMetrics(viewport, layout = {}) {
  if (!viewport) return null

  const scale = viewport.scale || 1
  const visual = Math.round(viewport.height * scale)
  if (!(visual > 0)) return null

  const layoutHeights = [layout.innerHeight, layout.clientHeight].filter(
    (value) => Number.isFinite(value) && value > 0
  )
  const layoutHeight = layoutHeights.length ? Math.min(...layoutHeights) : 0

  const height =
    layoutHeight > 0 && visual - layoutHeight >= KEYBOARD_MIN_INSET ? layoutHeight : visual
  const keyboardAccounted = layoutHeight > 0 ? layoutHeight - height >= KEYBOARD_MIN_INSET : true
  const shift =
    Math.abs(scale - 1) < UNZOOMED_EPSILON ? Math.max(0, Math.round(viewport.offsetTop || 0)) : 0

  return { height, top: keyboardAccounted ? shift : 0 }
}
