import { isRecord } from '@packages/mica-common/guards.js';
import { AsyncLocalStorage } from 'node:async_hooks'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createPluginBackgroundScheduler } from '@packages/mica-plugin/PluginBackground.js'
import { createPluginHealthStore } from '@packages/mica-plugin/PluginHealth.js'
import { createPluginLogger } from '@packages/mica-plugin/PluginLog.js'
import { createPluginSettingsStore } from '@packages/mica-plugin/PluginSettings.js'
import { awaitOperation, observePluginOperation } from '@packages/mica-diagnostics/operation.js'
import { readPluginData, writePluginData } from './plugin-data-store.js'

// The HTTP gateway owns request cancellation; keep it out of serialized plugin
// input and preserve it across the existing IPC adapter's three-argument call.
const requestContext = new AsyncLocalStorage()
export function withPluginLauncherRequest(options, task) {
  return requestContext.run(options, task)
}

const ENTRY_GONE = '插件已停用或没有桌面启动器'
/**
 * Launchers are allowed to poll fast: a clipboard watcher asks for 500ms and a
 * one-second floor would visibly lag. Chat-host background tasks keep the default.
 */
const LAUNCHER_MIN_INTERVAL_MS = 100
const DATA_DIRECTORY_MODE = 0o700
/** Same shape `PluginHealth` accepts as an issue key; a task id is plugin input. */
const ISSUE_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** `background:<taskId>`, or null when the task id cannot form a valid issue key. */
function backgroundIssueKey(taskId) {
  const key = `background:${taskId}`
  return ISSUE_KEY_PATTERN.test(key) ? key : null
}

/**
 * One runtime per enabled bundled launcher, independent of chat hosts.
 *
 * Each manifest declaring `desktop.launcher` owns one entry: its settings store,
 * a background scheduler scoped to the plugin, and (lazily, or eagerly when the
 * manifest declares `background: true`) the backend returned by
 * `createLauncher(context)`. Disabling a plugin disposes both the scheduler and the
 * backend; re-enabling rebuilds them from scratch, so nothing survives a stop.
 *
 * `control` is the optional native adapter (the desktop host passes its private
 * system-socket client). Without it the backend still loads and `ctx.control`
 * rejects, which lets a plugin show「当前宿主不支持」instead of failing to start.
 */
