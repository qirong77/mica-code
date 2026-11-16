import { stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

/**
 * 编辑器窗口：一个文件（或一个目录）一扇窗。
 *
 * 它不是第二份应用，也不需要第二套业务：地址就是**本机页面**加 `?editor=<绝对路径>`，
 * 页面读到这个参数只渲染编辑器（文件树 + 编辑区 + 底栏）。所以这里只管窗口本身——
 * 不碰会话、不进主窗口那套 `windows` 集合（未读徽标、标题后缀、切服务器都是主窗口的事），
 * 关掉即销毁。
 *
 * 为什么用本机页面而不是当前窗口正在看的那台运行时：要打开的文件在这台机器上，路径
 * 由本地文件系统解释；窗口就算正连着另一台机器，`?editor=` 也必须落到本机运行时。
 */
export const EDITOR_PARAM = 'editor'

/** preload 里 `window.micaClient.openEditorWindow(path)` 走的通道名。 */
export const EDITOR_WINDOW_CHANNEL = 'mica:editor-window'

/** 页面读这个参数决定「只画编辑器」；地址里只放路径，其余开关（主题等）照旧跟着页面。 */
export function editorWindowUrl(pageUrl, target) {
  const url = new URL(pageUrl)
  url.searchParams.set(EDITOR_PARAM, target)
  return url.href
}

/**
 * 目标校验：绝对路径 + 真的存在（文件或目录）。
 *
 * 这里不判断「在不在某个搜索根里」——那是各入口自己的范围规则；窗口只接受一个能打开的
 * 真实路径，越权由请求方负责。
 */
export async function resolveEditorTarget(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('需要文件或文件夹的绝对路径')
  const target = value.trim()
  if (!isAbsolute(target)) throw new Error('需要文件或文件夹的绝对路径')
  let info = null
  try {
    info = await stat(target)
  } catch (error) {
    // `ENOENT` 说成「路径已经不存在了」：全局搜索的最近记录本来就可能是刚被删掉的文件。
    throw new Error(
      error?.code === 'ENOENT' ? `路径已经不存在了：${target}` : `无法访问这个路径：${target}`
    )
  }
  if (!info.isFile() && !info.isDirectory()) throw new Error('只能打开文件或文件夹')
  return target
}

/**
 * 窗口工厂。`pageUrl` 用 getter 传入：本机地址是运行时起来之后才有的，而窗口是用户
 * 随时点的；`samePath` 只留一扇窗（全局搜索、文件树、终端链接都会点同一条路径，重复
 * 打开只是把已有窗口端到前面）。
 */
export function createEditorWindows({
  BrowserWindow,
  pageUrl,
  webPreferences,
  backgroundColor,
  platform = process.platform,
  openExternal = null,
  onError = console.warn
}) {
  const windows = new Map()

  function reveal(win) {
    if (win.isMinimized?.()) win.restore()
    win.show()
    win.focus()
  }

  return {
    open(target) {
      const page = typeof pageUrl === 'function' ? pageUrl() : pageUrl
      if (!page) throw new Error('本机页面还没准备好，稍后再试')
      const existing = windows.get(target)
      if (existing && !existing.isDestroyed()) {
        reveal(existing)
        return existing
      }
      const isMac = platform === 'darwin'
      const win = new BrowserWindow({
        width: 1120,
        height: 760,
        minWidth: 640,
        minHeight: 420,
        show: false,
        autoHideMenuBar: true,
        title: `${basename(target) || target} — Mica`,
        backgroundColor: typeof backgroundColor === 'function' ? backgroundColor() : backgroundColor,
        // 与主窗口同一套外观：交通灯浮在页面顶部的拖动条上，页面自己画那条 h-8
        ...(isMac ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 8 } } : {}),
        webPreferences
      })
      windows.set(target, win)
      win.on('closed', () => {
        if (windows.get(target) === win) windows.delete(target)
      })
      win.on('ready-to-show', () => showWin(win))
      // 窗口里的页面不弹出新窗口：外链交给系统浏览器（与主窗口一致），其余一律拒绝
      win.webContents.setWindowOpenHandler((details) => {
        if (openExternal && /^(https?:|mailto:)/i.test(details.url)) openExternal(details.url)
        return { action: 'deny' }
      })
      void win.loadURL(editorWindowUrl(page, target)).catch((error) => onError(error))
      return win
    },
    /** 这个 webContents 是不是编辑器窗口的（preload 能力只发给自家的页面）。 */
    hasContents(contents) {
      for (const win of windows.values()) {
        if (!win.isDestroyed() && win.webContents === contents) return true
      }
      return false
    },
    get size() {
      return windows.size
    },
    close() {
      for (const win of windows.values()) {
        if (!win.isDestroyed()) win.destroy()
      }
      windows.clear()
    }
  }
}

function showWin(win) {
  if (win.isDestroyed()) return
  win.show()
  win.focus()
}
