import { clipboard, ipcMain } from 'electron'
import { spawn } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { resolveMicaExecutable } from './terminals'
import { appendBufferedEvent, buildChatArgs, createChatEventPacer } from './chat-events'
import { savePastedImage } from './chat-images'

/**
 * Mica chat service: runs one `mica run --format json` child process per turn
 * and streams NDJSON events to the renderer. Session history is read directly
 * from ~/.mica/sessions so the chat view can restore past conversations.
 *
 * Turn lifecycle notifications reuse the local notify server (same HTTP
 * protocol the mica plugin uses), so sidebar dots and unread badges work
 * exactly like PTY-hosted mica sessions.
 */

const NOTIFY_TIMEOUT_MS = 1500
const ABORT_FORCE_KILL_MS = 5000
const MAX_STDERR_CHARS = 32 * 1024
const MAX_COMPLETED_RUNS = 40

const runs = new Map() // nodeId -> { child, buffer, sessionId }
const completedRuns = new Map() // nodeId -> recently finished replay state
let notifyServer = null

export function setChatNotifyServer(server) {
  notifyServer = server
}

export function isChatSessionRunning(sessionId) {
  if (!sessionId) return false
  return [...runs.values()].some(
    (run) => !run.finished && (run.sessionId === sessionId || run.requestedSessionId === sessionId)
  )
}

function sessionsDir() {
  const micaHome = process.env.MICA_HOME
  return micaHome ? join(micaHome, 'sessions') : join(homedir(), '.mica', 'sessions')
}

function micaHomeDir() {
  return process.env.MICA_HOME || join(homedir(), '.mica')
}

const DEFAULT_PROTOCOL = 'openai_chat_completions'

function readMicaConfig() {
  try {
    const file = join(micaHomeDir(), 'config.json')
    if (!existsSync(file)) return { providers: [], provider: null }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return {
      providers: Array.isArray(raw?.providers) ? raw.providers : [],
      provider: typeof raw?.provider === 'string' ? raw.provider : null
    }
  } catch {
    return { providers: [], provider: null }
  }
}

function protocolForProviderId(providerId) {
  if (!providerId) return DEFAULT_PROTOCOL
  const { providers } = readMicaConfig()
  const provider = providers.find((item) => item?.id === providerId)
  return provider?.protocol || DEFAULT_PROTOCOL
}

function protocolForModelId(modelId) {
  if (!modelId) return DEFAULT_PROTOCOL
  const { providers } = readMicaConfig()
  const matched = [...providers]
    .sort((a, b) => (b?.id?.length || 0) - (a?.id?.length || 0))
    .find((provider) => modelId.startsWith(`${provider?.id}/`))
  return matched?.protocol || DEFAULT_PROTOCOL
}

function sessionFile(sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null
  return join(sessionsDir(), `${sessionId}.json`)
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block?.type === 'text') return block.text
        if (block?.type === 'image') return '[图片]'
        return ''
      })
      .join('')
  }
  return ''
}

/** 读取会话文件里的 UI 层对话消息，转成 renderer 友好的轻量结构 */
function readHistory(sessionId) {
  const file = sessionFile(sessionId)
  if (!file || !existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const messages = raw?.snapshot?.conversationMessages
    if (!Array.isArray(messages)) return []
    return messages.map((message) => ({
      role: message.role,
      text: messageText(message.displayContent ?? message.content),
      usage: message.usage ?? null,
      stop_reason: message.stop_reason ?? null
    }))
  } catch {
    return []
  }
}

function readSessionMeta(sessionId) {
  const file = sessionFile(sessionId)
  if (!file || !existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const snapshot = raw?.snapshot
    if (!snapshot || typeof snapshot !== 'object') return null
    const usageHistory = Array.isArray(snapshot.usageHistory) ? snapshot.usageHistory : []
    const inputTokens = usageHistory.reduce(
      (sum, usage) => sum + Math.max(0, Number(usage?.inputTokens) || 0),
      0
    )
    const cachedInputTokens = usageHistory.reduce(
      (sum, usage) => sum + Math.max(0, Number(usage?.cachedInputTokens) || 0),
      0
    )
    return {
      providerId: snapshot.providerId || null,
      model: snapshot.model || null,
      effort: snapshot.effort || null,
      role: snapshot.role || 'default',
      protocol: protocolForProviderId(snapshot.providerId),
      contextWindowSize: Number(snapshot.contextWindowSize) || null,
      lastUsage: snapshot.lastUsage || null,
      cachedRate: inputTokens > 0 ? cachedInputTokens / inputTokens : 0,
      turnState: raw.turnState || 'completed',
      updatedAt: raw.updatedAt || null
    }
  } catch {
    return null
  }
}

