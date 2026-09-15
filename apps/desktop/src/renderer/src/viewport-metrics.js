/**
 * 从 visualViewport 快照算出窄屏根容器要的可见区高度与位移（供 hooks.js 写进
 * `--vvh` / `--vvh-top`，测试也走这里）。
 *
 * 高度按 `scale` 还原成布局像素：双指缩放同样会让 visualViewport 变小，但那不是键盘，
 * 根容器不需要跟着缩（缩放时高度不变）。
 *
 * 位移是 iOS 弹软键盘时为露出被聚焦的输入框而对布局视口做的整体上移
 * （`visualViewport.offsetTop`），必须补偿，否则应用会偏出屏幕上方、底部空出一块。
 * 缩放时的同一个值来自用户平移而不是键盘，套用会把应用推离布局原点，所以只在未缩放
 * 时取。
 */
const UNZOOMED_EPSILON = 0.02

export function viewportMetrics(viewport) {
  if (!viewport) return null

  const scale = viewport.scale || 1
  const height = Math.round(viewport.height * scale)
  const top =
    Math.abs(scale - 1) < UNZOOMED_EPSILON ? Math.max(0, Math.round(viewport.offsetTop || 0)) : 0

  return { height, top }
}
