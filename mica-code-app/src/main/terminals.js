import { app, dialog, ipcMain, shell } from 'electron'
import os from 'os'
import { existsSync, readlinkSync, statSync } from 'fs'
import { stat } from 'fs/promises'
import { execFile } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import pty from 'node-pty'

const sessions = new Map()
const VSCODE_APP_PATH = '/Applications/Visual Studio Code.app'
let notifyServer = null

/** 访问被系统拒绝的 cwd 冷却，避免每次建终端都再次触发桌面/文稿权限弹窗 */
const ACCESS_DENIED_COOLDOWN_MS = 10 * 60 * 1000
const accessDeniedUntil = new Map()

function readProcessCwd(pid, fallback) {
  if (process.platform === 'linux') {
    try {
      return Promise.resolve(readlinkSync(`/proc/${pid}/cwd`))
    } catch {
      return Promise.resolve(fallback)
    }
  }

  if (process.platform !== 'win32') {
    return new Promise((resolve) => {
      execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], (error, stdout) => {
        if (error) return resolve(fallback)
        const cwd = stdout
          .split('\n')
          .find((line) => line.startsWith('n'))
          ?.slice(1)
        resolve(cwd || fallback)
      })
    })
  }

  return Promise.resolve(fallback)
}

async function readSessionCwd(session) {
  if (session.reportedCwd) return session.cwd
  if (session.resolvedCwd && Date.now() - session.resolvedCwdAt < 1000) {
    return session.resolvedCwd
  }
  if (session.cwdLookup) return session.cwdLookup

  session.cwdLookup = readProcessCwd(session.term.pid, session.cwd)
    .then((cwd) => {
      session.resolvedCwd = cwd
      session.resolvedCwdAt = Date.now()
      return cwd
    })
    .finally(() => {
      session.cwdLookup = null
    })
  return session.cwdLookup
}

function updateSessionCwdFromOutput(session, data) {
  const input = `${session.oscCwdBuffer || ''}${data}`.slice(-8192)
  // OSC sequences necessarily contain terminal control characters.
  // eslint-disable-next-line no-control-regex
  const pattern = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g
  let consumedThrough = 0
  let match

  while ((match = pattern.exec(input))) {
    consumedThrough = pattern.lastIndex
    try {
      const url = new URL(match[1])
      if (url.protocol !== 'file:') continue
      let cwd = decodeURIComponent(url.pathname)
      if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(cwd)) cwd = cwd.slice(1)
      session.cwd = path.normalize(cwd)
      session.resolvedCwd = session.cwd
      session.resolvedCwdAt = Date.now()
      session.reportedCwd = true
    } catch {
      // Ignore malformed shell integration sequences.
    }
  }

  session.oscCwdBuffer = consumedThrough ? input.slice(consumedThrough) : input.slice(-1024)
}

function normalizeLinkPath(value, cwd) {
  if (typeof value !== 'string') return null
  let target = value.trim()
  if (!target || target.length > 4096 || target.includes('\0')) return null

  try {
    if (target.startsWith('file://')) target = fileURLToPath(target)
  } catch {
    return null
  }

  if (target === '~') {
    target = os.homedir()
  } else if (target.startsWith('~/') || target.startsWith('~\\')) {
    target = path.join(os.homedir(), target.slice(2))
  }

  return path.normalize(path.isAbsolute(target) ? target : path.resolve(cwd, target))
}

async function resolveTerminalLinkPath(session, value) {
  const cwd = await readSessionCwd(session)
  const absolutePath = normalizeLinkPath(value, cwd)
  if (!absolutePath) return null

  try {
    const stats = await stat(absolutePath)
    if (!stats.isFile() && !stats.isDirectory()) return null
    return { path: absolutePath, directory: stats.isDirectory() }
  } catch {
    return null
  }
}

