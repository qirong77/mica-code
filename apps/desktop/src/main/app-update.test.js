import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'bun:test'
import {
  APP_UPDATE_CHANNEL,
  createAppUpdateController,
  hasMacUpdateSignature,
  prepareMacInstaller,
  resolveUpdateCapability,
  UPDATE_RELEASE_URL
} from './app-update.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeSender(url = 'http://mica.local/') {
  const sent = []
  const sender = {
    isDestroyed: () => false,
    getURL: () => url,
    mainFrame: { url },
    send: (...args) => sent.push(args)
  }
  return { sender, sent }
}

function fixture({
  isDev = false,
  windows,
  updaterOverrides = {},
  getActivity = () => ({ blockers: [] }),
  confirmInstall = async () => true,
  prepareInstall,
  setTimeoutImpl,
  capability
} = {}) {
  const handlers = new Map()
  const listeners = new Map()
  const { sender, sent } = makeSender()
  const state = {
    local: true,
    clientOrigin: 'http://mica.local',
    win: {
      isDestroyed: () => false,
      webContents: sender
    }
  }
  const registeredWindows = windows || new Set([state])
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(name, fn) {
      listeners.set(name, fn)
    },
    removeListener(name, fn) {
      if (listeners.get(name) === fn) listeners.delete(name)
    },
    async checkForUpdates() {
      return { isUpdateAvailable: true, updateInfo: { version: '1.0.2' } }
    },
    async downloadUpdate() {
      listeners.get('update-downloaded')?.({ version: '1.0.2' })
    },
    quitAndInstall: () => sent.push(['install']),
    ...updaterOverrides
  }
  const controller = createAppUpdateController({
    ipcMain: {
      handle: (name, fn) => handlers.set(name, fn),
      removeHandler: (name) => handlers.delete(name)
    },
    updater,
    getWindows: () => registeredWindows,
    isDev,
    getActivity,
    confirmInstall,
    prepareInstall,
    capability:
      capability ??
      (isDev
        ? undefined
        : { supported: true, reason: null, message: null, releaseUrl: UPDATE_RELEASE_URL }),
    ...(setTimeoutImpl ? { setTimeoutImpl } : {})
  })
  controller.register()
  const invoke = (action, event = { sender, senderFrame: sender.mainFrame }) =>
    handlers.get(APP_UPDATE_CHANNEL)(event, action)
  const cleanup = () => controller.dispose()
  return { controller, handlers, updater, listeners, sender, state, sent, invoke, cleanup }
}

async function reachDownloaded(fixtureOptions = {}) {
  const value = fixture(fixtureOptions)
  await value.invoke('check')
  await value.invoke('download')
  assert.equal(value.controller.getStatus().status, 'downloaded')
  return value
}

test('accepts a Set of windows and installs a downloaded package only from the local top-level page', async () => {
  let confirmCalls = 0
  const value = fixture({
    confirmInstall: async () => {
      confirmCalls += 1
      return true
    }
  })
  try {
    assert.equal(value.handlers.has(APP_UPDATE_CHANNEL), true)
    assert.equal(value.updater.autoDownload, false)
    assert.equal(value.updater.autoInstallOnAppQuit, false)

    assert.equal((await value.invoke('check')).status.status, 'available')
    assert.equal((await value.invoke('download')).status.status, 'downloaded')
    const result = await value.invoke('install')

    assert.equal(result.ok, true)
    assert.equal(result.status.status, 'installing')
    assert.equal(confirmCalls, 1)
    assert.deepEqual(value.sent.at(-1), ['install'])
  } finally {
    value.cleanup()
  }
})

test('requires the exact registered local main frame and matching HTTP origin', async () => {
  const value = fixture()
  try {
    const remote = makeSender('http://remote.example/')
    const childFrame = { url: 'http://mica.local/' }
    const mismatchedOriginFrame = { url: 'http://remote.example/' }

    assert.equal((await value.invoke('status')).ok, true)
    assert.equal(
      (await value.invoke('check', { sender: remote.sender, senderFrame: remote.sender.mainFrame }))
        .code,
      'remote-window'
    )
    assert.equal(
      (await value.invoke('check', { sender: value.sender, senderFrame: childFrame })).code,
      'remote-window'
    )
    assert.equal(
      (await value.invoke('check', { sender: value.sender, senderFrame: mismatchedOriginFrame }))
        .code,
      'remote-window'
    )
  } finally {
    value.cleanup()
  }
})

