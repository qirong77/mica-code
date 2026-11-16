import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { APP_UPDATE_CHANNEL, createAppUpdateController } from './app-update.js'

function fixture({ isDev = false } = {}) {
  const handlers = new Map()
  const sent = []
  const listeners = new Map()
  const sender = {}
  const state = {
    local: true,
    win: {
      isDestroyed: () => false,
      webContents: { send: (...args) => sent.push(args), ...sender }
    }
  }
  const updater = {
    on(name, fn) {
      listeners.set(name, fn)
    },
    async checkForUpdates() {
      listeners.get('update-available')?.({ version: '1.0.2' })
    },
    async downloadUpdate() {
      listeners.get('update-downloaded')?.({ version: '1.0.2' })
    },
    quitAndInstall: () => sent.push(['install'])
  }
  const controller = createAppUpdateController({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    updater,
    app: {},
    getWindows: () => [state],
    isDev
  })
  controller.register()
  return { controller, handlers, sender: state.win.webContents, sent }
}

test('publishes available, downloaded and install states only to the local window', async () => {
  const { handlers, sender, sent } = fixture()
  assert.equal(handlers.has(APP_UPDATE_CHANNEL), true)
  const invoke = handlers.get(APP_UPDATE_CHANNEL)
  assert.deepEqual(await invoke({ sender }, 'check'), {
    ok: true,
    status: { status: 'available', version: '1.0.2', progress: null, message: null, error: null }
  })
  assert.deepEqual(await invoke({ sender }, 'download'), {
    ok: true,
    status: { status: 'downloaded', version: '1.0.2', progress: 100, message: null, error: null }
  })
  assert.deepEqual(await invoke({ sender }, 'install'), {
    ok: true,
    status: { status: 'installing' }
  })
  assert.deepEqual(sent.at(-1), ['install'])
})

test('does not expose the native updater in development mode', async () => {
  const { controller, handlers, sender } = fixture({ isDev: true })
  assert.deepEqual(controller.getStatus(), {
    status: 'unsupported',
    version: null,
    progress: null,
    message: null,
    error: null
  })
  assert.deepEqual(await handlers.get(APP_UPDATE_CHANNEL)({ sender }, 'check'), {
    ok: false,
    error: '开发模式不支持安装桌面更新'
  })
})

test('rejects update calls from a remote window', async () => {
  const { handlers } = fixture()
  assert.deepEqual(await handlers.get(APP_UPDATE_CHANNEL)({ sender: {} }, 'check'), {
    ok: false,
    error: '只有本机 Mica 窗口可以更新应用'
  })
})
