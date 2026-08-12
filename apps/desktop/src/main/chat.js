import { clipboard, ipcMain } from 'electron'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { resolveMicaExecutable } from './mica-cli'
import { isDirectory, resolveUsableCwd } from './cwd-utils'
import {
  appendBufferedEvent,
  buildAppServerArgs,
  CHAT_MCP_INIT_TIMEOUT_MS,
  codexNotificationToEvent,
  createChatEventPacer,
  tokensFromCodexUsage
} from './chat-events'
import { savePastedImage } from './chat-images'
import { resolveDefaultChatMeta } from './chat-meta'
import { resolveModelProtocol, resolveProviderProtocol } from './chat-protocol'
import { forkSessionSnapshot } from './chat-session-actions'
import { createChatQueue, resolveBusyDispatch } from './chat-queue'
import { getShellEnvSnapshot } from './shell-env'
import { appendInputHistory, readInputHistory } from './input-history'

/**
 * Mica chat service: one resident `mica app-server` process per chat node
 * streams NDJSON run-JSON events to the renderer across many turns, so
 * repeated messages skip process startup, session reload and MCP re-init, and
 * queued inputs get real after_iteration injection (Shift+Tab in the app).
 * The host owns the queue; chat:start forwards requests over its stdin and the
 * host acknowledges queue state via `queued`/`queue_state` events.
 *
 * Session history is read directly from ~/.mica/sessions so the chat view can
 * restore past conversations. Turn lifecycle notifications reuse the local
 * notify server (same HTTP protocol the mica plugin uses), so sidebar dots and
 * unread badges work exactly like PTY-hosted mica sessions.
 */

const NOTIFY_TIMEOUT_MS = 1500
const ABORT_FORCE_KILL_MS = 5000
const MAX_STDERR_CHARS = 32 * 1024
const MAX_COMPLETED_RUNS = 40
const MAX_QUEUED_RUNS = 50

// Merge the login-shell environment captured at startup (e.g. exports from
// ~/.zshrc) into a spawned mica process. Falls back to the inherited env
// while the capture is still pending or unavailable.
function mergeShellEnv(env) {
  const shellEnv = getShellEnvSnapshot()
  return shellEnv ? { ...env, ...shellEnv } : { ...env }
}

function buildSpawnEnv(env = process.env) {
  return {
    ...mergeShellEnv(env),
    MICA_MCP_INIT_TIMEOUT_MS: String(CHAT_MCP_INIT_TIMEOUT_MS)
  }
}

const runs = new Map() // nodeId -> resident chat host: { child, buffer, running, sessionId }
const commitRuns = new Map() // commitId -> { child, buffer, stderr }
// after_turn inputs (plain Tab while busy) are queued here and replayed as
// turn/start once the current turn completes. Shift+Tab (after_iteration) is
// forwarded to the host as turn/steer instead.
const queuedRuns = createChatQueue(MAX_QUEUED_RUNS)
const completedRuns = new Map() // nodeId -> recently finished replay state
let notifyServer = null

function queuedItems(id) {
  return queuedRuns.values(id).map((item, index) => ({
    id: item.payload?.clientMessageId || `queued:${id}:${index}`,
    text: item.payload?.prompt || '',
    position: index + 1,
    queueMode: 'after_turn'
  }))
}

// Merge the local after_turn queue with the host-side after_iteration queue.
// The single-slot rule means at most one of the two is ever non-empty.
function allQueuedItems(id, run) {
  const host = (run?.hostPending || []).map((item, index) => ({
    id: item.id || `host:${id}:${index}`,
    text: item.text || '',
    position: index + 1,
    queueMode: item.queueMode || 'after_iteration',
    pending: true
  }))
  return [...host, ...queuedItems(id)]
}

function pushQueueState(id, run) {
  if (run?.sender && !run.sender.isDestroyed()) {
    const items = allQueuedItems(id, run)
    run.sender.send('chat:queue-state', {
      id,
      queuedCount: items.length,
      queuedItems: items
    })
  }
}