test('coalesces concurrent native checks into one in-flight request', async () => {
  const request = deferred()
  let calls = 0
  const value = fixture({
    updaterOverrides: {
      checkForUpdates: () => {
        calls += 1
        return request.promise
      }
    }
  })
  try {
    const first = value.invoke('check')
    const second = value.invoke('check')
    await Promise.resolve()
    assert.equal(calls, 1)

    request.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.0.3' } })
    const results = await Promise.all([first, second])
    assert.equal(results[0].status.status, 'available')
    assert.equal(results[1].status.status, 'available')
    assert.equal(results[0].status.version, '1.0.3')
  } finally {
    value.cleanup()
  }
})

test('does not let a polling check replace a download in progress or a downloaded package', async () => {
  const downloadRequest = deferred()
  let checkCalls = 0
  const value = fixture({
    updaterOverrides: {
      checkForUpdates: async () => {
        checkCalls += 1
        return { isUpdateAvailable: true, updateInfo: { version: '1.0.2' } }
      },
      downloadUpdate: () => downloadRequest.promise
    }
  })
  try {
    await value.invoke('check')
    const download = value.invoke('download')
    await Promise.resolve()
    assert.equal(value.controller.getStatus().status, 'downloading')
    assert.equal((await value.invoke('check')).status.status, 'downloading')
    assert.equal(checkCalls, 1)

    value.listeners.get('update-downloaded')?.({ version: '1.0.2' })
    downloadRequest.resolve()
    await download
    assert.equal(value.controller.getStatus().status, 'downloaded')
    assert.equal((await value.invoke('check')).status.status, 'downloaded')
    assert.equal(checkCalls, 1)
  } finally {
    value.cleanup()
  }
})

test('does not let stale download progress overwrite a downloaded package', async () => {
  const value = await reachDownloaded()
  try {
    const before = value.controller.getStatus()
    value.listeners.get('download-progress')?.({ percent: 12 })
    assert.deepEqual(value.controller.getStatus(), before)
  } finally {
    value.cleanup()
  }
})

test('does not let a stale updater error erase a downloaded package', async () => {
  const value = await reachDownloaded()
  try {
    const before = value.controller.getStatus()
    value.listeners.get('error')?.(new Error('late native updater error'))
    assert.deepEqual(value.controller.getStatus(), before)
  } finally {
    value.cleanup()
  }
})

test('keeps the downloaded package when activity is busy, incomplete, or throws', async () => {
  const cases = [
    {
      name: 'busy',
      getActivity: () => ({ blockers: [{ kind: 'chats', label: '有 1 个会话仍在运行' }] }),
      code: 'busy'
    },
    { name: 'unknown', getActivity: () => ({}), code: 'activity-unavailable' },
    {
      name: 'throws',
      getActivity: () => {
        throw new Error('activity socket failed')
      },
      code: 'activity-unavailable'
    }
  ]

  for (const item of cases) {
    let confirmCalls = 0
    const value = await reachDownloaded({
      getActivity: item.getActivity,
      confirmInstall: async () => {
        confirmCalls += 1
        return true
      }
    })
    try {
      const result = await value.invoke('install')
      assert.equal(result.ok, false, item.name)
      assert.equal(result.code, item.code, item.name)
      assert.equal(value.controller.getStatus().status, 'downloaded', item.name)
      assert.equal(
        value.sent.some((entry) => entry[0] === 'install'),
        false,
        item.name
      )
      assert.equal(confirmCalls, 0, item.name)
    } finally {
      value.cleanup()
    }
  }
})

test('keeps the downloaded package when the user cancels confirmation', async () => {
  let confirmCalls = 0
  const value = await reachDownloaded({
    confirmInstall: async () => {
      confirmCalls += 1
      return false
    }
  })
  try {
    assert.deepEqual(await value.invoke('install'), { ok: false, code: 'cancelled' })
    assert.equal(confirmCalls, 1)
    assert.equal(value.controller.getStatus().status, 'downloaded')
    assert.equal(
      value.sent.some((entry) => entry[0] === 'install'),
      false
    )
  } finally {
    value.cleanup()
  }
})

