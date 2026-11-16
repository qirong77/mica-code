import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'bun:test'
import { APP_UPDATE_CHANNEL, createAppUpdateController, prepareMacInstaller } from './app-update.js'

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
  setTimeoutImpl
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
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) },
    updater,
    getWindows: () => registeredWindows,
    isDev,
    getActivity,
    confirmInstall,
    prepareInstall,
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
    assert.equal((await value.invoke('check', { sender: remote.sender, senderFrame: remote.sender.mainFrame })).code, 'remote-window')
    assert.equal((await value.invoke('check', { sender: value.sender, senderFrame: childFrame })).code, 'remote-window')
    assert.equal((await value.invoke('check', { sender: value.sender, senderFrame: mismatchedOriginFrame })).code, 'remote-window')
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
    { name: 'throws', getActivity: () => { throw new Error('activity socket failed') }, code: 'activity-unavailable' }
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
      assert.equal(value.sent.some((entry) => entry[0] === 'install'), false, item.name)
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
    assert.equal(value.sent.some((entry) => entry[0] === 'install'), false)
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
    assert.equal(value.sent.some((entry) => entry[0] === 'install'), false)
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
      message: null,
      error: null
    })
    assert.deepEqual(await value.invoke('check'), {
      ok: false,
      code: 'unsupported',
      error: '源码 / 开发模式不支持安装桌面更新'
    })
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
  native.on('update-downloaded', () => { ready = true })
  native.checkForUpdates = () => { prepares += 1; started.resolve() }
  const value = await reachDownloaded({
    getActivity: () => ({ blockers: busy ? [{ label: '准备期间又启动了一个会话' }] : [] }),
    prepareInstall: () => prepareMacInstaller({ nativeUpdater: native, isReady: () => ready })
  })
  try {
    const install = value.invoke('install')
    await started.promise
    assert.equal(value.sent.some((entry) => entry[0] === 'install'), false)
    busy = true
    native.emit('update-downloaded')
    assert.equal((await install).code, 'busy')
    assert.equal(value.controller.getStatus().status, 'downloaded')
    // A later native callback cannot trigger the cancelled quit.
    native.emit('update-downloaded')
    assert.equal(value.sent.some((entry) => entry[0] === 'install'), false)
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
    assert.equal(value.sent.some((entry) => entry[0] === 'install'), false)
  } finally {
    value.cleanup()
  }
})
