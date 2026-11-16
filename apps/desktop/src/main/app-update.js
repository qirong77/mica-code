export const APP_UPDATE_CHANNEL = 'mica:app-update'

const TERMINAL_STATUSES = new Set(['not-available', 'error'])

function publicStatus(status) {
  return {
    status: status.status,
    version: status.version || null,
    progress: Number.isFinite(status.progress) ? status.progress : null,
    message: status.message || null,
    error: status.error || null
  }
}

/**
 * Electron updater glue is kept dependency-injected so the renderer and main
 * process can be tested without downloading an installer or importing Electron.
 * `electron-updater` is only activated for packaged builds; source/dev windows
 * still get the commit check served by the runtime.
 */
export function createAppUpdateController({
  ipcMain,
  updater,
  getWindows = () => [],
  isDev = false,
  setTimeoutImpl = setTimeout
}) {
  let registered = false
  let current = { status: isDev ? 'unsupported' : 'idle', version: null, progress: null }
  let timer = null

  const publish = (patch) => {
    current = { ...current, ...patch }
    const value = publicStatus(current)
    for (const state of getWindows()) {
      try {
        if (!state?.local || state.win.isDestroyed()) continue
        state.win.webContents.send('mica:update-status', value)
      } catch {
        // A window can disappear between the snapshot and send.
      }
    }
    return value
  }

  const isLocalSender = (event) =>
    getWindows().some(
      (state) => state?.local && !state.win.isDestroyed() && state.win.webContents === event?.sender
    )

  const invoke = async (_event, action) => {
    if (!isLocalSender(_event)) return { ok: false, error: '只有本机 Mica 窗口可以更新应用' }
    if (isDev || !updater) return { ok: false, error: '开发模式不支持安装桌面更新' }
    try {
      if (action === 'check') {
        publish({ status: 'checking', error: null })
        await updater.checkForUpdates()
        return { ok: true, status: publicStatus(current) }
      }
      if (action === 'download') {
        publish({ status: 'downloading', error: null })
        await updater.downloadUpdate()
        return { ok: true, status: publicStatus(current) }
      }
      if (action === 'install') {
        if (current.status !== 'downloaded') return { ok: false, error: '更新包还没有下载完成' }
        // quitAndInstall 会结束当前 runtime；只有用户点击按钮才走到这里。
        updater.quitAndInstall(false, true)
        return { ok: true, status: { status: 'installing' } }
      }
      return { ok: false, error: '未知的更新操作' }
    } catch (error) {
      const value = publish({
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
      return { ok: false, error: value.error }
    }
  }

  function register() {
    if (registered || !ipcMain) return
    registered = true
    ipcMain.handle(APP_UPDATE_CHANNEL, invoke)
    if (!updater || isDev) return
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.on('checking-for-update', () => publish({ status: 'checking', error: null }))
    updater.on('update-available', (info) =>
      publish({ status: 'available', version: info?.version || null, error: null })
    )
    updater.on('update-not-available', () => publish({ status: 'not-available', error: null }))
    updater.on('download-progress', (info) =>
      publish({ status: 'downloading', progress: Number(info?.percent) || 0, error: null })
    )
    updater.on('update-downloaded', (info) =>
      publish({
        status: 'downloaded',
        version: info?.version || current.version,
        progress: 100,
        error: null
      })
    )
    updater.on('error', (error) =>
      publish({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    )
    timer = setTimeoutImpl(() => {
      void updater.checkForUpdates().catch(() => {})
    }, 5000)
  }

  function dispose() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return {
    register,
    dispose,
    invoke,
    getStatus: () => publicStatus(current),
    isTerminalStatus: (value) => TERMINAL_STATUSES.has(value)
  }
}