test('rechecks activity after confirmation before installing', async () => {
  let activityCalls = 0
  const value = await reachDownloaded({
    getActivity: () => {
      activityCalls += 1
      return activityCalls === 1 ? { blockers: [] } : { blockers: [{ label: '有 1 个终端仍打开' }] }
    },
    confirmInstall: async () => true
  })
  try {
    const result = await value.invoke('install')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'busy')
    assert.equal(activityCalls, 2)
    assert.equal(value.controller.getStatus().status, 'downloaded')
    assert.equal(
      value.sent.some((entry) => entry[0] === 'install'),
      false
    )
  } finally {
    value.cleanup()
  }
})

test('rejects a second install while the first confirmation is pending', async () => {
  const confirmation = deferred()
  const value = await reachDownloaded({ confirmInstall: () => confirmation.promise })
  try {
    const first = value.invoke('install')
    await Promise.resolve()
    assert.deepEqual(await value.invoke('install'), {
      ok: false,
      code: 'busy',
      error: '更新确认正在进行，请勿重复操作'
    })
    confirmation.resolve(true)
    const result = await first
    assert.equal(result.ok, true)
    assert.equal(value.sent.filter((entry) => entry[0] === 'install').length, 1)
  } finally {
    value.cleanup()
  }
})

test('does not expose the native updater in development mode', async () => {
  const value = fixture({ isDev: true })
  try {
    assert.deepEqual(value.controller.getStatus(), {
      status: 'unsupported',
      version: null,
      progress: null,
      message: '当前运行的是源码 / 开发模式，不使用桌面自动安装器。',
      error: null,
      reason: 'development',
      releaseUrl: UPDATE_RELEASE_URL
    })
    const result = await value.invoke('check')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'unsupported')
    assert.equal(result.reason, 'development')
    assert.deepEqual(result.status, value.controller.getStatus())
  } finally {
    value.cleanup()
  }
})

test('classifies installer prerequisites instead of trusting app.isPackaged', () => {
  const base = {
    isPackaged: true,
    updater: {},
    platform: 'darwin',
    architecture: 'arm64',
    hasUpdateConfig: true,
    hasMacSignature: true
  }
  for (const [options, reason] of [
    [{ ...base, isDev: true }, 'development'],
    [{ ...base, isPackaged: false }, 'development'],
    [{ ...base, hasUpdateConfig: false }, 'local-build'],
    [{ ...base, platform: 'linux', architecture: 'x64', isAppImage: false }, 'appimage-required'],
    [{ ...base, hasMacSignature: false }, 'mac-signature-required'],
    [{ ...base, platform: 'freebsd' }, 'unsupported-platform'],
    [{ ...base, architecture: 'x64' }, 'unsupported-architecture'],
    [
      { ...base, platform: 'linux', architecture: 'arm64', isAppImage: true },
      'unsupported-architecture'
    ],
    [{ ...base, updater: null }, 'updater-disabled']
  ]) {
    const result = resolveUpdateCapability(options)
    assert.equal(result.supported, false)
    assert.equal(result.reason, reason)
    assert.equal(result.releaseUrl, UPDATE_RELEASE_URL)
    assert.ok(result.message)
  }
  for (const options of [
    { ...base, platform: 'darwin' },
    { ...base, platform: 'linux', architecture: 'x64', isAppImage: true }
  ]) {
    assert.equal(resolveUpdateCapability(options).supported, true)
  }
})

test('detects a stable macOS signing authority and rejects adhoc signatures', () => {
  const run =
    (stderr, status = 0) =>
    () => ({ status, stderr })
  assert.equal(
    hasMacUpdateSignature('/tmp/app', run('Authority=Developer ID Application: Mica\n')),
    true
  )
  assert.equal(hasMacUpdateSignature('/tmp/app', run('Authority=Apple Development: Mica\n')), false)
  assert.equal(hasMacUpdateSignature('/tmp/app', run('Signature=adhoc\n')), false)
  assert.equal(hasMacUpdateSignature('/tmp/app', run('', 1)), false)
  assert.equal(
    hasMacUpdateSignature('/tmp/app', () => {
      throw new Error('codesign failed')
    }),
    false
  )
})

