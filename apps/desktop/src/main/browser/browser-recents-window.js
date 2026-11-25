/**
 * 「最近访问」浮层：一个跟着浏览器窗口的小面板。
 *
 * 为什么不是画在顶栏里：顶栏是窗口自身的页面，网页标签页是盖在它上面的子视图——38px
 * 以下的部分全被网页盖住，任何下拉列表都出不来。另开一个窗口是唯一不需要动层级、
 * 也不需要让顶栏去借透明合成的做法（顶栏若改成浮层，页面上的点击会被它整块吃掉）。
 *
 * 几个刻意的选择：
 * - `focusable: false` + `acceptFirstMouse: true`：面板不抢焦点，用户还能继续在地址栏
 *   打字筛选；第一下点击也直接落到列表项上，不用先点一下「激活」它。
 * - `parent` + `type: 'panel'`（macOS）：始终浮在浏览器窗口之上，跟着它走；面板自己不
 *   出现在任务栏 / 窗口列表里。
 * - 每次显示都重新算 bounds（`recentBounds`，纯函数、有单测）：地址框随窗口宽度变化，
 *   列表随条数变高。
 * - 面板只在需要时创建，浏览器窗口销毁时一起销毁；闲置回收本来就会连窗口一起收掉。
 */

import { BrowserWindow, screen } from 'electron'
import { chromeUpdateScript, parseChromeMessage } from '@packages/mica-web-shared'
import { recentBounds } from './browser-recents.js'
import { recentPageUrl } from './browser-chrome.js'

/** 页面还没就绪时最多等多久（运行时可能比窗口晚起来）。 */
const LOAD_RETRY_MS = 500
const LOAD_RETRIES = 20

export function createRecentWindow({
  getPageBaseUrl = () => '',
  isDevPage = () => false,
  onPick = () => {},
  // 鼠标划过某一行：顶栏据此更新高亮，回车与点选才是同一条
  onHover = () => {}
} = {}) {
  let win = null
  let ready = false
  let state = { items: [], highlight: -1 }
  // 页面还没加载完就先要显示：等 did-finish-load 之后补上，避免闪一个空白面板
  let pending = null

  function pageUrl() {
    return recentPageUrl(getPageBaseUrl(), { dev: isDevPage() })
  }

  function load(attempt = 0) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    const url = pageUrl()
    if (!url) {
      if (attempt < LOAD_RETRIES) setTimeout(() => load(attempt + 1), LOAD_RETRY_MS)
      return
    }
    win.loadURL(url).catch((error) => {
      if (!win || win.isDestroyed()) return
      console.warn('[mica-browser] 最近访问面板加载失败', error?.code || error)
      if (attempt < LOAD_RETRIES) setTimeout(() => load(attempt + 1), LOAD_RETRY_MS * 2)
    })
  }

  function push() {
    if (!win || win.isDestroyed() || !ready) return
    win.webContents
      .executeJavaScript(chromeUpdateScript('recent', state))
      .catch(() => {
        // 面板正在加载或已经销毁：下一次 show/update 会再推一遍
      })
  }

  function ensure(parent) {
    if (win && !win.isDestroyed()) return win
    if (!parent || parent.isDestroyed()) return null
    win = new BrowserWindow({
      parent,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // 面板紧贴顶栏下沿、上沿是直角：系统阴影会把它推成一张浮卡片，不要
      hasShadow: false,
      // 面板自己画圆角与边框；macOS 的 panel 类型让它跟住父窗口、不参与应用切换
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 第一次点击就交给页面：面板通常不是 key window，不设这个第一下会被吞掉
        acceptFirstMouse: true
      }
    })
    ready = false
    win.webContents.on('console-message', (details) => {
      const message = parseChromeMessage(details?.message)
      if (!message) return
      if (message.action === 'recent:pick' && typeof message.url === 'string' && message.url) {
        hide()
        onPick(message.url)
      } else if (message.action === 'recent:hover') {
        const index = Number(message.index)
        if (Number.isInteger(index) && index >= 0 && index <= 500) onHover(index)
      } else if (message.action === 'recent:close') {
        hide()
      }
    })
    win.webContents.on('did-finish-load', () => {
      ready = true
      if (pending) {
        // 先把 pending 取出来再清空：`show` 里还会按新的 pending 重排，别读成 null
        const next = pending
        pending = null
        show(next.parent, next)
        return
      }
      push()
    })
    win.on('closed', () => {
      win = null
      ready = false
      pending = null
    })
    load()
    return win
  }

  function show(parent, { anchor, items, highlight = -1 } = {}) {
    const list = Array.isArray(items) ? items.filter((item) => item && typeof item.url === 'string') : []
    if (!list.length) {
      hide()
      return
    }
    const target = ensure(parent)
    if (!target) return
    const content = parent.getContentBounds()
    let workArea
    try {
      workArea = screen.getDisplayMatching(content).workArea
    } catch {
      workArea = content
    }
    target.setBounds(recentBounds({ anchor, content, rows: list.length, workArea }))
    state = { items: list, highlight: Number.isInteger(highlight) ? highlight : -1 }
    if (!ready) {
      // 页面还在加载：记住这一次，加载完再显示（不然会先看到一个空白框）
      pending = { parent, anchor, items: list, highlight: state.highlight }
      return
    }
    push()
    if (!target.isVisible()) target.showInactive()
  }

  function hide() {
    pending = null
    if (!win || win.isDestroyed()) return
    if (win.isVisible()) win.hide()
  }

  function destroy() {
    pending = null
    ready = false
    if (!win || win.isDestroyed()) {
      win = null
      return
    }
    const target = win
    win = null
    target.destroy()
  }

  return { show, hide, destroy, get window() { return win } }
}