function recallQueuedRun(sender, id, clientMessageId) {
  if (!clientMessageId || typeof clientMessageId !== 'string') {
    return { ok: false, error: '排队消息 id 缺失', queuedItems: queuedItems(id) }
  }
  const run = runs.get(id)
  if (run?.child) run.sender = sender
  const removed = queuedRuns.remove(
    id,
    (item) => item.sender === sender && item.payload?.clientMessageId === clientMessageId
  )
  const items = queuedItems(id)
  if (!removed) {
    return {
      ok: false,
      error: '该消息已开始发送或已不在队列中',
      queuedCount: items.length,
      queuedItems: items
    }
  }
  return {
    ok: true,
    id: clientMessageId,
    text: removed.payload?.prompt || '',
    queuedCount: items.length,
    queuedItems: items
  }
}

export function setChatNotifyServer(server) {
  notifyServer = server
}

export function isChatSessionRunning(sessionId) {
  if (!sessionId) return false
  return [...runs.values()].some(
    (run) => run.running && (run.sessionId === sessionId || run.requestedSessionId === sessionId)
  )
}

function sessionsDir() {
  const micaHome = process.env.MICA_HOME
  return micaHome ? join(micaHome, 'sessions') : join(homedir(), '.mica', 'sessions')
}

function micaHomeDir() {
  return process.env.MICA_HOME || join(homedir(), '.mica')
}

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

function readMicaStorage() {
  try {
    const file = join(micaHomeDir(), 'storage.json')
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readDefaultMeta(cwd) {
  return resolveDefaultChatMeta(readMicaConfig(), readMicaStorage(), cwd)
}

function protocolForProviderId(providerId) {
  const { providers } = readMicaConfig()
  return resolveProviderProtocol(providers, providerId)
}

function protocolForModelId(modelId) {
  const { providers } = readMicaConfig()
  return resolveModelProtocol(providers, modelId)
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
      variant: message.variant ?? null,
      command: message.command ?? null,
      status: message.status ?? null,
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
    const lastUsage = snapshot.lastUsage || usageHistory.at(-1) || null
    return {
      providerId: snapshot.providerId || null,
      model: snapshot.model || null,
      effort: snapshot.effort || null,
      role: snapshot.role || 'default',
      cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
      protocol: protocolForProviderId(snapshot.providerId),
      contextWindowSize: Number(snapshot.contextWindowSize) || null,
      lastUsage,
      cachedRate: inputTokens > 0 ? cachedInputTokens / inputTokens : 0,
      turnState: raw.turnState || 'completed',
      updatedAt: raw.updatedAt || null
    }
  } catch {
    return null
  }
}

function forkSession(sessionId) {
  if (isChatSessionRunning(sessionId))
    throw new Error('Cannot fork a session while its turn is running')
  const sourceFile = sessionFile(sessionId)
  if (!sourceFile) throw new Error('Invalid session id')
  let source
  try {
    source = JSON.parse(readFileSync(sourceFile, 'utf8'))
  } catch {
    throw new Error('Session not found')
  }
  if (source?.id !== sessionId) throw new Error('Invalid session')

  const id = randomUUID()
  const fork = forkSessionSnapshot(source, id)
  const directory = sessionsDir()
  const file = join(directory, `${id}.json`)
  const temporary = `${file}.${process.pid}.tmp`
  mkdirSync(directory, { recursive: true })
  writeFileSync(temporary, `${JSON.stringify(fork, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return { id: fork.id, title: fork.title, cwd: fork.cwd }
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

function startCommitRun(sender, commitId, payload) {
  const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : ''
  if (!cwd) return { ok: false, error: '缺少工作目录' }
  if (commitRuns.has(commitId)) return { ok: false, error: 'commit 任务已存在' }

  const mica = resolveMicaExecutable()
  if (!mica) return { ok: false, error: '未找到 mica CLI，请先安装并确保 ~/.local/bin/mica 可用' }

  let child
  try {
    child = spawn(
      mica,
      // One-shot commit: mica collects the git changes, asks the model exactly
      // once for the message, then runs add/commit/push. No multi-turn loop.
      ['commit', '--format', 'json', '--dir', cwd],
      {
        cwd,
        env: buildSpawnEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const run = { child, buffer: '', stderr: '' }
  commitRuns.set(commitId, run)
  const send = (channel, extra) => {
    if (!sender.isDestroyed()) sender.send(channel, { commitId, ...extra })
  }

  child.stderr.on('data', (chunk) => {
    run.stderr = `${run.stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS)
  })

  child.stdout.on('data', (chunk) => {
    run.buffer += chunk.toString()
    run.buffer = run.buffer.slice(-MAX_STDERR_CHARS)
  })

  const finish = (exitCode, signal, error) => {
    if (!commitRuns.has(commitId)) return
    commitRuns.delete(commitId)
    const result = parseCommitResult(run.buffer)
    if (result?.ok) {
      const summary = [
        result.pushed
          ? `已提交并推送 \`${result.commitHash}\`  ${result.subject || ''}`
          : `已提交 \`${result.commitHash}\`，未找到远程分支  ${result.subject || ''}`
      ]
      if (result.commitMessage && result.commitMessage.split('\n').length > 1) {
        summary.push(result.commitMessage.split('\n').slice(1).join('\n').trim())
      }
      send('chat:commit-exit', {
        exitCode,
        signal,
        summary: summary.filter(Boolean).join('\n'),
        result
      })
      return
    }
    send('chat:commit-exit', {
      exitCode,
      signal,
      ...(error
        ? { error: String(error).slice(0, 1000) }
        : result?.error || (exitCode && run.stderr.trim())
          ? { error: String(result?.error || run.stderr.trim()).slice(0, 1000) }
          : exitCode
            ? { error: `commit 未成功完成（code ${exitCode}）` }
            : { error: 'commit 输出格式异常，请更新 mica CLI' })
    })
  }

  child.on('error', (error) =>
    finish(null, null, error instanceof Error ? error.message : String(error))
  )
  child.on('close', (exitCode, signal) => finish(exitCode, signal))
  return { ok: true }
}