function postNotify(terminalId, type, extra = {}) {
  if (!notifyServer) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS)
  void fetch(`${notifyServer.baseUrl}/v1/terminals/${encodeURIComponent(terminalId)}/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${notifyServer.token}`
    },
    body: JSON.stringify({ v: 1, type, terminalId, ts: Date.now(), ...extra }),
    signal: controller.signal
  })
    .catch(() => {
      // Fire-and-forget; chat keeps working even if the notify side is busy.
    })
    .finally(() => clearTimeout(timer))
}

function startRun(sender, id, payload) {
  const existing = runs.get(id)
  if (existing) return { ok: false, busy: true }
  completedRuns.delete(id)

  const prompt = String(payload.prompt || '').trim()
  if (!prompt) return { ok: false, error: '消息内容为空' }

  const mica = resolveMicaExecutable()
  if (!mica) return { ok: false, error: '未找到 mica CLI，请先安装并确保 ~/.local/bin/mica 可用' }

  const sessionId =
    typeof payload.sessionId === 'string' && payload.sessionId.trim()
      ? payload.sessionId.trim()
      : ''
  const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : ''
  const model =
    typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : ''
  const variant =
    typeof payload.variant === 'string' && payload.variant.trim() ? payload.variant.trim() : ''
  const role = typeof payload.role === 'string' && payload.role.trim() ? payload.role.trim() : ''

  const args = buildChatArgs({
    prompt,
    sessionId,
    cwd,
    maxTurns: payload.maxTurns,
    model,
    variant,
    role
  })

  let child
  try {
    child = spawn(mica, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const run = {
    child,
    buffer: '',
    stderr: '',
    sessionId: null,
    requestedSessionId: sessionId || null,
    events: [],
    prompt,
    startedAt: Date.now(),
    finished: false,
    aborting: false,
    exitSent: false,
    sequence: 0
  }
  const eventPacer = createChatEventPacer(({ sequence, event }) => {
    if (!sender.isDestroyed()) {
      sender.send('chat:event', { id, sequence, event })
    }
  })
  runs.set(id, run)

  child.stderr.on('data', (chunk) => {
    run.stderr = `${run.stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS)
  })

  child.stdout.on('data', (chunk) => {
    run.buffer += chunk.toString()
    let newline
    while ((newline = run.buffer.indexOf('\n')) >= 0) {
      const line = run.buffer.slice(0, newline).trim()
      run.buffer = run.buffer.slice(newline + 1)
      if (!line) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      const sequence = ++run.sequence
      const record = { sequence, event }
      appendBufferedEvent(run.events, record)
      // 新会话由 mica 生成 sessionId；补发一次 notify 让侧栏自动绑定节点
      if (event.type === 'step_start' && event.sessionID) {
        if (!run.sessionId && !sessionId) {
          postNotify(`${id}:mica`, 'turn.started', { sessionId: event.sessionID })
        }
        run.sessionId = event.sessionID
      } else if (event.type === 'step_finish') {
        run.finished = true
        const reason = event.part?.reason
        const currentSessionId = run.sessionId || sessionId
        const extra = currentSessionId ? { sessionId: currentSessionId } : {}
        if (reason === 'completed') {
          postNotify(`${id}:mica`, 'turn.completed', extra)
        } else if (reason === 'aborted') {
          postNotify(`${id}:mica`, 'turn.aborted', extra)
        } else if (reason === 'error') {
          const message = event.part?.error?.message || ''
          postNotify(`${id}:mica`, 'turn.error', {
            ...(message ? { summary: message.slice(0, 200) } : {}),
            ...extra
          })
        }
      }
      eventPacer.push(record)
    }
  })

  const sendExit = (payload) => {
    if (run.exitSent) return
    eventPacer.flush()
    run.exitSent = true
    runs.delete(id)
    completedRuns.delete(id)
    completedRuns.set(id, {
      sessionId: run.sessionId || sessionId || null,
      events: run.events.slice(),
      prompt: run.prompt,
      startedAt: run.startedAt,
      exit: { ...payload, aborted: run.aborting }
    })
    while (completedRuns.size > MAX_COMPLETED_RUNS) {
      completedRuns.delete(completedRuns.keys().next().value)
    }
    if (!sender.isDestroyed()) {
      sender.send('chat:exit', {
        id,
        sessionId: run.sessionId || sessionId,
        ...payload,
        aborted: run.aborting
      })
    }
  }

  child.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (!run.finished) {
      postNotify(`${id}:mica`, 'turn.error', {
        ...(run.sessionId || sessionId ? { sessionId: run.sessionId || sessionId } : {}),
        summary: message.slice(0, 200)
      })
    }
    sendExit({ exitCode: null, signal: null, error: message })
  })

  child.on('close', (exitCode, signal) => {
    if (!run.finished) {
      const currentSessionId = run.sessionId || sessionId
      const extra = currentSessionId ? { sessionId: currentSessionId } : {}
      if (run.aborting || signal === 'SIGTERM' || signal === 'SIGINT') {
        postNotify(`${id}:mica`, 'turn.aborted', extra)
      } else if (exitCode === 0) {
        postNotify(`${id}:mica`, 'turn.completed', extra)
      } else {
        postNotify(`${id}:mica`, 'turn.error', {
          ...extra,
          ...(run.stderr.trim() ? { summary: run.stderr.trim().slice(0, 200) } : {})
        })
      }
    }
    sendExit({
      exitCode,
      signal,
      ...(exitCode && run.stderr.trim() ? { error: run.stderr.trim() } : {})
    })
  })

  postNotify(`${id}:mica`, 'turn.started', sessionId ? { sessionId } : {})
  return { ok: true }
}

function abortRun(id) {
  const run = runs.get(id)
  if (!run) return false
  run.aborting = true
  try {
    run.child.kill('SIGTERM')
  } catch {
    // ignore
  }
  const timer = setTimeout(() => {
    try {
      run.child.kill('SIGKILL')
    } catch {
      // ignore
    }
  }, ABORT_FORCE_KILL_MS)
  timer.unref?.()
  return true
}

function listModels() {
  const mica = resolveMicaExecutable()
  if (!mica) return { ok: false, error: '未找到 mica CLI，请先安装并确保 ~/.local/bin/mica 可用' }
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(mica, ['models'], {
        env: { ...process.env },
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
      const ids = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
      const { provider } = readMicaConfig()
      resolvePromise({
        ok: true,
        models: ids.map((id) => ({ id, protocol: protocolForModelId(id) })),
        currentProtocol: protocolForProviderId(provider)
      })
    })
  })
}

function listRoles() {
  const directory = join(micaHomeDir(), 'role')
  try {
    const roles = readdirSync(directory)
      .filter((name) => name.endsWith('.md'))
      .map((name) => basename(name, '.md'))
      .filter(Boolean)
      .sort()
    return { ok: true, roles }
  } catch {
    return { ok: true, roles: [] }
  }
}

function runCompactSession(sessionId) {
  const mica = resolveMicaExecutable()
  if (!mica) {
    return Promise.resolve({
      ok: false,
      error: '未找到 mica CLI，请先安装并确保 ~/.local/bin/mica 可用'
    })
  }
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(mica, ['compact', '--session', sessionId], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      })
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
            mode: result.mode,
            strategy: result.strategy,
            beforeCount: result.beforeCount,
            afterCount: result.afterCount,
            beforeTokenEstimate: result.beforeTokenEstimate,
            afterTokenEstimate: result.afterTokenEstimate,
            savedRatio: result.savedRatio
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

export function registerChatIpc() {
  ipcMain.handle('chat:start', (event, payload = {}) => {
    const id = payload.id
    if (!id) throw new Error('chat id is required')
    return startRun(event.sender, id, payload)
  })

  ipcMain.handle('chat:abort', (_event, { id } = {}) => {
    if (!id) return false
    return abortRun(id)
  })

  ipcMain.handle('chat:history', (_event, { sessionId } = {}) => {
    if (!sessionId) return []
    return readHistory(sessionId)
  })

  ipcMain.handle('chat:meta', (_event, { sessionId } = {}) => {
    if (!sessionId) return null
    return readSessionMeta(sessionId)
  })

  ipcMain.handle('chat:dispose', (_event, { id } = {}) => {
    if (!id) return false
    abortRun(id)
    completedRuns.delete(id)
    return true
  })

  ipcMain.handle('chat:is-running', (_event, { id } = {}) => {
    const run = runs.get(id)
    if (!run) {
      const completed = completedRuns.get(id)
      return completed
        ? { running: false, finished: true, ...completed }
        : { running: false, sessionId: null, events: [] }
    }
    if (run.finished) {
      return {
        running: false,
        finished: true,
        sessionId: run.sessionId,
        events: run.events.slice(),
        prompt: run.prompt,
        startedAt: run.startedAt
      }
    }
    return {
      running: true,
      sessionId: run.sessionId,
      events: run.events.slice(),
      prompt: run.prompt,
      startedAt: run.startedAt
    }
  })

  ipcMain.handle('chat:models', () => listModels())

  ipcMain.handle('chat:roles', () => listRoles())

  ipcMain.handle('chat:compact', (_event, { sessionId } = {}) => {
    if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: 'sessionId 缺失' }
    return runCompactSession(sessionId)
  })

  ipcMain.handle('chat:save-pasted-image', () => savePastedImage(clipboard))
}

export function disposeAllChatRuns() {
  for (const id of [...runs.keys()]) {
    abortRun(id)
  }
  runs.clear()
  completedRuns.clear()
}
