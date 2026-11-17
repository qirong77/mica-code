/** Never infer an impression from a view request or an offscreen/preloaded page. */
export function observePluginSurface(element, track, surface, { document: doc = document, Observer = globalThis.IntersectionObserver } = {}) {
  if (!element || typeof track !== 'function') return () => {}
  let seen = false
  let intersecting = false
  const impression = () => {
    if (seen || !intersecting || doc.visibilityState !== 'visible' || !doc.hasFocus()) return
    seen = true
    track('impression', { surface, action: 'view' })
  }
  // Without visibility-v2 there is no evidence that an overlay isn't covering
  // the plugin. Keep clicks, but do not invent an exposure denominator.
  let observer = null
  try {
    observer = Observer ? new Observer((entries) => {
      intersecting = entries.some((entry) => entry.target === element && entry.isIntersecting && entry.isVisible === true)
      impression()
    }, { trackVisibility: true, delay: 100 }) : null
    observer?.observe(element)
  } catch { observer = null /* visibility-v2 is optional, never break a plugin page */ }
  const clicked = (event) => {
    if (doc.visibilityState === 'visible' && doc.hasFocus() && event.target?.closest?.('button,a,[role="button"]'))
      track('click', { surface, action: 'activate' })
  }
  doc.addEventListener('visibilitychange', impression)
  globalThis.addEventListener?.('focus', impression)
  element.addEventListener('click', clicked, true)
  return () => {
    observer?.disconnect()
    doc.removeEventListener('visibilitychange', impression)
    globalThis.removeEventListener?.('focus', impression)
    element.removeEventListener('click', clicked, true)
  }
}
