/**
 * 桌面端的模型目录、角色清单与压缩命令。
 *
 * 三者都通过本机 `mica` CLI 的子进程完成，不把 CLI 运行时拖进 Electron 主进程；
 * 模型目录按配置 mtime + TTL 缓存，并发调用共用一次请求。
 */
import { spawn } from 'child_process'
import { readdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'
import { readDisabledPluginIds } from '@packages/mica-plugin/PluginState.js'
import { resolveMicaExecutable } from './mica-cli'
import { getShellEnvSnapshot } from './shell-env'
import {
  micaHomeDir,
  protocolForModelId,
  protocolForProviderId,
  readMicaConfig,
  readSessionCwd
} from './chat-session-read'
import { resolveUsableCwd } from './cwd-utils'

// Merge the login-shell environment captured at startup (e.g. exports from
// ~/.zshrc) into a spawned mica process. Falls back to the inherited env
// while the capture is still pending or unavailable.
export function mergeShellEnv(env) {
  const shellEnv = getShellEnvSnapshot()
  return shellEnv ? { ...env, ...shellEnv } : { ...env }
}

function runModelsCommand(mica, args) {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(mica, args, {
        env: mergeShellEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolvePromise({ ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }, 10000)
    timer.unref?.()
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      if (exitCode !== 0) {
        resolvePromise({
          ok: false,
          error: stderr.trim() || `mica models 退出（code ${exitCode}）`
        })
        return
      }
      resolvePromise({ ok: true, stdout })
    })
  })
}

/**
 * 模型目录的缓存。
 *
 * `chat:models` 每次都要起一个 `mica models --json` 进程（本机实测 0.2s，机器一忙
 * 就到 2–4s，日志里 `slow` 记录多的就是它），而它会话切换、打开模型选择器、判定档位
 * 都会调一次。目录本身只在配置变化时变，所以按「配置文件 mtime + TTL」缓存，并发
 * 调用共用一次请求。
 */
const MODELS_CACHE_TTL_MS = 10 * 60_000
let modelsCache = { key: null, at: 0, value: null }
let modelsInflight = null

function modelsCacheKey() {
  const file = join(micaHomeDir(), 'config.json')
  try {
    return `${file}:${statSync(file).mtimeMs}`
  } catch {
    return `${file}:missing`
  }
}

export async function listModels() {
  const key = modelsCacheKey()
  if (
    modelsCache.key === key &&
    modelsCache.value &&
    Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS
  ) {
    return modelsCache.value
  }
  if (modelsInflight && modelsInflight.key === key) return modelsInflight.promise
  const promise = loadModels()
    .then((value) => {
      // 失败不进缓存：下一次调用应该重新试，而不是把错误记十分钟。
      if (value?.ok) modelsCache = { key, at: Date.now(), value }
      return value
    })
    .finally(() => {
      if (modelsInflight?.promise === promise) modelsInflight = null
    })
  modelsInflight = { key, promise }
  return promise
}

async function loadModels() {
  const mica = resolveMicaExecutable()
  if (!mica) return { ok: false, error: '未找到 mica CLI，请先安装并确保 ~/.local/bin/mica 可用' }
  const { provider } = readMicaConfig()
  const buildResult = (entries) => ({
    ok: true,
    models: entries.map((entry) => ({
      id: entry.id,
      protocol: protocolForModelId(entry.id),
      efforts: Array.isArray(entry.efforts) ? entry.efforts : [],
      // 模型自己声明的默认档位：渲染层按它收敛展示，与 host 每轮实际发送的档位一致。
      defaultEffort: typeof entry.defaultEffort === 'string' ? entry.defaultEffort : null
    })),
    currentProtocol: protocolForProviderId(provider)
  })

  const result = await runModelsCommand(mica, ['models', '--json'])
  if (!result.ok) return { ok: false, error: result.error }
  try {
    const parsed = JSON.parse(result.stdout.trim())
    if (Array.isArray(parsed)) return buildResult(parsed)
  } catch {
    // 落到下面的统一错误
  }
  return { ok: false, error: 'mica models --json 输出不是模型列表' }
}

