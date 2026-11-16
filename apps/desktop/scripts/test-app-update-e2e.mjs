#!/usr/bin/env node
// Real Electron IPC + HTTP download smoke. It never runs a native installer.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const cases = [
  'missing-config',
  'local-build-capability',
  'download-success',
  'downloaded-preserved',
  'busy-install',
  'cancel-install',
  'remote-window',
  'metadata-404',
  'bad-hash-retry',
  'not-available',
  'downgrade',
  'dmg-only'
]

// Electron waits for entry-module evaluation before emitting ready. Do not
// top-level-await the smoke, which itself waits for app.whenReady().
if (process.argv[2] === '--electron-child') void runCase(process.argv[3], process.argv[4])
else await main()

async function main() {
  if (process.platform !== 'darwin') {
    console.log(`SKIP: this real MacUpdater smoke requires macOS (host is ${process.platform})`)
    return
  }
  const electron = require('../node_modules/electron')
  await mkdir(join(root, 'temp'), { recursive: true })
  let passed = 0
  for (const name of cases) {
    const temp = await mkdtemp(join(root, 'temp/app-update-e2e-'))
    const userData = join(temp, 'user-data')
    const home = join(temp, 'mica-home')
    await Promise.all([mkdir(userData), mkdir(home)])
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/^(MICA_(?!UPDATE_E2E_DEBUG)|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(key))
        delete env[key]
    }
    Object.assign(env, {
      MICA_HOME: home,
      MICA_DESKTOP_USER_DATA: userData,
      MICA_DESKTOP_PORT: '0'
    })
    try {
      const result = await new Promise((done) => {
        const proc = spawn(
          electron,
          [
            fileURLToPath(import.meta.url),
            '--electron-child',
            name,
            temp,
            `--user-data-dir=${userData}`
          ],
          { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }
        )
        let output = ''
        let timedOut = false
        let forceTimer
        proc.stdout.on('data', (chunk) => {
          output += chunk
        })
        proc.stderr.on('data', (chunk) => {
          output += chunk
        })
        const timer = setTimeout(() => {
          timedOut = true
          proc.kill('SIGTERM')
          forceTimer = setTimeout(() => proc.kill('SIGKILL'), 2000)
        }, 20_000)
        proc.on('error', (error) => {
          output += error.stack
        })
        proc.once('close', (code) => {
          clearTimeout(timer)
          clearTimeout(forceTimer)
          done({ code, output, timedOut })
        })
      })
      if (result.code !== 0 || result.timedOut || !result.output.includes(`CASE-PASS ${name}`)) {
        throw new Error(
          `${name}: exit=${result.code}, timedOut=${result.timedOut}\n${result.output}`
        )
      }
      console.log(`PASS ${name}`)
      passed += 1
    } catch (error) {
      console.error(error.stack)
      process.exitCode = 1
      break
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }
  console.log(
    `${passed}/${cases.length} passed; real Electron/preload/IPC/HTTP/MacUpdater downloads; synthetic ZIP and app adapter only. Native installation, app replacement, signing, keychain and GitHub writes were NOT executed.`
  )
}

