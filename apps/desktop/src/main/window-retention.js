/**
 * 远程运行时窗口：隐藏后保留两小时，再释放 renderer。
 *
 * 切换服务器不再重载页面 —— 每台运行时各有一个常驻窗口，切走只是隐藏，切回来是瞬回。
 * 保活要有上限，否则连过的机器越多，后台就越多份完整页面（每份是一个 renderer 进程）。
 * 两小时足够覆盖「来回切着干活」，午休或过夜后回来重载一次可以接受。
 */
export const REMOTE_WINDOW_RETENTION_MS = 2 * 60 * 60 * 1000

export function retainHiddenWindow(
  win,
  { retentionMs = REMOTE_WINDOW_RETENTION_MS, schedule = setTimeout, cancel = clearTimeout } = {}
) {
  let timer = null
  const clear = () => {
    if (timer !== null) cancel(timer)
    timer = null
  }
  const onHide = () => {
    // 重复 close/hide 不延长期限；只有再次显示才续期。
    if (timer !== null || win.isDestroyed() || win.isVisible()) return
    timer = schedule(() => {
      timer = null
      if (!win.isDestroyed() && !win.isVisible()) win.destroy()
    }, retentionMs)
    timer?.unref?.()
  }
  const dispose = () => {
    clear()
    win.removeListener('hide', onHide)
    win.removeListener('show', clear)
    win.removeListener('closed', dispose)
  }
  win.on('hide', onHide)
  win.on('show', clear)
  win.on('closed', dispose)
  return dispose
}
