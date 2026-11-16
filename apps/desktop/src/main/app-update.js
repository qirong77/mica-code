import { isClientSenderAllowed } from './client-context.js'

export const APP_UPDATE_CHANNEL = 'mica:app-update'
export const UPDATE_RELEASE_URL = 'https://github.com/qirong77/mica-code/releases/latest'

// Keep this list in sync with the desktop artifacts published by
// build-binaries.yml. The CLI has more targets, but a CLI archive is not an
// electron-updater payload and must not make the desktop installer look
// available on that platform/architecture. Only Linux AppImage is published.
const SUPPORTED_UPDATE_PLATFORMS = new Set(['linux'])
const SUPPORTED_UPDATE_TARGETS = new Set(['linux:x64'])

function capability({ supported, reason = null, message = null } = {}) {
  return { supported, reason, message, releaseUrl: UPDATE_RELEASE_URL }
}

/**
 * electron-updater is only useful for a real installer target. An Electron
 * `--dir` bundle is packaged (app.isPackaged is true), but electron-builder
 * deliberately does not put app-update.yml in that target. Check the actual
 * prerequisites before registering the updater so a local development bundle
 * does not fail with an opaque ENOENT five seconds after launch.
 */
export function resolveUpdateCapability({
  isDev = false,
  isPackaged = false,
  updater = null,
  platform = process.platform,
  architecture = process.arch,
  hasUpdateConfig = false,
  isAppImage = false
} = {}) {
  if (isDev || !isPackaged) {
    return capability({
      supported: false,
      reason: 'development',
      message: '当前运行的是源码 / 开发模式，不使用桌面自动安装器。'
    })
  }
  // macOS 桌面更新没有发布通道：Squirrel 只接受 Developer ID 正式签名包，
  // 自签 / adhoc 都不适合分发，所以这里直接说明，不再尝试准备安装器。
  if (platform === 'darwin') {
    return capability({
      supported: false,
      reason: 'macos-not-published',
      message:
        'macOS 桌面更新暂未发布：系统安装器要求 Developer ID 正式签名的安装包。请用正式下载页手动安装。'
    })
  }
  if (!SUPPORTED_UPDATE_PLATFORMS.has(platform)) {
    return capability({
      supported: false,
      reason: 'unsupported-platform',
      message: '当前平台暂不支持桌面自动更新。'
    })
  }
  if (!SUPPORTED_UPDATE_TARGETS.has(`${platform}:${architecture}`)) {
    return capability({
      supported: false,
      reason: 'unsupported-architecture',
      message: `当前 ${platform} / ${architecture} 没有对应的桌面更新包。`
    })
  }
  if (!updater) {
    return capability({
      supported: false,
      reason: 'updater-disabled',
      message: '本机自动更新已停用，不会自动下载安装更新。'
    })
  }
  if (!hasUpdateConfig) {
    return capability({
      supported: false,
      reason: 'local-build',
      message: '当前是本机构建的桌面包，没有正式自动更新配置，不能自动下载安装。'
    })
  }
  if (!isAppImage) {
    return capability({
      supported: false,
      reason: 'appimage-required',
      message: '当前 Linux 安装方式不支持自动更新，需要通过 AppImage 运行。'
    })
  }
  return capability({ supported: true })
}

function errorDetails(error) {
  const text = error instanceof Error ? error.message : String(error || '')
  const code = error?.code || ''
  if (/app-update\.yml/i.test(text) || code === 'ERR_UPDATER_INVALID_PROVIDER_CONFIGURATION') {
    return { reason: 'local-build', message: '本机安装包缺少自动更新配置，不能自动下载安装。' }
  }
  if (/APPIMAGE env is not defined|SNAP env is defined/i.test(text)) {
    return {
      reason: 'appimage-required',
      message: '当前 Linux 安装方式不支持自动更新，需要通过 AppImage 运行。'
    }
  }
  if (code === 'ERR_UPDATER_OLD_FILE_NOT_FOUND') {
    return {
      reason: 'stale-update-state',
      message: '本机更新缓存已失效，请重新检查并下载更新。'
    }
  }
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
    return { reason: 'feed-unavailable', message: '当前平台的桌面更新源暂未发布或暂时不可用。' }
  }
  if (/404/i.test(text))
    return {
      reason: 'package-unavailable',
      message: '更新源引用的安装包暂时不可用，请稍后重试或查看正式下载页。'
    }
  if (code === 'ERR_UPDATER_ZIP_FILE_NOT_FOUND' || code === 'ERR_UPDATER_NO_FILES_PROVIDED') {
    return {
      reason: 'package-unavailable',
      message: '更新清单没有提供适用于当前平台和架构的完整安装包。'
    }
  }
  if (/sha512 checksum mismatch|checksum mismatch/i.test(text)) {
    return {
      reason: 'checksum-mismatch',
      message: '更新包校验失败，已拒绝安装。请重新检查并下载。'
    }
  }
  return { reason: null, message: null }
}

