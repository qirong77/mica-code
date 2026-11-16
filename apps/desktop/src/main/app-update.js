import { isClientSenderAllowed } from './client-context.js'

export const APP_UPDATE_CHANNEL = 'mica:app-update'

/** Stage Squirrel without scheduling a quit. MacUpdater.quitAndInstall otherwise schedules one itself. */
export function prepareMacInstaller({ nativeUpdater, isReady, timeoutMs = 60_000 }) {
  if (isReady()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      nativeUpdater.removeListener('update-downloaded', ready)
      nativeUpdater.removeListener('error', failed)
    }
    const failed = (error) => { cleanup(); reject(error) }
    const ready = () => {
      cleanup()
      if (isReady()) resolve()
      else reject(new Error('原生安装器尚未就绪，暂不重启'))
    }
    nativeUpdater.once('update-downloaded', ready)
    nativeUpdater.once('error', failed)
    timer = setTimeout(() => failed(new Error('原生安装器准备超时，更新包已保留')), timeoutMs)
    timer.unref?.()
    try {
      nativeUpdater.checkForUpdates()
    } catch (error) {
      failed(error)
    }
  })
}

function publicStatus(status) {
  return {
    status: status.status,
    version: status.version || null,
    progress: Number.isFinite(status.progress) ? status.progress : null,
    message: status.message || null,
    error: status.error || null
  }
}