function openFileByVsCode(filePath) {
  if (!existsSync(VSCODE_APP_PATH)) {
    dialog.showErrorBox('未找到编辑器', '未检测到 Visual Studio Code，请先安装')
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    execFile('open', ['-a', VSCODE_APP_PATH, filePath], (error) => {
      if (error) {
        dialog.showErrorBox('打开失败', error.message)
        resolve(false)
        return
      }
      resolve(true)
    })
  })
}

function assertMainFrame(event) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC request must come from the main frame')
  }
}

function assertSessionOwner(event, session) {
  assertMainFrame(event)
  if (event.sender !== session.sender) throw new Error('Terminal session access denied')
}

function getDefaultShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/zsh'
}

function getShellArgs(shellPath) {
  if (process.platform === 'win32') return []

  // Applications opened from Finder/Dock inherit a minimal environment from
  // launchd. A login shell runs the system and user profile files that set up
  // Homebrew, language runtimes, package-manager binaries, and the user's PATH.
  const shellName = path.basename(shellPath).toLowerCase()
  if (shellName === 'fish') return ['--login']
  if (['bash', 'zsh', 'sh', 'ksh', 'dash'].includes(shellName)) return ['-l']
  return []
}

function isPermissionError(error) {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'EPERM' || error.code === 'EACCES')
  )
}

function isAccessDenied(dir) {
  const until = accessDeniedUntil.get(dir)
  return until != null && Date.now() < until
}

function markAccessDenied(dir) {
  accessDeniedUntil.set(dir, Date.now() + ACCESS_DENIED_COOLDOWN_MS)
}

function clearAccessDenied(dir) {
  accessDeniedUntil.delete(dir)
}

function resolveCwd(cwd) {
  const home = os.homedir()
  if (!cwd || typeof cwd !== 'string') return home

  const target = cwd.trim()
  if (!target) return home
  if (isAccessDenied(target)) return home

  try {
    if (existsSync(target) && statSync(target).isDirectory()) {
      clearAccessDenied(target)
      return target
    }
  } catch (error) {
    if (isPermissionError(error)) {
      markAccessDenied(target)
      console.warn(`Terminal cwd access denied (cooldown): ${target}`)
    }
  }
  return home
}

function normalizeResumeSessionId(value) {
  if (typeof value !== 'string') return null
  const sessionId = value.trim()
  if (!sessionId || sessionId.length > 200) return null
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(sessionId)) return null
  return sessionId
}

function createPty(id, sender, options = {}) {
  const shell = options.shell || getDefaultShell()
  const shellArgs = getShellArgs(shell)
  const requestedCwd = typeof options.cwd === 'string' ? options.cwd.trim() : ''
  const cwd = resolveCwd(requestedCwd)
  const cols = options.cols || 80
  const rows = options.rows || 24
  const usedFallback = !!requestedCwd && cwd !== requestedCwd
  const resumeSessionId = normalizeResumeSessionId(options.resumeSessionId)

  const term = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Mica Code',
      TERM_PROGRAM_VERSION: app.getVersion(),
      ...(notifyServer ? notifyServer.getTerminalEnv(id) : {})
    }
  })

  const session = { id, term, sender, cwd }
  sessions.set(id, session)

  if (resumeSessionId) {
    const resumeCommand = `mica --resume ${resumeSessionId}`
    setTimeout(() => {
      if (sessions.get(id)?.term === term) term.write(`${resumeCommand}\r`)
    }, 50)
  }

  term.onData((data) => {
    updateSessionCwdFromOutput(session, data)
    if (!sender.isDestroyed()) {
      sender.send('terminal:data', { id, data })
    }
  })

  term.onExit(({ exitCode, signal }) => {
    sessions.delete(id)
    notifyServer?.clear(id)
    if (!sender.isDestroyed()) {
      sender.send('terminal:exit', { id, exitCode, signal })
    }
  })

  return {
    id,
    shell,
    cwd,
    requestedCwd: requestedCwd || null,
    usedFallback,
    resumedSessionId: resumeSessionId
  }
}

