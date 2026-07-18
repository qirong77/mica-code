import { dialog, ipcMain } from 'electron'
import os from 'os'
import { existsSync, readlinkSync, statSync } from 'fs'
import { execFile } from 'child_process'
import pty from 'node-pty'

const sessions = new Map()
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

function getDefaultShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/zsh'
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
  const requestedCwd = typeof options.cwd === 'string' ? options.cwd.trim() : ''
  const cwd = resolveCwd(requestedCwd)
  const cols = options.cols || 80
  const rows = options.rows || 24
  const usedFallback = !!requestedCwd && cwd !== requestedCwd
  const resumeSessionId = normalizeResumeSessionId(options.resumeSessionId)

  const term = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
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

  ipcMain.handle('terminal:get-cwd', async (_event, { id } = {}) => {
    const session = sessions.get(id)
    if (!session) return null
    return readProcessCwd(session.term.pid, session.cwd)
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
