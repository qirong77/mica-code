/**
 * 普通 URL 窗口。
 *
 * 这类窗口不是 Mica 主窗口，也不是受控浏览器或插件浮窗：只装载一个 HTTP(S) 地址，
 * 不注入 preload，不加入主窗口集合。用户点关闭时不拦截 close 事件，Electron 会直接销毁
 * 窗口；这里只保留一份引用，方便应用退出时收尾。
 */

const DEFAULT_SIZE = { width: 1280, height: 800 }
const MIN_SIZE = { width: 900, height: 560 }

export function createUrlWindows({
  BrowserWindow,
  backgroundColor,
  openExternal = null,
  onError = console.warn
} = {}) {
  const windows = new Set()

  function open(target) {
    const url = httpUrl(target)
    const win = new BrowserWindow({
      ...DEFAULT_SIZE,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      autoHideMenuBar: true,
      title: 'Mica Code',
      backgroundColor: typeof backgroundColor === 'function' ? backgroundColor() : backgroundColor,
      // 不设置 titleBarStyle / preload，保持普通原生窗口和普通网页上下文。
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    windows.add(win)
    win.on('closed', () => windows.delete(win))
    win.on('ready-to-show', () => showWindow(win))
    // 网页自己请求新窗口时交给系统浏览器，避免普通 URL 窗口递归创建应用窗口。
    win.webContents.setWindowOpenHandler((details) => {
      if (openExternal && /^(https?:|mailto:)/i.test(details.url)) openExternal(details.url)
      return { action: 'deny' }
    })
    void win.loadURL(url).catch((error) => {
      onError(error)
      // 导航失败时也让用户看到这个窗口，避免点击后像没有反应。
      showWindow(win)
    })
    return win
  }

  return {
    open,
    get size() {
      return windows.size
    },
    close() {
      for (const win of windows) {
        if (!win.isDestroyed()) win.destroy()
      }
      windows.clear()
    }
  }

  function showWindow(win) {
    if (win.isDestroyed()) return
    win.show()
    win.focus()
  }
}

function httpUrl(value) {
  let url
  try {
    url = new URL(String(value ?? ''))
  } catch {
    throw new Error('Only HTTP and HTTPS URLs are supported')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported')
  }
  return url.href
}