export function setNotifyServer(server) {
  notifyServer = server
}

export function registerTerminalIpc() {
  ipcMain.handle('terminal:create', (event, payload = {}) => {
    const id = payload.id
    if (!id) throw new Error('terminal id is required')
    if (sessions.has(id)) {
      return { id, reused: true }
    }
    return createPty(id, event.sender, payload)
  })

  ipcMain.handle('terminal:write', (_event, { id, data }) => {
    const session = sessions.get(id)
    if (!session) return false
    session.term.write(data)
    return true
  })

  ipcMain.handle('terminal:resize', (_event, { id, cols, rows }) => {
    const session = sessions.get(id)
    if (!session) return false
    session.term.resize(Math.max(cols, 2), Math.max(rows, 1))
    return true
  })

  ipcMain.handle('terminal:clear', (_event, { id }) => {
    const session = sessions.get(id)
    if (!session) return false
    session.term.clear()
    return true
  })

  ipcMain.handle('terminal:get-cwd', async (_event, { id } = {}) => {
    const session = sessions.get(id)
    if (!session) return null
    return readSessionCwd(session)
  })

  ipcMain.handle('terminal:resolve-file-links', async (event, { id, paths } = {}) => {
    const session = sessions.get(id)
    if (!session || !Array.isArray(paths)) return []
    assertSessionOwner(event, session)

    const candidates = [...new Set(paths.filter((value) => typeof value === 'string').slice(0, 50))]
    const resolved = await Promise.all(
      candidates.map(async (value) => ({
        value,
        result: await resolveTerminalLinkPath(session, value)
      }))
    )
    return resolved.filter((item) => item.result).map((item) => item.value)
  })

  ipcMain.handle('terminal:open-external', async (event, { url } = {}) => {
    assertMainFrame(event)
    if (typeof url !== 'string' || url.length > 8192) throw new Error('Invalid URL')
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS links can be opened')
    }
    await shell.openExternal(parsed.toString())
    return true
  })

  ipcMain.handle('terminal:open-file', async (event, payload = {}) => {
    const session = sessions.get(payload.id)
    if (!session) throw new Error('Terminal session not found')
    assertSessionOwner(event, session)
    const resolved = await resolveTerminalLinkPath(session, payload.path)
    if (!resolved) throw new Error('File does not exist')

    return openFileByVsCode(resolved.path)
  })

  ipcMain.handle('terminal:dispose', (_event, { id }) => {
    const session = sessions.get(id)
    if (!session) return false
    try {
      session.term.kill()
    } catch {
      // ignore
    }
    sessions.delete(id)
    notifyServer?.clear(id)
    return true
  })

  ipcMain.handle('terminal:dispose-all', () => {
    for (const [id, session] of sessions) {
      try {
        session.term.kill()
      } catch {
        // ignore
      }
      sessions.delete(id)
      notifyServer?.clear(id)
    }
    return true
  })

  /** 用系统文件夹选择器拿路径，比手输 Desktop 路径更容易稳定拿到授权 */
  ipcMain.handle('dialog:select-directory', async (_event, payload = {}) => {
    const result = await dialog.showOpenDialog({
      title: payload.title || '选择默认路径',
      defaultPath: payload.defaultPath || os.homedir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true }
    }
    const dir = result.filePaths[0]
    clearAccessDenied(dir)
    return { canceled: false, path: dir }
  })

  ipcMain.handle('notify:list', () => {
    return notifyServer ? notifyServer.list() : []
  })

  ipcMain.handle('notify:mark-read', (_event, { id } = {}) => {
    if (!id || !notifyServer) return null
    return notifyServer.markRead(id)
  })
}

export function disposeAllTerminals() {
  for (const session of sessions.values()) {
    try {
      session.term.kill()
    } catch {
      // ignore
    }
  }
  sessions.clear()
}