export function createPluginLauncherRuntime({
  manifests,
  loaders,
  home,
  readDisabled,
  control = null,
  logger = null
}) {
  const entries = new Map()
  let closed = false

  const loggerFor = (manifest) =>
    logger
      ? logger(manifest)
      : createPluginLogger(manifest.id, undefined, { pluginVersion: manifest.version })

  function createScheduler(entry) {
    return createPluginBackgroundScheduler({
      pluginId: entry.manifest.id,
      minIntervalMs: LAUNCHER_MIN_INTERVAL_MS,
      onError: (taskId, error, info) => {
        entry.log.error('launcher.background', {
          taskId,
          tick: info.tick,
          failures: info.failures,
          message: messageOf(error)
        })
        // Report on entering the failure state, not on every failing tick: a 500ms
        // task that keeps failing must not rewrite the health file ten times a
        // second. The task's next successful round clears this one issue.
        if (entry.failedBackgroundTasks.has(taskId)) return
        const issueKey = backgroundIssueKey(taskId)
        if (!issueKey) return
        entry.failedBackgroundTasks.add(taskId)
        entry.health.report({
          issueKey,
          level: 'error',
          message: `后台任务 ${taskId} 执行失败：${messageOf(error)}`
        })
      }
    })
  }

  function createEntry(manifest) {
    const entry = {
      manifest,
      log: loggerFor(manifest),
      health: createPluginHealthStore(manifest.id, { configDir: home, version: manifest.version }),
      scheduler: null,
      loading: null,
      handler: null,
      failedBackgroundTasks: new Set(),
      disposed: false
    }
    entry.scheduler = createScheduler(entry)
    return entry
  }

  /** `ctx.background`: same scheduler, plus a health issue per failing task. */
  function backgroundApi(entry) {
    return {
      register(task) {
        const issueKey = backgroundIssueKey(task.id)
        const disposable = entry.scheduler.register({
          ...task,
          run: async (context) => {
            const result = await task.run(context)
            // Clear only on a real recovery, and only this task's issue: successful
            // ticks otherwise stay off the disk entirely.
            if (entry.failedBackgroundTasks.delete(task.id) && issueKey) {
              entry.health.clear(issueKey)
            }
            return result
          }
        })
        // A previous run of this launcher may have left an issue behind; remember it
        // so the first successful round clears it once (a read, never a write).
        if (issueKey && entry.health.read(issueKey)) {
          entry.failedBackgroundTasks.add(task.id)
        }
        return disposable
      },
      list: () => entry.scheduler.list(),
      disposeAll: () => entry.scheduler.disposeAll()
    }
  }

  async function runControl(pluginId, action, input) {
    if (typeof action !== 'string' || !action.trim()) throw new Error('启动器控制动作无效')
    if (typeof control !== 'function') throw new Error('当前宿主不支持启动器原生控制')
    // The runtime owns the identity: whatever the plugin passes in must not be
    // able to redirect a native action to another plugin's launcher.
    const payload = isRecord(input) ? { ...input } : {}
    payload.pluginId = pluginId
    payload.action = action
    return control(payload)
  }

  function createContext(entry) {
    const pluginId = entry.manifest.id
    const dataDirectory = join(home, 'plugin-data', pluginId)
    mkdirSync(dataDirectory, { recursive: true, mode: DATA_DIRECTORY_MODE })
    try {
      // Existing directories keep whatever mode they were created with; a launcher
      // may store clipboard history here, so normalise it to owner-only.
      chmodSync(dataDirectory, DATA_DIRECTORY_MODE)
    } catch {
      // A filesystem that cannot chmod (or a directory owned elsewhere) is not
      // worth failing the launcher over.
    }
    const settings = createPluginSettingsStore(pluginId, entry.manifest.settings ?? [], {
      configDir: home
    })
    return {
      pluginId,
      dataDirectory,
      settings: { get: () => settings.get(), set: (values) => settings.set(values) },
      background: backgroundApi(entry),
      health: entry.health,
      readData: () => readPluginData(home, pluginId),
      writeData: (value, options) => writePluginData(home, pluginId, value, options),
      control: (action, input) => runControl(pluginId, action, input)
    }
  }

  /**
   * Build the backend once per entry. A failed build releases whatever it created
   * (registered tasks included) so a retry starts clean; an in-flight build that
   * finishes after dispose releases its handler instead of leaving it running.
   */
  function initialize(entry) {
    if (entry.handler) return Promise.resolve(entry.handler)
    if (entry.loading) return entry.loading
    const pending = (async () => {
      try {
        const loader = loaders.get(entry.manifest.id)
        if (!loader) throw new Error('这个插件没有随包桌面启动器模块')
        const module = await loader()
        if (entry.disposed) throw new Error(ENTRY_GONE)
        const handler = await module.default(createContext(entry))
        if (typeof handler?.request !== 'function') {
          await handler?.dispose?.()
          throw new Error('启动器没有提供 request 处理器')
        }
        if (entry.disposed) {
          await handler.dispose?.()
          throw new Error(ENTRY_GONE)
        }
        entry.handler = handler
        // Only touch the file when a previous attempt actually left an issue.
        if (entry.health.read('launcher.init')) entry.health.clear('launcher.init')
        return handler
      } catch (error) {
        if (!entry.disposed) {
          entry.health.report({
            issueKey: 'launcher.init',
            level: 'error',
            message: `桌面启动器初始化失败：${messageOf(error)}`
          })
        }
        // Whatever the half-built backend registered must not outlive the failure.
        entry.scheduler.disposeAll()
        if (!entry.disposed) entry.scheduler = createScheduler(entry)
        throw error
      }
    })()
    entry.loading = pending
    const clear = () => {
      if (entry.loading === pending) entry.loading = null
    }
    pending.then(clear, clear)
    return pending
  }

  async function disposeHandler(entry, handler) {
    try {
      await handler.dispose?.()
    } catch (error) {
      entry.log.error('launcher.dispose', { message: messageOf(error) })
    }
  }

  /**
   * Release one entry. The scheduler goes first (it aborts a running tick), then
   * the backend. A backend still initialising is awaited here: its `initialize`
   * sees `disposed` and disposes the handler it just built, so closing during a
   * slow start cannot leak the background tasks it registered.
   */
  async function disposeEntry(entry) {
    entry.disposed = true
    entry.scheduler.disposeAll()
    const handler = entry.handler
    entry.handler = null
    if (entry.loading) await entry.loading.catch(() => null)
    if (handler) await disposeHandler(entry, handler)
  }

  /**
   * Align running backends with `plugins-state.json`.
   *
   * `eager` is what `sync()` passes: manifests declaring `background: true` get
   * their backend built right away instead of waiting for the first window. Plain
   * launchers are only registered here and stay lazy — requests to them (or to
   * another plugin) do not pay for somebody else's startup.
   */
  async function reconcile({ eager = false } = {}) {
    if (closed) throw new Error('桌面启动器运行时已关闭')
    const disabled = readDisabled()
    const disposals = []
    for (const [id, entry] of [...entries]) {
      if (!disabled.has(id)) continue
      entries.delete(id)
      disposals.push(disposeEntry(entry))
    }
    const started = []
    for (const manifest of manifests) {
      if (!manifest.desktopLauncher || disabled.has(manifest.id)) continue
      let entry = entries.get(manifest.id)
      if (!entry) {
        entry = createEntry(manifest)
        entries.set(manifest.id, entry)
      }
      // A request may have registered this entry first (`reconcile()` without
      // `eager`); the state sync still has to start its backend.
      if (eager && manifest.desktopLauncher.background && !entry.handler && !entry.loading) {
        started.push(
          initialize(entry).catch((error) => {
            // Disposal during startup is not a plugin failure worth a log line.
            if (!entry.disposed) entry.log.error('launcher.init', { message: messageOf(error) })
          })
        )
      }
    }
    await Promise.all(disposals)
    await Promise.all(started)
  }

  function sync() {
    return reconcile({ eager: true })
  }

  function manifestOf(pluginId) {
    if (closed) throw new Error('桌面启动器运行时已关闭')
    const manifest = manifests.find((item) => item.id === pluginId && item.desktopLauncher)
    if (!manifest || readDisabled().has(pluginId)) throw new Error(ENTRY_GONE)
    return manifest
  }

  async function request(pluginId, action, input, options = requestContext.getStore() ?? {}) {
    const manifest = manifests.find((item) => item.id === pluginId && item.desktopLauncher)
    const plugin = manifest?.id ?? 'unknown'
    return observePluginOperation(
      {
        plugin,
        pluginVersion: manifest?.version,
        surface: 'launcher',
        operation: 'launcher.request',
        signal: options.signal
      },
      () => executeRequest(pluginId, action, input, options)
    )
  }

  async function executeRequest(pluginId, action, input, { signal }) {
    await awaitOperation(() => reconcile(), signal)
    manifestOf(pluginId)
    if (typeof action !== 'string' || !action || action.length > 80)
      throw new Error('启动器动作无效')
    const entry = entries.get(pluginId)
    if (!entry || entry.disposed) throw new Error(ENTRY_GONE)
    // One caller aborting its wait must not invalidate a backend another request
    // is still loading: the shared promise keeps running and the entry owns it.
    const handler = await awaitOperation(() => initialize(entry), signal)
    manifestOf(pluginId)
    if (entry.disposed) throw new Error(ENTRY_GONE)
    return awaitOperation(() => handler.request(action, input, { signal }), signal)
  }

  return {
    request,
    sync,
    manifestOf,
    async close() {
      closed = true
      const pending = [...entries.values()]
      entries.clear()
      await Promise.all(pending.map((entry) => disposeEntry(entry).catch(() => null)))
    }
  }
}