/** Installer actions only belong to this shell's local top-level page, never a remote runtime. */
export function createAppUpdateController({
  ipcMain,
  updater,
  getWindows = () => [],
  isDev = false,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  getActivity,
  confirmInstall = async () => false,
  prepareInstall = async () => {},
  onInstalling = () => {}
}) {
  let registered = false
  let current = { status: isDev || !updater ? 'unsupported' : 'idle' }
  let timer = null
  let checking = null
  let downloading = null
  let installing = false
  const listeners = []

  const publish = (patch) => {
    current = { ...current, ...patch }
    const value = publicStatus(current)
    for (const state of getWindows()) {
      try {
        if (state?.local && !state.win.isDestroyed()) state.win.webContents.send('mica:update-status', value)
      } catch {
        // A window can disappear between the snapshot and send.
      }
    }
    return value
  }
  const snapshot = () => ({ ok: true, status: publicStatus(current) })
  const fail = (error) => {
    const status = publish({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    return { ok: false, error: status.error, status }
  }
  const protectedStatus = () => ['downloading', 'downloaded', 'installing'].includes(current.status)

  function check() {
    // Focus/poll in ANY window must not discard an already downloaded package or start a parallel check.
    if (protectedStatus()) return Promise.resolve(snapshot())
    if (checking) return checking
    publish({ status: 'checking', error: null, message: null })
    checking = Promise.resolve()
      .then(() => updater.checkForUpdates())
      .then((result) => {
        if (current.status === 'checking') {
          publish({
            status: result?.isUpdateAvailable === true ? 'available' : 'not-available',
            version: result?.updateInfo?.version || null
          })
        }
        return snapshot()
      })
      .catch(fail)
      .finally(() => { checking = null })
    return checking
  }

  function download() {
    if (['downloaded', 'installing'].includes(current.status)) return Promise.resolve(snapshot())
    if (downloading) return downloading
    if (current.status !== 'available') return Promise.resolve({ ok: false, error: '尚未找到可下载的桌面更新包' })
    publish({ status: 'downloading', progress: 0, error: null, message: null })
    downloading = Promise.resolve()
      .then(() => updater.downloadUpdate())
      .then(() => snapshot())
      .catch(fail)
      .finally(() => { downloading = null })
    return downloading
  }

  async function blockers() {
    try {
      const activity = await getActivity?.()
      if (!activity || !Array.isArray(activity.blockers)) throw new Error('工作状态返回不完整')
      if (!activity.blockers.length) return null
      return {
        ok: false,
        code: 'busy',
        blockers: activity.blockers,
        error: activity.blockers.map((item) => item.label).filter(Boolean).join('；') || '当前仍有工作在运行'
      }
    } catch (error) {
      return { ok: false, code: 'activity-unavailable', error: `无法确认工作状态，暂不重启：${error?.message || String(error)}` }
    }
  }

  async function install() {
    if (installing) return { ok: false, code: 'busy', error: '更新确认正在进行，请勿重复操作' }
    if (current.status !== 'downloaded') return { ok: false, error: '更新包还没有下载完成' }
    installing = true
    try {
      const busy = await blockers()
      if (busy) return busy
      if (!(await confirmInstall())) return { ok: false, code: 'cancelled' }
      // macOS staging can take seconds. It must not register a delayed quit callback:
      // work may start while staging, and the last activity check must be AFTER it.
      await prepareInstall()
      // Another window can start work while the confirmation is open. Fail closed, keep the package.
      const becameBusy = await blockers()
      if (becameBusy) return becameBusy
      publish({ status: 'installing', message: '正在重启并安装更新…', error: null })
      onInstalling(true)
      updater.quitAndInstall(false, true)
      if (current.status !== 'installing') return { ok: false, error: current.error || '安装器未能启动', status: publicStatus(current) }
      return snapshot()
    } catch (error) {
      onInstalling(false)
      // A synchronous installer failure does not erase the downloaded package.
      publish({ status: 'downloaded', error: error?.message || String(error) })
      return { ok: false, error: current.error, status: publicStatus(current) }
    } finally {
      installing = false
    }
  }

  const invoke = async (event, action) => {
    const windows = [...getWindows()]
    if (!isClientSenderAllowed(windows, event) || !windows.some((state) => state.local && state.win.webContents === event?.sender)) {
      return { ok: false, code: 'remote-window', error: '此页面不能更新本机应用，请切回本机窗口' }
    }
    if (action === 'status') return snapshot()
    if (isDev || !updater) return { ok: false, code: 'unsupported', error: '源码 / 开发模式不支持安装桌面更新' }
    if (action === 'check') return check()
    if (action === 'download') return download()
    if (action === 'install') return install()
    return { ok: false, error: '未知的更新操作' }
  }

  function register() {
    if (registered || !ipcMain) return
    registered = true
    ipcMain.handle(APP_UPDATE_CHANNEL, invoke)
    if (!updater || isDev) return
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    const on = (name, listener) => { updater.on(name, listener); listeners.push([name, listener]) }
    on('checking-for-update', () => { if (!protectedStatus()) publish({ status: 'checking', error: null }) })
    on('update-available', (info) => {
      if (!protectedStatus()) publish({ status: 'available', version: info?.version || null, error: null })
    })
    on('update-not-available', () => { if (!protectedStatus()) publish({ status: 'not-available', error: null }) })
    on('download-progress', (info) => {
      if (current.status === 'downloading') publish({ progress: Number(info?.percent) || 0, error: null })
    })
    on('update-downloaded', (info) => publish({ status: 'downloaded', version: info?.version || current.version, progress: 100, error: null }))
    on('error', (error) => {
      if (current.status === 'downloaded') {
        if (installing) publish({ error: error?.message || String(error) })
        return
      }
      onInstalling(false)
      if (current.status === 'installing') {
        publish({ status: 'downloaded', error: error?.message || String(error) })
        return
      }
      fail(error)
    })
    timer = setTimeoutImpl(() => { void check() }, 5000)
    timer?.unref?.()
  }

  function dispose() {
    if (timer) clearTimeoutImpl(timer)
    timer = null
    for (const [name, listener] of listeners) updater?.removeListener?.(name, listener)
    listeners.length = 0
    if (registered) ipcMain?.removeHandler?.(APP_UPDATE_CHANNEL)
    registered = false
  }

  return { register, dispose, invoke, getStatus: () => publicStatus(current) }
}