function publicStatus(status) {
  const result = {
    status: status.status,
    version: status.version || null,
    progress: Number.isFinite(status.progress) ? status.progress : null,
    message: status.message || null,
    error: status.error || null
  }
  if (status.reason) result.reason = status.reason
  if (status.releaseUrl) result.releaseUrl = status.releaseUrl
  return result
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
  onInstalling = () => {},
  capability = null,
  checkIntervalMs = 10 * 60 * 1000
}) {
  let registered = false
  let disposed = false
  let generation = 0
  const initialCapability =
    capability ||
    (isDev
      ? resolveUpdateCapability({ isDev: true })
      : {
          supported: false,
          reason: 'capability-unavailable',
          message: '无法确认此安装包的更新能力，请使用正式下载页。',
          releaseUrl: UPDATE_RELEASE_URL
        })
  const capable = !isDev && Boolean(updater) && initialCapability.supported === true
  let current = {
    status: capable ? 'idle' : 'unsupported',
    ...(initialCapability?.reason ? { reason: initialCapability.reason } : {}),
    ...(initialCapability?.message ? { message: initialCapability.message } : {}),
    ...(initialCapability?.releaseUrl ? { releaseUrl: initialCapability.releaseUrl } : {})
  }
  let timer = null
  let checking = null
  let downloading = null
  let installing = false
  const listeners = []

  const publish = (patch) => {
    if (disposed) return publicStatus(current)
    current = { ...current, ...patch }
    const value = publicStatus(current)
    for (const state of getWindows()) {
      try {
        if (state?.local && !state.win.isDestroyed())
          state.win.webContents.send('mica:update-status', value)
      } catch {
        // A window can disappear between the snapshot and send.
      }
    }
    return value
  }
  const snapshot = () => ({ ok: true, status: publicStatus(current) })
  const fail = (error) => {
    const details = errorDetails(error)
    const status = publish({
      status: 'error',
      reason: details.reason,
      message: details.message,
      progress: null,
      error: error instanceof Error ? error.message : String(error)
    })
    return { ok: false, error: status.error, reason: status.reason || null, status }
  }
  const protectedStatus = () => ['downloading', 'downloaded', 'installing'].includes(current.status)
  const unsupportedResult = () => ({
    ok: false,
    code: 'unsupported',
    reason: current.reason || (isDev ? 'development' : 'updater-disabled'),
    error: current.message || '当前环境不支持桌面自动更新',
    status: publicStatus(current),
    releaseUrl: current.releaseUrl || UPDATE_RELEASE_URL
  })

  function check() {
    // Focus/poll in ANY window must not discard an already downloaded package or start a parallel check.
    if (protectedStatus()) return Promise.resolve(snapshot())
    if (checking) return checking
    const requestGeneration = generation
    publish({ status: 'checking', error: null, message: null, reason: null, progress: null })
    checking = Promise.resolve()
      .then(() => updater.checkForUpdates())
      .then((result) => {
        if (disposed || requestGeneration !== generation) return snapshot()
        if (result === null) {
          publish({
            status: 'unsupported',
            reason: 'updater-disabled',
            message: '当前安装方式不支持自动更新；更新器没有执行版本检查。'
          })
          return unsupportedResult()
        }
        if (!result || typeof result.isUpdateAvailable !== 'boolean') {
          throw new Error('更新器返回的检查结果不完整，无法确认是否有新版本')
        }
        if (current.status === 'checking') {
          publish({
            status: result?.isUpdateAvailable === true ? 'available' : 'not-available',
            version: result?.updateInfo?.version || null
          })
        }
        return snapshot()
      })
      .catch((error) => (disposed || requestGeneration !== generation ? snapshot() : fail(error)))
      .finally(() => {
        if (requestGeneration === generation) checking = null
      })
    return checking
  }

  function download() {
    if (['downloaded', 'installing'].includes(current.status)) return Promise.resolve(snapshot())
    if (downloading) return downloading
    if (current.status !== 'available')
      return Promise.resolve({ ok: false, error: '尚未找到可下载的桌面更新包' })
    const requestGeneration = generation
    publish({ status: 'downloading', progress: 0, error: null, message: null, reason: null })
    downloading = Promise.resolve()
      .then(() => updater.downloadUpdate())
      .then(() => {
        if (disposed || requestGeneration !== generation) return snapshot()
        if (current.status === 'error') {
          return { ok: false, error: current.error, status: publicStatus(current) }
        }
        if (current.status !== 'downloaded') throw new Error('下载未完成，安装包尚未通过更新器校验')
        return snapshot()
      })
      .catch((error) => (disposed || requestGeneration !== generation ? snapshot() : fail(error)))
      .finally(() => {
        if (requestGeneration === generation) downloading = null
      })
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
        error:
          activity.blockers
            .map((item) => item.label)
            .filter(Boolean)
            .join('；') || '当前仍有工作在运行'
      }
    } catch (error) {
      return {
        ok: false,
        code: 'activity-unavailable',
        error: `无法确认工作状态，暂不重启：${error?.message || String(error)}`
      }
    }
  }

  async function install() {
    if (installing) return { ok: false, code: 'busy', error: '更新确认正在进行，请勿重复操作' }
    if (current.status !== 'downloaded') return { ok: false, error: '更新包还没有下载完成' }
    const requestGeneration = generation
    const interrupted = () => disposed || requestGeneration !== generation
    installing = true
    try {
      const busy = await blockers()
      if (interrupted()) return { ok: false, code: 'cancelled' }
      if (busy) return busy
      if (!(await confirmInstall())) return { ok: false, code: 'cancelled' }
      if (interrupted()) return { ok: false, code: 'cancelled' }
      // Another window can start work while the confirmation is open. Fail closed, keep the package.
      const becameBusy = await blockers()
      if (interrupted()) return { ok: false, code: 'cancelled' }
      if (becameBusy) return becameBusy
      publish({ status: 'installing', message: '正在重启并安装更新…', error: null })
      onInstalling(true)
      updater.quitAndInstall(false, true)
      if (current.status !== 'installing')
        return {
          ok: false,
          error: current.error || '安装器未能启动',
          status: publicStatus(current)
        }
      return snapshot()
    } catch (error) {
      onInstalling(false)
      // A synchronous installer failure does not erase the downloaded package.
      publish({
        status: 'downloaded',
        ...errorDetails(error),
        error: error?.message || String(error)
      })
      return { ok: false, error: current.error, status: publicStatus(current) }
    } finally {
      installing = false
    }
  }

  const invoke = async (event, action) => {
    const windows = [...getWindows()]
    if (
      !isClientSenderAllowed(windows, event) ||
      !windows.some((state) => state.local && state.win.webContents === event?.sender)
    ) {
      return { ok: false, code: 'remote-window', error: '此页面不能更新本机应用，请切回本机窗口' }
    }
    if (action === 'status') return snapshot()
    if (!capable || current.status === 'unsupported') return unsupportedResult()
    if (action === 'check') return check()
    if (action === 'download') return download()
    if (action === 'install') return install()
    return { ok: false, error: '未知的更新操作' }
  }

  function register() {
    if (registered || disposed || !ipcMain) return
    registered = true
    ipcMain.handle(APP_UPDATE_CHANNEL, invoke)
    if (!capable) return
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    const on = (name, listener) => {
      updater.on(name, listener)
      listeners.push([name, listener])
    }
    on('checking-for-update', () => {
      if (!protectedStatus())
        publish({ status: 'checking', error: null, reason: null, message: null })
    })
    on('update-available', (info) => {
      if (!protectedStatus())
        publish({
          status: 'available',
          version: info?.version || null,
          error: null,
          reason: null,
          message: null
        })
    })
    on('update-not-available', () => {
      if (!protectedStatus())
        publish({ status: 'not-available', error: null, reason: null, message: null })
    })
    on('download-progress', (info) => {
      if (current.status === 'downloading')
        publish({ progress: Number(info?.percent) || 0, error: null })
    })
    on('update-downloaded', (info) => {
      if (current.status !== 'downloading') return
      if (current.version && info?.version && current.version !== info.version) {
        publish({
          status: 'error',
          reason: 'version-mismatch',
          message: '下载的更新版本与检查结果不一致，已拒绝安装。',
          error: `更新版本不一致：${current.version} / ${info.version}`,
          progress: null
        })
        return
      }
      publish({
        status: 'downloaded',
        version: info?.version || current.version,
        progress: 100,
        error: null,
        reason: null,
        message: null
      })
    })
    on('error', (error) => {
      if (current.status === 'downloaded') {
        if (installing) publish({ ...errorDetails(error), error: error?.message || String(error) })
        return
      }
      onInstalling(false)
      if (current.status === 'installing') {
        publish({
          status: 'downloaded',
          ...errorDetails(error),
          error: error?.message || String(error)
        })
        return
      }
      fail(error)
    })
    const schedule = (delay) => {
      timer = setTimeoutImpl(async () => {
        timer = null
        if (!registered || disposed) return
        await check()
        if (
          registered &&
          !['unsupported', 'downloading', 'downloaded', 'installing'].includes(current.status)
        )
          schedule(checkIntervalMs)
      }, delay)
      timer?.unref?.()
    }
    schedule(5000)
  }

  function dispose() {
    disposed = true
    generation += 1
    if (timer) clearTimeoutImpl(timer)
    timer = null
    for (const [name, listener] of listeners) updater?.removeListener?.(name, listener)
    listeners.length = 0
    if (registered) ipcMain?.removeHandler?.(APP_UPDATE_CHANNEL)
    registered = false
  }

  return { register, dispose, invoke, getStatus: () => publicStatus(current) }
}