async function runCase(name, temp) {
  let app, server, controller, updater, win
  let exitCode = 1
  let installCalls = 0
  const debug = (...args) => {
    if (process.env.MICA_UPDATE_E2E_DEBUG) console.error('[e2e]', name, ...args)
  }
  try {
    assert(cases.includes(name), `unknown case: ${name}`)
    const electron = await import('electron')
    app = electron.app
    debug('electron imported')
    app.setPath('userData', join(temp, 'user-data'))
    debug('userData set', join(temp, 'user-data'))
    await app.whenReady()
    debug('app ready')
    const { MacUpdater } = require('../node_modules/electron-updater/out/MacUpdater.js')
    const {
      ElectronHttpExecutor
    } = require('../node_modules/electron-updater/out/electronHttpExecutor.js')
    const { createAppUpdateController, resolveUpdateCapability } = await import(
      pathToFileURL(join(root, 'apps/desktop/src/main/app-update.js'))
    )
    const rendererSource = readFileSync(
      join(root, 'apps/desktop/src/renderer/src/app-update.js'),
      'utf8'
    )
    const payload = Buffer.alloc(256 * 1024, 77)
    const digest = (bytes) => createHash('sha512').update(bytes).digest('base64')
    const expectedHash = digest(payload)
    let corrupted = name === 'bad-hash-retry'
    const requests = []
    server = createServer((req, res) => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname
      requests.push(path)
      if (path === '/')
        return reply(
          res,
          'text/html',
          '<!doctype html><script>window.ready=import("/renderer-app-update.js").then(m=>{window.runNativeUpdate=m.runNativeUpdate})</script>'
        )
      if (path === '/renderer-app-update.js') return reply(res, 'text/javascript', rendererSource)
      if (path === '/latest-mac.yml') {
        if (name === 'metadata-404') {
          res.writeHead(404)
          res.end('missing metadata')
          return
        }
        const version =
          name === 'not-available' ? '1.0.0' : name === 'downgrade' ? '0.9.0' : '1.0.1'
        return reply(
          res,
          'text/yaml',
          JSON.stringify({
            version,
            files: [
              {
                url: name === 'dmg-only' ? 'update.dmg' : 'update.zip',
                sha512: expectedHash,
                size: payload.length
              }
            ]
          })
        )
      }
      if (path === '/update.zip' || path === '/update.dmg') {
        return reply(
          res,
          'application/octet-stream',
          corrupted ? Buffer.alloc(payload.length, 88) : payload
        )
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const origin = `http://127.0.0.1:${server.address().port}`
    const configPath = join(temp, 'app-update.yml')
    if (name !== 'missing-config')
      await writeFile(
        configPath,
        `provider: generic\nurl: ${origin}/\nupdaterCacheDirName: updater\n`
      )
    const adapter = {
      version: '1.0.0',
      name: 'MicaUpdaterE2E',
      isPackaged: true,
      whenReady: () => app.whenReady(),
      appUpdateConfigPath: configPath,
      userDataPath: join(temp, 'user-data'),
      baseCachePath: join(temp, 'cache'),
      onQuit: () => {},
      quit: () => {
        throw new Error('app quit forbidden in smoke')
      },
      relaunch: () => {
        throw new Error('app relaunch forbidden in smoke')
      }
    }
    updater = new MacUpdater(undefined, adapter)
    debug('updater created')
    updater.logger = null
    updater.httpExecutor = new ElectronHttpExecutor()
    updater.autoInstallOnAppQuit = false
    updater.autoDownload = false
    updater.disableDifferentialDownload = true
    updater.quitAndInstall = () => {
      installCalls += 1
      throw new Error('native install forbidden in smoke')
    }
    let downloadedFile
    updater.on('update-downloaded', (info) => {
      downloadedFile = info.downloadedFile
    })
    if (name === 'missing-config') {
      debug('checking missing config')
      await assert.rejects(() => updater.checkForUpdates(), /ENOENT/)
      debug('missing config rejected')
      assert(!requests.includes('/latest-mac.yml'))
    } else {
      const capability = resolveUpdateCapability({
        isPackaged: true,
        updater,
        platform: 'darwin',
        hasUpdateConfig: name !== 'local-build-capability',
        hasMacSignature: true
      })
      const windows = new Set()
      const state = { local: name !== 'remote-window', clientOrigin: origin, win: null }
      let preparationCalls = 0
      controller = createAppUpdateController({
        ipcMain: electron.ipcMain,
        updater,
        capability,
        getWindows: () => windows,
        getActivity: async () => ({
          blockers: name === 'busy-install' ? [{ label: 'synthetic busy work' }] : []
        }),
        confirmInstall: async () => name !== 'cancel-install',
        prepareInstall: async () => {
          preparationCalls += 1
          throw new Error('native staging forbidden in smoke')
        }
      })
      controller.register()
      debug('controller registered')
      win = new electron.BrowserWindow({
        show: false,
        webPreferences: {
          preload: join(root, 'apps/desktop/src/preload/index.js'),
          contextIsolation: true,
          sandbox: true
        }
      })
      state.win = win
      windows.add(state)
      await win.loadURL(origin)
      debug('window loaded')
      await win.webContents.executeJavaScript('window.ready')
      const invoke = (status = null) =>
        win.webContents.executeJavaScript(
          `window.runNativeUpdate({bridge:window.micaClient.appUpdate,currentStatus:${JSON.stringify(status)}})`
        )
      const result = await invoke()
      if (name === 'local-build-capability' || name === 'remote-window') {
        assert.equal(result.kind, 'source')
        assert.equal(result.reason, name === 'remote-window' ? 'remote-window' : 'local-build')
        assert(!requests.includes('/latest-mac.yml'))
      } else if (name === 'metadata-404') {
        assert.equal(result.kind, 'error')
        assert.equal(result.status.reason, 'feed-unavailable')
      } else if (name === 'not-available' || name === 'downgrade') {
        assert.equal(result.kind, 'source')
        assert.equal(result.reason, 'no-package')
        assert(!requests.includes('/update.zip'))
      } else if (name === 'dmg-only') {
        assert.equal(result.kind, 'error')
        assert.equal(result.status.reason, 'package-unavailable')
        assert(!requests.includes('/update.dmg'))
      } else {
        if (name === 'bad-hash-retry') {
          assert.equal(result.kind, 'error')
          assert.equal(controller.getStatus().status, 'error')
          assert(requests.includes('/update.zip'))
          corrupted = false
          const retry = await invoke()
          assert.equal(retry.kind, 'download')
          assert.equal(retry.result.ok, true)
        } else {
          assert.equal(result.kind, 'download')
          assert.equal(result.result.ok, true)
        }
        assert.equal(controller.getStatus().status, 'downloaded')
        assert(requests.includes('/latest-mac.yml') && requests.includes('/update.zip'))
        assert(downloadedFile, 'real updater did not report a cache file')
        assert.equal(digest(readFileSync(downloadedFile)), expectedHash)
        if (name === 'downloaded-preserved') {
          const status = await win.webContents.executeJavaScript(
            'window.micaClient.appUpdate.check()'
          )
          assert.equal(status.status.status, 'downloaded')
        }
        if (name === 'busy-install' || name === 'cancel-install') {
          const install = await invoke('downloaded')
          assert.equal(install.result.code, name === 'busy-install' ? 'busy' : 'cancelled')
          assert.equal(controller.getStatus().status, 'downloaded')
        }
        assert.equal(preparationCalls, 0)
      }
    }
    assert.equal(installCalls, 0)
    console.log(`CASE-PASS ${name}`)
    exitCode = 0
  } catch (error) {
    console.error(error.stack)
  } finally {
    debug('cleanup', exitCode)
    try {
      controller?.dispose()
    } catch (error) {
      console.error(error)
      exitCode = 1
    }
    try {
      updater?.closeServerIfExists?.()
    } catch (error) {
      console.error(error)
      exitCode = 1
    }
    try {
      win?.destroy()
    } catch (error) {
      console.error(error)
      exitCode = 1
    }
    if (server) await new Promise((done) => server.close(done))
    // Do not mask a failed assertion with a successful Electron exit.
    if (app) {
      app.exit(exitCode)
      setTimeout(() => process.exit(exitCode), 1000).unref()
    } else process.exitCode = exitCode
  }
}

function reply(res, type, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store'
  })
  res.end(bytes)
}