test('dispose prevents a late native check from publishing or scheduling work', async () => {
  const request = deferred()
  const timers = []
  const value = fixture({
    updaterOverrides: { checkForUpdates: () => request.promise },
    setTimeoutImpl: (callback, delay) => {
      timers.push({ callback, delay })
      return null
    }
  })
  const first = value.invoke('check')
  await Promise.resolve()
  const sentBeforeDispose = value.sent.length
  value.cleanup()
  request.reject(new Error('late check failure'))
  const result = await first
  assert.equal(result.ok, true)
  assert.equal(value.sent.length, sentBeforeDispose)
  assert.equal(timers.length, 1)
})

test('stale update-downloaded events cannot turn an available package into downloaded', async () => {
  const value = fixture()
  try {
    await value.invoke('check')
    value.listeners.get('update-downloaded')?.({ version: '1.0.2' })
    assert.equal(value.controller.getStatus().status, 'available')
  } finally {
    value.cleanup()
  }
})

test('a downloaded event for another version is rejected without losing its diagnostic', async () => {
  const value = fixture()
  value.updater.downloadUpdate = async () =>
    value.listeners.get('update-downloaded')?.({ version: '1.0.1' })
  try {
    await value.invoke('check')
    const result = await value.invoke('download')
    assert.equal(result.ok, false)
    assert.equal(result.status.reason, 'version-mismatch')
    assert.equal(result.status.status, 'error')
  } finally {
    value.cleanup()
  }
})

test('dispose while a restart confirmation is pending cannot later start an installer', async () => {
  const confirmation = deferred()
  const started = deferred()
  const value = await reachDownloaded({
    confirmInstall: () => {
      started.resolve()
      return confirmation.promise
    }
  })
  const pending = value.invoke('install')
  await started.promise
  value.cleanup()
  confirmation.resolve(true)
  assert.equal((await pending).code, 'cancelled')
  assert.equal(
    value.sent.some((event) => event[0] === 'install'),
    false
  )
})

test('stale updater cache errors are distinguished from AppImage capability errors', async () => {
  const value = fixture({
    updaterOverrides: {
      checkForUpdates: async () => {
        throw Object.assign(new Error('old update file missing'), {
          code: 'ERR_UPDATER_OLD_FILE_NOT_FOUND'
        })
      }
    }
  })
  try {
    const result = await value.invoke('check')
    assert.equal(result.status.reason, 'stale-update-state')
  } finally {
    value.cleanup()
  }
})

test('packaged directory builds without app-update.yml never schedule or invoke the updater', async () => {
  let checks = 0
  let scheduled = 0
  const capability = resolveUpdateCapability({ isPackaged: true, updater: {}, platform: 'darwin' })
  const value = fixture({
    capability,
    updaterOverrides: {
      checkForUpdates: async () => {
        checks += 1
        throw new Error('ENOENT: app-update.yml')
      }
    },
    setTimeoutImpl: () => {
      scheduled += 1
      return null
    }
  })
  try {
    assert.equal(value.controller.getStatus().status, 'unsupported')
    assert.equal(value.controller.getStatus().reason, 'local-build')
    assert.equal(scheduled, 0)
    assert.equal(value.listeners.size, 0)
    for (const action of ['check', 'download', 'install']) {
      const result = await value.invoke(action)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'unsupported')
      assert.equal(result.reason, 'local-build')
      assert.equal(result.status.releaseUrl, UPDATE_RELEASE_URL)
      assert.doesNotMatch(result.error, /ENOENT|\/Users\//)
    }
    assert.equal(checks, 0)
  } finally {
    value.cleanup()
  }
})

test('null or incomplete native check results are not reported as up to date', async () => {
  for (const response of [null, undefined, {}]) {
    const value = fixture({ updaterOverrides: { checkForUpdates: async () => response } })
    try {
      const result = await value.invoke('check')
      assert.equal(result.ok, false)
      assert.notEqual(result.status.status, 'not-available')
      assert.equal(result.status.status, response === null ? 'unsupported' : 'error')
      if (response === null) assert.equal(result.reason, 'updater-disabled')
    } finally {
      value.cleanup()
    }
  }
})