function parseCommitResult(buffer) {
  const line = buffer
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1)
  if (!line) return null
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object' && 'ok' in parsed ? parsed : null
  } catch {
    return null
  }
}

function startRun(sender, id, payload) {
  const prompt = String(payload.prompt || '').trim()
  if (!prompt) return { ok: false, error: '消息内容为空' }

  const existing = runs.get(id)
  if (existing?.child) {
    // Resident host already running. Refresh the sender (a renderer reload
    // creates a new webContents whose listeners must receive streamed events)
    // and dispatch by bus state:
    //   idle               -> turn/start (fresh turn)
    //   busy + Shift+Tab   -> turn/steer (after_iteration injection into the
    //                         active turn; host-side single-slot queue)
    //   busy + plain Tab   -> queue locally; replayed as turn/start when the
    //                         current turn completes (after_turn)
    existing.sender = sender
    if (existing.running) {
      // 单槽排队（对齐 CLI）：已有任意排队（本地 after_turn 或 host
      // after_iteration）时，Enter/Tab/Shift+Tab 都拒绝新的排队输入。
      const dispatch = resolveBusyDispatch({
        running: true,
        queueMode: payload.queueMode,
        queuedCount: queuedRuns.size(id)
      })
      if (dispatch.action === 'reject') {
        return {
          ok: false,
          error: dispatch.message,
          queuedCount: queuedRuns.size(id),
          queuedItems: queuedItems(id)
        }
      }
      if (dispatch.action === 'steer') {
        if (!sendSteer(existing, payload)) {
          disposeHost(id)
          return { ok: false, error: 'chat host 不可用，请重试' }
        }
        return { ok: true }
      }
      const enqueued = queuedRuns.enqueue(id, { sender, payload: { ...payload, prompt } })
      if (!enqueued.ok) {
        return {
          ok: false,
          error: '排队消息已达上限，请先发送或取消排队',
          queuedCount: queuedRuns.size(id),
          queuedItems: queuedItems(id)
        }
      }
      if (existing.sender && !existing.sender.isDestroyed()) {
        existing.sender.send('chat:queue-state', {
          id,
          queuedCount: queuedRuns.size(id),
          queuedItems: queuedItems(id)
        })
      }
      return { ok: true, queued: true, position: enqueued.position, queuedItems: queuedItems(id) }
    }
    const accepted = sendTurnStart(existing, payload)
    if (!accepted) {
      disposeHost(id)
      return { ok: false, error: 'chat host 不可用，请重试' }
    }
    return { ok: true }
  }

  const spawned = spawnChatHost(id, sender, payload)
  if (!spawned.ok) return spawned
  const run = runs.get(id)
  run.prompt = prompt
  // Optimistically mark the host busy so a rapid second message queues instead
  // of racing ahead of turn/started; the turn/completed event clears it.
  run.running = true
  const accepted = sendTurnStart(run, payload)
  if (!accepted) {
    disposeHost(id)
    return { ok: false, error: 'chat host 启动后写入失败，请重试' }
  }
  return { ok: true }
}

