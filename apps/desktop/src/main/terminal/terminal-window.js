/**
 * 终端控制的后台窗口。
 *
 * 一个会话一个窗口，默认隐藏创建：AI 先在后台把命令跑起来，需要人看的时候再 show
 * （用户点关闭也只是隐藏，PTY 与滚动内容都还在）。窗口里加载的是运行时托管的终端页面
 * ——页面和 AI 一样通过 HTTP + SSE 访问终端服务，所以不需要 preload、也不注册外壳业务
 * IPC。外壳在这里只做「开窗口」这一件只有主进程能做的事。
 */

import { BrowserWindow } from 'electron'

const DEFAULT_SIZE = { width: 1000, height: 680 }
const MIN_SIZE = { width: 420, height: 240 }

export function createTerminalWindows({
  getPageUrl,
  isQuitting = () => false,
  onVisibleChange = () => {}
} = {}) {
  const windows = new Map()

  function terminalUrl(sessionId) {
    return String(getPageUrl?.(sessionId) || '').trim()
  }

  function load(record, attempt = 0) {
    if (record.win.isDestroyed() || record.destroyRequested) return
    const url = terminalUrl(record.sessionId)
    if (!url) {
      // 运行时还没起来：等它就绪后再加载，别把一个空白窗口留在那
      if (attempt < 20) setTimeout(() => load(record, attempt + 1), 500)
      return
    }
    record.win.loadURL(url).catch((error) => {
      // 运行时可能正在重启；页面自己的 SSE 会自动重连，这里只留一条日志并重试
      if (record.win.isDestroyed()) return
      console.warn('[mica-terminal] 终端页面加载失败', error?.code || error)
      if (attempt < 20) setTimeout(() => load(record, attempt + 1), 1000)
    })
  }

  function create(session, { show = false, focus = false } = {}) {
    const win = new BrowserWindow({
      ...DEFAULT_SIZE,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      autoHideMenuBar: true,
      title: `终端 · ${session.label}`,
      backgroundColor: '#2b2b2b',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })

    // 多个终端窗口错开一点，别叠成一摞看不出有几个
    const offset = Math.min(windows.size, 6) * 26
    if (offset) {
      const bounds = win.getBounds()
      win.setBounds({ ...bounds, x: bounds.x + offset, y: bounds.y + offset })
    }

    const record = {
      sessionId: session.id,
      win,
      visible: false,
      destroyRequested: false
    }
    windows.set(session.id, record)

    win.on('close', (event) => {
      // 用户点关闭 = 隐藏；应用退出或显式 closeSession 才真的销毁
      if (isQuitting() || record.destroyRequested) return
      event.preventDefault()
      hide(session.id)
    })

    win.on('closed', () => {
      windows.delete(session.id)
      if (record.visible) {
        record.visible = false
        onVisibleChange(session.id, false)
      }
    })

    win.on('show', () => {
      record.visible = true
      onVisibleChange(session.id, true)
    })

    win.on('hide', () => {
      record.visible = false
      onVisibleChange(session.id, false)
    })

    load(record)
    if (show) showWindow(record, { focus })
    return record
  }

  function ensure(session, { show = false, focus = false } = {}) {
    const existing = windows.get(session.id)
    const record =
      existing && !existing.win.isDestroyed() ? existing : create(session, { show, focus })
    if (show) showWindow(record, { focus })
    return record
  }

  function showWindow(record, { focus = false } = {}) {
    if (!record || record.win.isDestroyed()) return
    record.win.show()
    if (focus) record.win.focus()
  }

  function show(sessionId, { focus = true } = {}) {
    const record = windows.get(sessionId)
    showWindow(record, { focus })
  }

  function hide(sessionId) {
    const record = windows.get(sessionId)
    if (!record || record.win.isDestroyed()) return
    record.win.hide()
  }

  function destroy(sessionId) {
    const record = windows.get(sessionId)
    if (!record) return
    windows.delete(sessionId)
    if (record.win.isDestroyed()) return
    record.destroyRequested = true
    record.win.destroy()
  }

  function destroyAll() {
    for (const [sessionId, record] of [...windows.entries()]) {
      windows.delete(sessionId)
      if (record.win.isDestroyed()) continue
      record.destroyRequested = true
      record.win.destroy()
    }
  }

  return { ensure, show, hide, destroy, destroyAll }
}