test('native checks continue periodically but cannot erase a downloaded update', async () => {
  const timers = []
  let checks = 0
  const value = fixture({
    setTimeoutImpl: (callback, delay) => {
      timers.push({ callback, delay })
      return null
    },
    updaterOverrides: {
      checkForUpdates: async () => {
        checks += 1
        return { isUpdateAvailable: true, updateInfo: { version: '1.0.2' } }
      }
    }
  })
  try {
    assert.equal(timers[0].delay, 5000)
    await timers[0].callback()
    assert.equal(checks, 1)
    assert.equal(timers[1].delay, 600_000)
    await timers[1].callback()
    assert.equal(checks, 2)
    await value.invoke('download')
    await timers[2].callback()
    assert.equal(checks, 2)
    assert.equal(value.controller.getStatus().status, 'downloaded')
  } finally {
    value.cleanup()
  }
})

test('a download that resolves without a verified downloaded event cannot get stuck downloading', async () => {
  const value = fixture({ updaterOverrides: { downloadUpdate: async () => [] } })
  try {
    await value.invoke('check')
    const result = await value.invoke('download')
    assert.equal(result.ok, false)
    assert.equal(result.status.status, 'error')
    assert.equal(result.status.progress, null)
  } finally {
    value.cleanup()
  }
})

test('a missing platform feed is actionable and can recover on the next check', async () => {
  let fail = true
  const value = fixture({
    updaterOverrides: {
      checkForUpdates: async () => {
        if (fail)
          throw Object.assign(new Error('Cannot find channel latest-mac.yml 404'), {
            code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
          })
        return { isUpdateAvailable: false, updateInfo: { version: '1.0.0' } }
      }
    }
  })
  try {
    const result = await value.invoke('check')
    assert.equal(result.ok, false)
    assert.equal(result.status.reason, 'feed-unavailable')
    assert.ok(result.status.message)
    assert.equal(result.status.releaseUrl, UPDATE_RELEASE_URL)
    fail = false
    assert.equal((await value.invoke('check')).status.status, 'not-available')
    assert.equal(value.controller.getStatus().reason, undefined)
    assert.equal(value.controller.getStatus().message, null)
  } finally {
    value.cleanup()
  }
})

test('native macOS staging never queues a quit before the final activity check', async () => {
  const native = new EventEmitter()
  const started = deferred()
  let ready = false
  let busy = false
  let prepares = 0
  // Same listener ordering as MacUpdater: it tracks readiness, but does not quit.
  native.on('update-downloaded', () => {
    ready = true
  })
  native.checkForUpdates = () => {
    prepares += 1
    started.resolve()
  }
  const value = await reachDownloaded({
    getActivity: () => ({ blockers: busy ? [{ label: '准备期间又启动了一个会话' }] : [] }),
    prepareInstall: () => prepareMacInstaller({ nativeUpdater: native, isReady: () => ready })
  })
  try {
    const install = value.invoke('install')
    await started.promise
    assert.equal(
      value.sent.some((entry) => entry[0] === 'install'),
      false
    )
    busy = true
    native.emit('update-downloaded')
    assert.equal((await install).code, 'busy')
    assert.equal(value.controller.getStatus().status, 'downloaded')
    // A later native callback cannot trigger the cancelled quit.
    native.emit('update-downloaded')
    assert.equal(
      value.sent.some((entry) => entry[0] === 'install'),
      false
    )
    busy = false
    assert.equal((await value.invoke('install')).ok, true)
    assert.equal(prepares, 1)
    assert.equal(value.sent.filter((entry) => entry[0] === 'install').length, 1)
  } finally {
    value.cleanup()
  }
})

test('native preparation error removes listeners and preserves the downloaded package', async () => {
  const native = new EventEmitter()
  native.checkForUpdates = () => native.emit('error', new Error('stage failed'))
  const value = await reachDownloaded({
    prepareInstall: () => prepareMacInstaller({ nativeUpdater: native, isReady: () => false })
  })
  try {
    const result = await value.invoke('install')
    assert.equal(result.ok, false)
    assert.match(result.error, /stage failed/)
    assert.equal(value.controller.getStatus().status, 'downloaded')
    assert.equal(native.listenerCount('update-downloaded'), 0)
    assert.equal(native.listenerCount('error'), 0)
    assert.equal(
      value.sent.some((entry) => entry[0] === 'install'),
      false
    )
  } finally {
    value.cleanup()
  }
})