function writeHostRequest(run, request) {
  if (!run?.child?.stdin?.writable) return false
  run.child.stdin.write(`${JSON.stringify(request)}\n`)
  return true
}

function sendCodexRequest(run, method, params) {
  if (!run?.child?.stdin?.writable) return false
  run.requestSeq = (run.requestSeq || 0) + 1
  const id = run.requestSeq
  run.pendingRequests = run.pendingRequests || new Map()
  run.pendingRequests.set(id, { method, params })
  run.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  return true
}

function sendTurnStart(run, payload) {
  const params = { threadId: run.sessionId || run.requestedSessionId || '' }
  params.input = [{ type: 'text', text: String(payload.prompt || '') }]
  if (payload.cwd) params.cwd = payload.cwd
  if (payload.model) params.model = payload.model
  if (payload.variant) params.effort = payload.variant
  return sendCodexRequest(run, 'turn/start', params)
}

function sendSteer(run, payload) {
  return sendCodexRequest(run, 'turn/steer', {
    threadId: run.sessionId || run.requestedSessionId || '',
    expectedTurnId: run.currentTurnId || '',
    input: [{ type: 'text', text: String(payload.prompt || '') }],
    // Mica extension: correlate queue events with the optimistic message id.
    clientMessageId: payload.clientMessageId || undefined
  })
}

function sendInterrupt(run) {
  return sendCodexRequest(run, 'turn/interrupt', {
    threadId: run.sessionId || run.requestedSessionId || '',
    turnId: run.currentTurnId || ''
  })
}