export function listRoles() {
  const names = new Set()
  const pluginRoles = new Map()
  try {
    for (const name of readdirSync(join(micaHomeDir(), 'role'))) {
      if (!name.endsWith('.md')) continue
      const role = basename(name, '.md')
      if (role) names.add(role)
    }
  } catch {
    // 没有 `role/` 目录是正常的：角色也可以完全由插件提供。
  }
  // 插件自带的角色（`$MICA_HOME/plugin-roles/<pluginId>.json`）：输入框的箭头要能切到它们，
  // 而读索引不需要为了一个名字去启动会话进程。同名时磁盘角色优先（与 `listAgentRoles` 一致）。
  // 停用的插件按 `plugins-state.json` 过滤：索引要等某个宿主对齐时才清，而角色箭头是
  // 「插件已经关掉了却还能切到它」的最后一条残留。
  const disabledPlugins = readDisabledPluginIds({ path: join(micaHomeDir(), 'plugins-state.json') })
  try {
    for (const file of readdirSync(join(micaHomeDir(), 'plugin-roles'))) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue
      let parsed = null
      try {
        parsed = JSON.parse(readFileSync(join(micaHomeDir(), 'plugin-roles', file), 'utf-8'))
      } catch {
        continue
      }
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.roles)) continue
      if (typeof parsed.pluginId === 'string' && disabledPlugins.has(parsed.pluginId)) continue
      for (const entry of parsed.roles) {
        const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
        if (name && !names.has(name)) {
          names.add(name)
          pluginRoles.set(name, {
            tag: 'plugin',
            ...(typeof parsed.pluginId === 'string' && parsed.pluginId.trim()
              ? { pluginId: parsed.pluginId.trim() }
              : {})
          })
        }
      }
    }
  } catch {
    // 没有插件角色就是没有
  }
  return {
    ok: true,
    roles: [...names]
      .sort()
      .map((name) => ({ name, ...(pluginRoles.get(name) || {}) }))
  }
}

export function runCompactSession(sessionId, mode = 'model') {
  const mica = resolveMicaExecutable()
  if (!mica) {
    return Promise.resolve({
      ok: false,
      error: '未找到 mica CLI，请先安装并确保 ~/.local/bin/mica 可用'
    })
  }
  // compact 进程必须落在会话自己的工作目录，否则 saveCurrent 会把
  // process.cwd()（Electron 主进程的 cwd，Finder 启动时通常是 /）写进会话文件，
  // 覆盖真实 cwd，导致后续恢复会话时工作目录错乱。
  // 这里只要 cwd，别为了它整份解析会话（最大的一份 52MB）。
  const sessionCwd = readSessionCwd(sessionId)
  // 会话记录的 cwd 可能因目录被移动/删除而失效，此时 spawn 会 ENOENT。
  // 先归一化为可用目录，避免压缩直接失败；回退信息随结果返回供 UI 提示。
  const resolved = resolveUsableCwd(sessionCwd || process.cwd())
  const compactCwd = resolved.cwd
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(
        mica,
        [
          'compact',
          '--session',
          sessionId,
          '--dir',
          compactCwd,
          // 「快速压缩（本地）」与交互式 /compact 同源：工具调用与结果聚合成一条占位
          // 调用、思考丢掉、媒体块换占位符；对话正文不动、不丢轮次。--prune-only 是
          // lossy 的（无内容可清理时会丢弃最早轮次），不要在这里使用。
          ...(mode === 'local' ? ['--tool-results-only'] : [])
        ],
        {
          cwd: compactCwd,
          env: mergeShellEnv(process.env),
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
    } catch (error) {
      resolvePromise({ ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    // 模型摘要可能耗时较长，放宽到 5 分钟
    const timer = setTimeout(
      () => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      },
      5 * 60 * 1000
    )
    timer.unref?.()
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      const lines = stdout
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      const lastLine = lines.at(-1) || ''
      try {
        const result = JSON.parse(lastLine)
        if (result && typeof result === 'object') {
          resolvePromise({
            ok: result.ok === true,
            code: result.code,
            error: result.error,
            cwdMissing: resolved.changed,
            originalCwd: resolved.original,
            resolvedCwd: resolved.cwd,
            mode: result.mode,
            strategy: result.strategy,
            beforeCount: result.beforeCount,
            afterCount: result.afterCount,
            summarizedCount: result.summarizedCount,
            keptCount: result.keptCount,
            beforeTokenEstimate: result.beforeTokenEstimate,
            afterTokenEstimate: result.afterTokenEstimate,
            savedTokenEstimate: result.savedTokenEstimate,
            savedRatio: result.savedRatio,
            contextWindowSize: result.contextWindowSize,
            contextUsageRatio: result.contextUsageRatio,
            toolResultsReplaced: result.toolResultsReplaced,
            mediaItemsReplaced: result.mediaItemsReplaced,
            toolCallsAggregated: result.toolCallsAggregated,
            reasoningItemsDropped: result.reasoningItemsDropped
          })
          return
        }
      } catch {
        // fall through to stderr error
      }
      resolvePromise({
        ok: false,
        error: stderr.trim() || `mica compact 退出（code ${exitCode}）`
      })
    })
  })
}
