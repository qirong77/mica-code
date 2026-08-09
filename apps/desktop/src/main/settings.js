import { app, ipcMain } from 'electron'
import { execFile, spawn } from 'child_process'
import { readFileSync, statSync } from 'fs'
import os from 'os'
import { basename, join, resolve } from 'path'

/**
 * Settings 视图：拉起/复用 mica 的 Config Web（mica --config-web-worker），
 * 返回可在渲染进程 iframe 中加载的本地 URL。
 *
 * 复用策略与 apps/config-web 的 startConfigWeb 一致但更宽容：
 * 1. 先探测 ~/.mica/config-web.json 记录的端口；
 * 2. 再探测默认端口 13987（交互式 mica /config 启动的 worker 可能还活着，
 *    但其状态文件可能已被后来死掉的 worker 覆盖成陈旧内容）；
 * 3. 都不行才 spawn 一个新的持久 worker，并跟踪它以便退出时清理；
 * 4. 新 worker 因端口占用等原因崩溃时，回退再探测一次。
 */
const DEFAULT_PORT = 13987
const CONFIG_WEB_WAIT_TIMEOUT_MS = 8000
const PROBE_TIMEOUT_MS = 500
const SPAWN_PROBE_INTERVAL_MS = 120

let managedChild = null
let pending = null

function micaHome() {
  return process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : join(app.getPath('home'), '.mica')
}

function configWebStatePath() {
  return join(micaHome(), 'config-web.json')
}

function readConfigWebState() {
  try {
    const parsed = JSON.parse(readFileSync(configWebStatePath(), 'utf8'))
    return parsed && Number.isInteger(parsed.port) ? parsed : null
  } catch {
    return null
  }
}

async function probeConfigWeb(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    return response.ok
  } catch {
    return false
  }
}

function isExecutable(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function execFileText(file, args) {
  return new Promise((done) => {
    execFile(file, args, { timeout: 4000 }, (error, stdout) => {
      done(error ? '' : String(stdout).trim())
    })
  })
}

/** 定位 mica CLI：MICA_CLI_PATH 显式指定 > 默认安装位置 > 登录 shell 的 PATH */
async function resolveMicaCli() {
  const explicit = (process.env.MICA_CLI_PATH || '').trim()
  if (explicit) {
    const candidate = resolve(explicit)
    if (isExecutable(candidate)) return candidate
  }

  const defaultPath = join(os.homedir(), '.local', 'bin', 'mica')
  if (isExecutable(defaultPath)) return defaultPath

  // 从 Dock 启动的应用 PATH 精简，走登录 shell 才能拿到用户的完整 PATH（与内置终端一致）
  const shell = process.env.SHELL || '/bin/zsh'
  const shellName = basename(shell).toLowerCase()
  const flags = shellName === 'fish' ? '-lc' : '-ilc'
  const resolved = await execFileText(shell, [flags, 'command -v mica'])
  return resolved && isExecutable(resolved) ? resolved : null
}

function waitForConfigWeb(previousPid, child) {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + CONFIG_WEB_WAIT_TIMEOUT_MS
    let settled = false
    const finish = (done, value) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      if (child) child.removeListener('exit', onExit)
      done(value)
    }
    const fail = (error) => finish(reject, error)
    const succeed = (state) => finish(resolvePromise, state)
    const onExit = () => fail(new Error('配置页面进程意外退出'))
    const tick = async () => {
      const state = readConfigWebState()
      if (state && state.pid !== previousPid && (await probeConfigWeb(state.port))) {
        succeed(state)
        return
      }
      if (Date.now() >= deadline) fail(new Error('配置页面启动超时'))
    }
    const timer = setInterval(() => void tick(), SPAWN_PROBE_INTERVAL_MS)
    if (child) child.once('exit', onExit)
  })
}

async function startConfigWebWorker(cliPath, previousPid) {
  const child = spawn(cliPath, ['--config-web-worker'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      MICA_CONFIG_WEB_PERSIST: '1',
      MICA_CONFIG_WEB_HOST: '127.0.0.1'
    }
  })
  managedChild = child
  const release = () => {
    if (managedChild === child) managedChild = null
  }
  child.once('exit', release)
  child.once('error', release)
  child.unref()
  try {
    return await waitForConfigWeb(previousPid, child)
  } catch (error) {
    release()
    try {
      child.kill('SIGTERM')
    } catch {
      // 进程已退出
    }
    throw error
  }
}

async function ensureConfigWeb() {
  const reuse = (port) => ({ url: `http://127.0.0.1:${port}`, port, reused: true })

  const existing = readConfigWebState()
  if (existing && (await probeConfigWeb(existing.port))) return reuse(existing.port)
  if (await probeConfigWeb(DEFAULT_PORT)) return reuse(DEFAULT_PORT)

  const cliPath = await resolveMicaCli()
  if (!cliPath) {
    throw new Error(
      '未找到 mica CLI：请先安装 mica-code（~/.local/bin/mica），或设置 MICA_CLI_PATH 环境变量指向 mica 可执行文件'
    )
  }

  try {
    const state = await startConfigWebWorker(cliPath, existing?.pid)
    return { url: `http://127.0.0.1:${state.port}`, port: state.port, reused: false }
  } catch (error) {
    // 新 worker 可能因端口被占用而崩溃（例如刚好有另一个 config web 在启动）；
    // 崩溃后重新探测，能复用就复用，避免误报失败。
    const fallback = readConfigWebState()
    if (fallback && (await probeConfigWeb(fallback.port))) return reuse(fallback.port)
    if (await probeConfigWeb(DEFAULT_PORT)) return reuse(DEFAULT_PORT)
    throw error
  }
}

export function registerSettingsIpc() {
  ipcMain.handle('settings:open', () => {
    if (!pending) {
      pending = ensureConfigWeb().finally(() => {
        pending = null
      })
    }
    return pending
  })
}

export function disposeSettings() {
  if (!managedChild) return
  const child = managedChild
  managedChild = null
  try {
    child.kill('SIGTERM')
  } catch {
    // 进程已退出
  }
}