function spawnChatHost(id, sender, payload) {
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

  const args = buildAppServerArgs({
    sessionId,
    cwd,
    model,
    variant,
    role,
    maxTurns: payload.maxTurns
  })

  let child
  try {
    child = spawn(mica, args, {
      cwd: cwd || process.cwd(),
      env: buildSpawnEnv(process.env),
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const run = {
    child,
    sender: null,
    buffer: '',
    stderr: '',
    sessionId: null,
    requestedSessionId: sessionId || null,
    events: [],
    prompt: '',
    startedAt: Date.now(),
    running: false,
    aborting: false,
    exitSent: false,
    sequence: 0,
    currentTurnId: null,
    requestSeq: 0,
    pendingRequests: new Map(),
    toolOutputs: new Map(),
    lastTokenUsage: null,
    // Host-side after_iteration queue (single slot, mirror of the local one):
    // driven by `mica/queue/*` extension notifications from app-server.
    hostPending: []
  }
  run.sender = sender
  run.eventPacer = createChatEventPacer(({ sequence, event }) => {
    if (runs.get(id) === run && run.sender && !run.sender.isDestroyed()) {
      run.sender.send('chat:event', { id, sequence, event })
    }
  })
  runs.set(id, run)

  child.stderr.on('data', (chunk) => {
    run.stderr = `${run.stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS)
  })

  child.stdout.on('data', (chunk) => handleHostOutput(id, run, chunk))

  child.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (!run.exitSent) {
      postNotify(`${id}:mica`, 'turn.error', {
        ...(run.sessionId || run.requestedSessionId
          ? { sessionId: run.sessionId || run.requestedSessionId }
          : {}),
        summary: message.slice(0, 200)
      })
      sendChatExit(id, run, { exitCode: null, signal: null, error: message })
    }
  })

  child.on('close', (exitCode, signal) => {
    if (runs.get(id) !== run) return
    runs.delete(id)
    queuedRuns.clear(id)
    if (!run.exitSent) {
      const extra =
        run.sessionId || run.requestedSessionId
          ? { sessionId: run.sessionId || run.requestedSessionId }
          : {}
      if (run.aborting || signal === 'SIGTERM' || signal === 'SIGINT') {
        postNotify(`${id}:mica`, 'turn.aborted', extra)
      } else {
        postNotify(`${id}:mica`, 'turn.error', {
          ...extra,
          ...(run.stderr.trim() ? { summary: run.stderr.trim().slice(0, 200) } : {})
        })
      }
      sendChatExit(id, run, {
        exitCode,
        signal,
        ...(exitCode && run.stderr.trim() ? { error: run.stderr.trim() } : {})
      })
    }
  })

  return { ok: true }
}

function handleHostOutput(id, run, chunk) {
  run.buffer += chunk.toString()
  let newline
  while ((newline = run.buffer.indexOf('\n')) >= 0) {
    const line = run.buffer.slice(0, newline).trim()
    run.buffer = run.buffer.slice(newline + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if ('method' in message) {
      handleHostNotification(id, run, message)
      continue
    }
    if ('id' in message) {
      handleHostResponse(id, run, message)
      continue
    }
  }
}

function handleHostResponse(id, run, message) {
  const pending = run.pendingRequests?.get(message.id)
  run.pendingRequests?.delete(message.id)
  if (!pending) return
  if (message.error) {
    // Request-level errors (busy turn/start, steer mismatch, ...). Surface as
    // an error event so the renderer sees why a message did not start.
    const errorMessage = message.error.message || 'chat host 请求失败'
    const record = {
      sequence: ++run.sequence,
      event: {
        type: 'error',
        timestamp: Date.now(),
        sessionID: run.sessionId,
        error: { name: 'MicaRuntimeError', data: { message: errorMessage } }
      }
    }
    appendBufferedEvent(run.events, record)
    run.eventPacer.push(record)
  }
}

function handleHostNotification(id, run, notification) {
  const method = notification.method
  const params = notification.params || {}
  const event = codexNotificationToEvent(notification)

  if (method === 'turn/started') {
    // 常驻 host 跨 turn 复用同一 run，恢复会话也带 requestedSessionId：
    // 必须每轮都发 turn.started，notifyServer 据此点亮侧栏运行灯
    // （agentRunning=true）；节点绑定幂等，重复发送无害。
    const sessionID = params.threadId
    if (sessionID) postNotify(`${id}:mica`, 'turn.started', { sessionId: sessionID })
    if (sessionID) run.sessionId = sessionID
    run.currentTurnId = params.turn?.id || null
    run.running = true
    run.aborting = false
    run.startedAt = notification.emittedAtMs || Date.now()
    run.exitSent = false
    run.toolOutputs.clear()
  } else if (method === 'turn/completed') {
    run.running = false
    run.currentTurnId = null
    run.hostPending = []
    const reason = event?.part?.reason || 'completed'
    const currentSessionId = run.sessionId || run.requestedSessionId
    const extra = currentSessionId ? { sessionId: currentSessionId } : {}
    if (reason === 'completed') {
      postNotify(`${id}:mica`, 'turn.completed', extra)
    } else if (reason === 'aborted') {
      postNotify(`${id}:mica`, 'turn.aborted', extra)
    } else {
      postNotify(`${id}:mica`, 'turn.error', extra)
    }
    if (event && run.lastTokenUsage) {
      event.part.tokens = tokensFromCodexUsage(run.lastTokenUsage)
    }
    // step_finish 必须在事件流里送达渲染层：reason/usage 驱动 turn log 收尾、
    // assistant 消息 usage 行与状态栏刷新。丢失会导致 phase 被 processExit 覆盖成 idle，
    // error/aborted 的日志被隐藏，并误报 "mica 进程已退出（code 1）"。
    if (event) pushChatEvent(run, event)
    sendChatExit(id, run, { exitCode: reason === 'error' ? 1 : 0 })
    replayQueuedTurn(id, run)
    return
  } else if (method === 'item/commandExecution/outputDelta') {
    const itemId = params.itemId
    if (itemId) {
      const previous = run.toolOutputs.get(itemId) || ''
      run.toolOutputs.set(itemId, `${previous}${params.delta || ''}`)
    }
    return
  } else if (method === 'item/completed') {
    if (params.item?.type === 'commandExecution' && event) {
      const itemId = params.item.id
      const buffered = run.toolOutputs.get(itemId)
      if (buffered) {
        event.part.state.output = buffered
        run.toolOutputs.delete(itemId)
      }
    }
  } else if (method === 'thread/tokenUsage/updated') {
    if (params.tokenUsage) run.lastTokenUsage = params.tokenUsage
    return
  } else if (method === 'mica/queue/queued') {
    // Host accepted an after_iteration steer input; show it as a waiting
    // queue row until the iteration boundary fires (mica/queue/dequeue).
    run.hostPending = Array.isArray(params.pending)
      ? params.pending
      : params.input
        ? [params.input]
        : []
    pushQueueState(id, run)
    return
  } else if (method === 'mica/queue/dequeue') {
    run.hostPending = []
    pushQueueState(id, run)
    return
  } else if (method === 'mica/queue/changed') {
    run.hostPending = Array.isArray(params.pending) ? params.pending : []
    pushQueueState(id, run)
    return
  } else if (method === 'mica/backgroundTasks/updated' || method === 'mica/subagentTasks/updated') {
    // Long-lived host state snapshots: background shell tasks / running
    // subagents survive the parent turn and arrive on their own cadence, so
    // they must NOT go through the turn event buffer (appendBufferedEvent would
    // let frequent snapshots evict text/step_finish events and replay stale
    // lists on restore). Deliver directly; the renderer replaces the whole
    // list each time, so the latest snapshot always wins.
    const snapshotEvent = codexNotificationToEvent(notification)
    if (snapshotEvent && run.sender && !run.sender.isDestroyed()) {
      run.sender.send('chat:event', { id, sequence: ++run.sequence, event: snapshotEvent })
    }
    return
  } else if (method === 'error') {
    run.running = false
    run.hostPending = []
    const errorMessage = params.error?.message || 'chat host 出错'
    postNotify(`${id}:mica`, 'turn.error', {
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(errorMessage ? { summary: errorMessage.slice(0, 200) } : {})
    })
    if (event) pushChatEvent(run, event)
    sendChatExit(id, run, { exitCode: 1, error: errorMessage })
    return
  }

  if (!event) return
  pushChatEvent(run, event)
}

function pushChatEvent(run, event) {
  const sequence = ++run.sequence
  const record = { sequence, event }
  appendBufferedEvent(run.events, record)
  run.eventPacer.push(record)
}

function replayQueuedTurn(id, run) {
  const next = queuedRuns.take(id)
  if (!next) {
    if (run.sender && !run.sender.isDestroyed()) {
      run.sender.send('chat:queue-state', {
        id,
        queuedCount: queuedRuns.size(id),
        queuedItems: queuedItems(id)
      })
    }
    return
  }
  if (run.sender && !run.sender.isDestroyed()) {
    run.sender.send('chat:queue-state', {
      id,
      queuedCount: queuedRuns.size(id),
      queuedItems: queuedItems(id)
    })
  }
  run.running = true
  if (sendTurnStart(run, next.payload)) {
    run.prompt = next.payload.prompt || run.prompt
  } else {
    run.running = false
  }
}

function sendChatExit(id, run, payload) {
  if (run.exitSent) return
  run.eventPacer.flush()
  run.exitSent = true
  completedRuns.delete(id)
  completedRuns.set(id, {
    sessionId: run.sessionId || run.requestedSessionId || null,
    events: run.events.slice(),
    prompt: run.prompt,
    startedAt: run.startedAt,
    exit: { ...payload, aborted: run.aborting }
  })
  while (completedRuns.size > MAX_COMPLETED_RUNS) {
    completedRuns.delete(completedRuns.keys().next().value)
  }
  if (run.sender && !run.sender.isDestroyed()) {
    run.sender.send('chat:exit', {
      id,
      sessionId: run.sessionId || run.requestedSessionId,
      ...payload,
      aborted: run.aborting,
      queuedCount: queuedRuns.size(id),
      queuedItems: queuedItems(id)
    })
  }
}

function disposeHost(id) {
  const run = runs.get(id)
  if (!run) return
  runs.delete(id)
  queuedRuns.clear(id)
  try {
    writeHostRequest(run, { method: 'shutdown' })
  } catch {
    // ignore
  }
  const timer = setTimeout(() => {
    if (run.child) {
      try {
        run.child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
  }, 500)
  timer.unref?.()
}

function abortRun(id) {
  const run = runs.get(id)
  if (!run?.child || !run.running) return false
  run.aborting = true
  if (!sendInterrupt(run)) {
    try {
      run.child.kill('SIGTERM')
    } catch {
      // ignore
    }
    return true
  }
  const timer = setTimeout(() => {
    if (runs.get(id) === run && run.running) {
      try {
        run.child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
  }, ABORT_FORCE_KILL_MS)
  timer.unref?.()
  return true
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

async function listModels() {
  const mica = resolveMicaExecutable()
  if (!mica) return { ok: false, error: '未找到 mica CLI，请先安装并确保 ~/.local/bin/mica 可用' }
  const { provider } = readMicaConfig()
  const parsePlain = (stdout) =>
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((id) => ({ id, efforts: [] }))
  const buildResult = (entries) => ({
    ok: true,
    models: entries.map((entry) => ({
      id: entry.id,
      protocol: protocolForModelId(entry.id),
      efforts: Array.isArray(entry.efforts) ? entry.efforts : []
    })),
    currentProtocol: protocolForProviderId(provider)
  })

  // 新版 CLI 支持 --json（附带每个模型的 effort 选项）；旧版回退到纯文本行。
  const jsonResult = await runModelsCommand(mica, ['models', '--json'])
  if (jsonResult.ok) {
    try {
      const parsed = JSON.parse(jsonResult.stdout.trim())
      if (Array.isArray(parsed)) return buildResult(parsed)
    } catch {
      // fall through to plain-text fallback
    }
  }
  const plainResult = await runModelsCommand(mica, ['models'])
  if (!plainResult.ok) {
    return {
      ok: false,
      error: jsonResult.ok ? jsonResult.error : plainResult.error || 'mica models 加载失败'
    }
  }
  return buildResult(parsePlain(plainResult.stdout))
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

function runCompactSession(sessionId, mode = 'model') {
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
  const sessionMeta = readSessionMeta(sessionId)
  // 会话记录的 cwd 可能因目录被移动/删除而失效，此时 spawn 会 ENOENT。
  // 先归一化为可用目录，避免压缩直接失败；回退信息随结果返回供 UI 提示。
  const resolved = resolveUsableCwd(sessionMeta?.cwd || process.cwd())
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
          ...(mode === 'local' ? ['--prune-only'] : [])
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
            contextUsageRatio: result.contextUsageRatio
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

  ipcMain.handle('chat:commit', (event, payload = {}) => {
    const commitId = payload.commitId
    if (!commitId) throw new Error('commit id is required')
    return startCommitRun(event.sender, commitId, payload)
  })

  ipcMain.handle('chat:abort', (_event, { id } = {}) => {
    if (!id) return false
    return abortRun(id)
  })

  ipcMain.handle('chat:recall-queued', (event, { id, clientMessageId } = {}) => {
    if (!id) return { ok: false, error: 'chat id 缺失', queuedCount: 0, queuedItems: [] }
    return recallQueuedRun(event.sender, id, clientMessageId)
  })

  ipcMain.handle('chat:history', (_event, { sessionId } = {}) => {
    if (!sessionId) return []
    return readHistory(sessionId)
  })

  ipcMain.handle('chat:input-history:read', () => readInputHistory())

  ipcMain.handle('chat:input-history:append', (_event, { text } = {}) => appendInputHistory(text))

  ipcMain.handle('chat:meta', (_event, { sessionId, cwd } = {}) => {
    if (!sessionId) return readDefaultMeta(cwd)
    return readSessionMeta(sessionId)
  })

  ipcMain.handle('chat:dispose', (_event, { id } = {}) => {
    if (!id) return false
    disposeHost(id)
    completedRuns.delete(id)
    return true
  })

  ipcMain.handle('chat:is-running', (event, { id } = {}) => {
    const run = runs.get(id)
    if (run?.child) run.sender = event.sender
    if (!run) {
      const completed = completedRuns.get(id)
      return completed
        ? { running: false, finished: true, queuedCount: 0, queuedItems: [], ...completed }
        : {
            running: false,
            sessionId: null,
            events: [],
            queuedCount: queuedRuns.size(id),
            queuedItems: queuedItems(id)
          }
    }
    if (!run.running) {
      return {
        running: false,
        finished: !run.exitSent,
        queuedCount: queuedRuns.size(id),
        queuedItems: queuedItems(id),
        sessionId: run.sessionId,
        events: run.events.slice(),
        prompt: run.prompt,
        startedAt: run.startedAt
      }
    }
    return {
      running: true,
      queuedCount: queuedRuns.size(id),
      queuedItems: queuedItems(id),
      sessionId: run.sessionId,
      events: run.events.slice(),
      prompt: run.prompt,
      startedAt: run.startedAt
    }
  })

  ipcMain.handle('chat:models', () => listModels())

  ipcMain.handle('chat:roles', () => listRoles())

  ipcMain.handle('chat:compact', (_event, { sessionId, mode } = {}) => {
    if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: 'sessionId 缺失' }
    return runCompactSession(sessionId, mode === 'local' ? 'local' : 'model')
  })

  ipcMain.handle('chat:check-cwd', (_event, { cwd } = {}) => {
    return { ok: true, exists: isDirectory(cwd) }
  })

  ipcMain.handle('chat:update-cwd', (_event, { sessionId, cwd } = {}) => {
    const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null
    if (!sessionId || typeof sessionId !== 'string' || !dir) {
      return { ok: false, error: 'sessionId 或 cwd 缺失' }
    }
    if (!isDirectory(dir)) return { ok: false, error: '目录不存在，请选择有效目录' }
    const file = sessionFile(sessionId)
    if (!file || !existsSync(file)) return { ok: false, error: '会话不存在' }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (!raw || typeof raw !== 'object') return { ok: false, error: '会话文件已损坏' }
      if (raw.cwd === dir) return { ok: true, unchanged: true }
      raw.cwd = dir
      raw.updatedAt = new Date().toISOString()
      writeFileSync(file, JSON.stringify(raw, null, 2))
      return { ok: true, unchanged: false }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('chat:fork', (_event, { sessionId } = {}) => {
    if (!sessionId || typeof sessionId !== 'string') throw new Error('session id is required')
    return forkSession(sessionId)
  })

  ipcMain.handle('chat:save-pasted-image', () => savePastedImage(clipboard))
}

export function disposeAllChatRuns() {
  for (const [id, run] of [...runs.entries()]) {
    try {
      writeHostRequest(run, { method: 'shutdown' })
    } catch {
      // ignore
    }
    try {
      run.child?.kill('SIGTERM')
    } catch {
      // ignore
    }
    runs.delete(id)
  }
  for (const [commitId, run] of [...commitRuns.entries()]) {
    try {
      run.child.kill('SIGTERM')
    } catch {
      // ignore
    }
    commitRuns.delete(commitId)
  }
  queuedRuns.clearAll()
  completedRuns.clear()
}
