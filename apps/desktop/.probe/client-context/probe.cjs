// Run from repository root: apps/desktop/node_modules/.bin/electron apps/desktop/.probe/client-context/probe.cjs
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mica-client-context-'))
process.env.MICA_HOME = path.join(scratch, 'home')
process.env.MICA_DESKTOP_USER_DATA = path.join(scratch, 'runtime')
process.env.MICA_DESKTOP_PORT = '0'
app.setPath('userData', path.join(scratch, 'profile'))
app.commandLine.appendSwitch('user-data-dir', path.join(scratch, 'profile'))
const windows = new Set()
const servers = []
let allowedCertificateOrigin = ''
app.on('certificate-error', (event, _contents, url, _error, _certificate, callback) => {
  if (new URL(url).origin !== allowedCertificateOrigin) return callback(false)
  event.preventDefault()
  callback(true)
})

const loadSource = async (relative) => {
  const text = fs.readFileSync(path.join(root, relative), 'utf8')
  return import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)
}
const listen = async (server) => {
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}
const page = (_req, res) => {
  res.setHeader('content-type', 'text/html')
  res.end(
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'"><body>Client window regression probe</body>`
  )
}

const timeout = setTimeout(() => {
  console.error('Probe timed out')
  app.exit(1)
}, 20000)
app
  .whenReady()
  .then(async () => {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        path.join(scratch, 'key.pem'),
        '-out',
        path.join(scratch, 'cert.pem')
      ],
      { stdio: 'ignore' }
    )
    const localOrigin = `http://127.0.0.1:${await listen(http.createServer(page))}`
    const remoteOrigin = `https://127.0.0.1:${await listen(
      https.createServer(
        {
          key: fs.readFileSync(path.join(scratch, 'key.pem')),
          cert: fs.readFileSync(path.join(scratch, 'cert.pem'))
        },
        page
      )
    )}`
    allowedCertificateOrigin = remoteOrigin
    const { CLIENT_CONTEXT_CHANNEL, createClientContextHandler, isClientSenderAllowed } =
      await loadSource('src/main/client-context.js')
    const create = async (origin, trusted = true) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          preload: path.join(root, 'src/preload/index.js')
        }
      })
      if (trusted) windows.add({ win, clientOrigin: origin })
      await win.loadURL(`${origin}/?t=probe-machine`)
      return win
    }
    const local = await create(localOrigin)
    let localNavigations = 0
    local.webContents.on('did-navigate', () => localNavigations++)
    await local.webContents.executeJavaScript('window.probeDraft = "retained draft"')
    local.hide()
    const remote = await create(remoteOrigin)
    let store = { peers: ['A', 'B', 'C'] }
    let localCalls = 0
    ipcMain.handle(
      CLIENT_CONTEXT_CHANNEL,
      createClientContextHandler({
        isAllowedSender: (event) => isClientSenderAllowed(windows, event),
        manifests: [{ id: 'probe', desktopClientData: true }],
        readDisabled: () => [],
        readData: () => ({ value: store, version: 'v1' }),
        writeData: (_id, value, options) => {
          assert.equal(options.expectedVersion, 'v1')
          store = value
          return { ok: true }
        },
        localHost: () => localOrigin,
        probe: (address) => ({ ok: true, url: address }),
        open: () => {},
        local: () => {
          localCalls++
          local.show()
          local.focus()
        }
      })
    )
    const clientSource = fs
      .readFileSync(path.join(root, 'src/renderer/src/client-context.js'), 'utf8')
      .replace('export function', 'function')
    const result = await remote.webContents.executeJavaScript(`(async () => {
    ${clientSource}
    // The client bridge must work even when browser fetch is entirely unavailable.
    window.fetch = () => { throw new Error('network blocked') }
    const api = createClientContextApi('probe')
    const context = await api.context()
    const data = await api.readData()
    await api.writeData({ peers: ['B', 'C'] }, { expectedVersion: 'v1' })
    const denied = await window.micaClient.readData('private-plugin')
    await api.local()
    return { context, data, denied }
  })()`)
    assert.equal(result.context.localHost, localOrigin)
    assert.deepEqual(result.data.value.peers, ['A', 'B', 'C'])
    assert.deepEqual(store.peers, ['B', 'C'])
    assert.equal(result.denied.ok, false)
    assert.equal(localCalls, 1)
    assert.equal(local.isVisible(), true)
    assert.equal(localNavigations, 0)
    assert.equal(await local.webContents.executeJavaScript('window.probeDraft'), 'retained draft')
    // Another same-origin top-level window must not inherit the registered window's authority.
    const unregistered = await create(remoteOrigin, false)
    assert.equal(
      (await unregistered.webContents.executeJavaScript('window.micaClient.local()')).ok,
      false
    )
    unregistered.destroy()
    console.log(
      'PASS: HTTPS page under self-only CSP uses native client data and CAS with fetch blocked'
    )
    console.log(
      'PASS: Local restores the original hidden window, retaining draft and avoiding navigation'
    )
    console.log('PASS: non-opted-in plugin data and unregistered same-origin windows are denied')
  })
  .then(
    () => finish(0),
    (error) => {
      console.error(error)
      finish(1)
    }
  )

function finish(code) {
  clearTimeout(timeout)
  for (const { win } of windows) if (!win.isDestroyed()) win.destroy()
  for (const server of servers) server.close()
  fs.rmSync(scratch, { recursive: true, force: true })
  app.exit(code)
}
