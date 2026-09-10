import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join, resolve as resolvePath } from 'path'
import { fileURLToPath } from 'url'

/**
 * 纯 Node 环境下的 `electron` 替身：让 src/main 下的业务模块（terminals / chat /
 * files / git / stats / workspace / settings）原样跑在 HTTP 服务端。
 *
 * 只覆盖这些模块实际用到的那部分 API：
 * - `ipcMain.handle` 变成一张 channel -> handler 注册表，由 server 通过
 *   `POST /api/invoke` 派发（`invokeChannel`）。
 * - `event.sender` / `event.senderFrame` 是进程内单例。原代码用它们做「主框架」
 *   （防 iframe）与「会话归属」校验；服务端模式下所有浏览器客户端共享同一个
 *   sender 身份，因此多标签页/多设备都能操作同一批会话，`send()` 广播给所有
 *   已连接的 SSE 客户端。
 * - `app.getPath('userData')` 指向与 Electron 打包版相同的目录，保证 workspace、
 *   file-order、session-pins 这些本地状态在两种运行方式之间共享。
 */

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const APP_NAME = 'mica-code-app'

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const APP_VERSION = readPackageVersion()

function appDataDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32')
    return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

function userDataDir() {
  const override = (process.env.MICA_DESKTOP_USER_DATA || '').trim()
  return override || join(appDataDir(), APP_NAME)
}

function isDirectory(target) {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** 同名时追加序号，避免第二次删除覆盖回收站里的同名文件 */
function availableTarget(directory, name) {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const suffix = dot > 0 ? name.slice(dot) : ''
  let target = join(directory, name)
  for (let index = 1; existsSync(target) && index < 1000; index += 1) {
    target = join(directory, `${stem} ${index}${suffix}`)
  }
  return target
}

/** 与 `shell.trashItem` 对齐：删除到系统回收站，而不是真的抹掉 */
function moveToTrash(target) {
  const absolute = resolvePath(target)
  if (!existsSync(absolute)) throw new Error(`ENOENT: no such file or directory, ${absolute}`)
  if (process.platform === 'win32') {
    throw new Error('服务端模式下暂不支持删除到回收站，请手动处理该文件')
  }

  const name = basename(absolute)

  if (process.platform === 'darwin') {
    const trash = join(homedir(), '.Trash')
    mkdirSync(trash, { recursive: true })
    renameSync(absolute, availableTarget(trash, name))
    return
  }

  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const filesDir = join(dataHome, 'Trash', 'files')
  const infoDir = join(dataHome, 'Trash', 'info')
  mkdirSync(filesDir, { recursive: true })
  mkdirSync(infoDir, { recursive: true })
  const destination = availableTarget(filesDir, name)
  writeFileSync(
    join(infoDir, `${basename(destination)}.trashinfo`),
    `[Trash Info]\nPath=${absolute}\nDeletionDate=${new Date().toISOString()}\n`,
    'utf8'
  )
  renameSync(absolute, destination)
}

/** 在服务端所在的机器上打开文件所在的目录（文件本身就在这台机器上） */
function revealItem(target) {
  const absolute = resolvePath(target)
  const dir = isDirectory(absolute) ? absolute : dirname(absolute)
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  try {
    execFile(command, [dir], () => {})
  } catch {
    // 无桌面环境时静默跳过
  }
}

/* ---------------------------------------------------------------- transport */

let broadcastImpl = () => {}

/** 由 server 注入：把主进程的推送转成 SSE 广播 */
export function setBroadcast(fn) {
  broadcastImpl = typeof fn === 'function' ? fn : () => {}
}

const mainFrame = Object.freeze({ __micaMainFrame: true })
const sender = Object.freeze({
  mainFrame,
  send(channel, payload) {
    broadcastImpl(channel, payload)
  },
  isDestroyed() {
    return false
  }
})
const ipcEvent = Object.freeze({ sender, senderFrame: mainFrame })

const handlers = new Map()

export const ipcMain = {
  handle(channel, handler) {
    handlers.set(channel, handler)
  },
  removeHandler(channel) {
    handlers.delete(channel)
  }
}

export function registeredChannels() {
  return [...handlers.keys()]
}

/**
 * 派发一次等价于 `ipcRenderer.invoke` 的调用。handler 抛错时同步抛出，
 * 由 server 转成 `{ ok: false, error }` 响应，renderer 侧再还原成 rejected promise。
 */
export function invokeChannel(channel, payload) {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for '${channel}'`)
  return handler(ipcEvent, payload)
}

/* -------------------------------------------------------------- namespaces */

export const app = {
  getVersion: () => APP_VERSION,
  getName: () => APP_NAME,
  getPath(name) {
    if (name === 'userData') return userDataDir()
    if (name === 'appData') return appDataDir()
    if (name === 'home') return homedir()
    if (name === 'temp') return tmpdir()
    return join(userDataDir(), name)
  },
  setBadgeCount() {},
  isQuitting: false
}

export const shell = {
  // 网页端由浏览器自己打开外链（见 renderer 的 transport 适配）
  async openExternal() {
    return true
  },
  showItemInFolder(target) {
    revealItem(target)
  },
  async trashItem(target) {
    moveToTrash(target)
  }
}

export const clipboard = {
  writeText() {},
  readText: () => '',
  readImage() {
    throw new Error('服务端模式下无法读取系统剪贴板，请改用浏览器粘贴')
  }
}

export const dialog = {
  showErrorBox(title, message) {
    console.error(`[mica-desktop] ${title}: ${message}`)
  },
  async showOpenDialog() {
    // 浏览器端改用应用内的目录选择器（renderer 的 workspace.selectDirectory 适配）
    return { canceled: true, filePaths: [] }
  }
}

/** 仅为兼容潜在引用；server 入口不创建窗口 */
export class BrowserWindow {
  static getAllWindows() {
    return []
  }
}
