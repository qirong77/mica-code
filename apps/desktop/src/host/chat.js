import { clipboard, ipcMain } from 'electron'
import { prewarmFileMentions } from '@packages/mica-file-mentions/index.js'
import { readBtwState } from '@packages/mica-common/btwState.js'
import { resolveMicaHome } from '@packages/mica-config/index.js'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { resolveMicaExecutable } from './mica-cli'
import { logger } from './log'
import { readTopLevelCwd } from './session-file-head'
import { isDirectory, resolveUsableCwd } from './cwd-utils'
import {
  appendBufferedEvent,
  buildAppServerArgs,
  buildTurnStartParams,
  CHAT_MCP_INIT_TIMEOUT_MS,
  codexNotificationToEvent,
  createChatEventPacer,
  tokensFromCodexUsage
} from './chat-events'
import { savePastedImage } from './chat-images'
import { stripControlSockets } from './control-env'
import { resolveDefaultChatMeta } from './chat-meta'
import { resolveModelProtocol, resolveProviderProtocol } from './chat-protocol'
import { forkSessionSnapshot } from './chat-session-actions'
import { createChatQueue, mergeQueuedItems, resolveBusyDispatch } from './chat-queue'
import { settlePendingHostRequests } from './chat-host-requests'
import { unwrapHostResult } from './chat-capabilities'
import { getShellEnvSnapshot } from './shell-env'
import { appendInputHistory, readInputHistory } from './input-history'
import { isValidSessionId } from './session-delete'
import { renameSessionFile } from './session-rename'
import { createTurnLeaseProbe } from './session-lease'
import { bindLoopSessionId } from './loops'
import { browserOwnerEnv } from './browser-control'
import { terminalOwnerEnv } from './terminal-control'
import {
  CONTROL_ORIGIN_ENV,
  availableControlKinds,
  writeControlMcpConfig
} from './control-mcp-config'

/**
 * Mica chat service: one resident `mica app-server` process per chat node
 * streams NDJSON run-JSON events to the renderer across many turns, so
 * repeated messages skip process startup, session reload and MCP re-init, and
 * queued inputs get real after_iteration injection (Shift+Tab in the app).
 * The host owns the queue; chat:start forwards requests over its stdin and the
 * host acknowledges queue state via `queued`/`queue_state` events.
 *
 * A run is keyed by the chat node that spawned it. The workspace lives in the host
 * (see ui-state.js), so every page shows the *same* nodes and the same run: a second
 * tab/window is just another view of it, not a separate observer that has to be
 * attached by session. Every client shares one SSE broadcast.
 *
 * Session history is read directly from ~/.mica/sessions so the chat view can
 * restore past conversations. Turn lifecycle notifications reuse the local
 * notify server (same HTTP protocol the mica plugin uses), so sidebar dots and
 * unread badges work exactly like PTY-hosted mica sessions.
 */

const NOTIFY_TIMEOUT_MS = 1500
const ABORT_FORCE_KILL_MS = 5000
/** 停止时取回排队消息的等待上限：这是交互动作，不该为一条可能不存在的队列陪等。 */
const ABORT_RECALL_TIMEOUT_MS = 1500
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

function buildSpawnEnv(env = process.env, owner = null) {
  // socket 只属于运行时自己：留着等于给 agent 一条绕过 Host/Origin 校验的旁路
  const reachable = stripControlSockets(mergeShellEnv(env))
  return {
    ...reachable,
    // 这个进程是桌面端拉起来的 app-server：插件据此提供只有桌面宿主能兑现的能力
    // （运行条件探测、系统设置跳转）。CLI / TUI / exec 不会带这个标记。
    // 注意别用 MICA_DESKTOP_HOST：那是运行时的绑定地址，同名会让两边互相踩。
    MICA_PLUGIN_DESKTOP_HOST: '1',
    MICA_MCP_INIT_TIMEOUT_MS: String(CHAT_MCP_INIT_TIMEOUT_MS),
    // 受控浏览器按 owner 归属：agent 用它开出来的窗口会挂到对应会话的图标上。
    // 地址（MICA_BROWSER_URL）由运行时的环境继承，这里只补「这一轮是谁」。
    ...browserOwnerEnv(owner),
    // 终端控制同理：agent 开的终端挂到这一轮所属的会话上
    ...terminalOwnerEnv(owner)
  }
}

// nodeId -> resident chat host. The key is the chat node that spawned it and never
// changes. The run lives until its page is closed (chat:dispose) or the host exits.
const runs = new Map()
const commitRuns = new Map() // commitId -> { child, buffer, stderr }
// Explicit after_turn inputs are queued here and replayed as turn/start once
// the current turn completes. Every busy Enter/Tab/Shift+Tab from the composer
// now carries after_iteration and is forwarded to the host as turn/steer
// instead (fastest path), so this local queue is no longer the default.
const queuedRuns = createChatQueue(MAX_QUEUED_RUNS)
const completedRuns = new Map() // nodeId -> recently finished replay state
let notifyServer = null

/** 这个 run 属于哪个 session（还没绑定会话时是请求里带的那一个）。 */
function runSessionId(run) {
  return run?.sessionId || run?.requestedSessionId || null
}

/**
 * 已经有页签在服务这条会话时返回它的 chat id：动作要落到同一个 host 上，否则同一个会话
 * 会有两个进程各自持有一份快照（页签那份才是用户正在看的）。进程没起来也没关系——
 * `ensureCapabilityRun` 会在同一个 id 上补起一个。
 */
function liveRunIdForSession(sessionId) {
  if (!sessionId) return ''
  for (const [id, run] of runs) {
    if (runSessionId(run) === sessionId) return id
  }
  return ''
}

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
  return mergeQueuedItems(id, run?.hostPending, queuedItems(id))
}

/**
 * 最近一次的任务快照（后台 shell 任务 / 运行中 subagent）。它们刻意不进事件缓冲
 * （频繁快照会把 text/step_finish 挤掉），但要随 `chat:is-running` 一起回给客户端：
 * 中途附着上来的第二个页签否则会漏掉这一轮里已经推过的那次快照，dock 一直空着。
 */
function runSnapshots(run) {
  return Object.values(run?.lastSnapshots || {})
}

function pushQueueState(id, run) {
  if (run?.sender && !run.sender.isDestroyed()) {
    const items = allQueuedItems(id, run)
    run.sender.send('chat:queue-state', {
      id,
      sessionId: runSessionId(run),
      queuedCount: items.length,
      queuedItems: items
    })
  }
}

const QUEUE_RECALL_FAILED = '该消息已开始发送或已不在队列中'

/**
 * Recall (撤回) a queued message — the CLI's shift + ←. Two slots can hold it:
 * the local after_turn queue (explicit requests only) and the host's
 * after_iteration slot. The host slot lives inside the app-server process, so
 * it can only be emptied through `mica/queue/recall`; both must be recallable,
 * otherwise a busy Enter/Tab would look permanent in the app while the CLI can
 * always take it back.
 */
async function recallQueuedRun(sender, id, clientMessageId) {
  const run = runs.get(id)
  if (run?.child) run.sender = sender
  const fail = (error) => {
    // Same merged view as `chat:queue-state`: a failed recall must report the
    // queue as it currently stands (and never drop the other slot's row).
    const items = allQueuedItems(id, run)
    return { ok: false, error, queuedCount: items.length, queuedItems: items }
  }
  if (!clientMessageId || typeof clientMessageId !== 'string') {
    return fail('排队消息 id 缺失')
  }
  const removed = queuedRuns.remove(
    id,
    (item) => item.sender === sender && item.payload?.clientMessageId === clientMessageId
  )
  let text = removed?.payload?.prompt || ''
  if (!removed) {
    const response = await hostTaskRequest(run, 'mica/queue/recall', { clientMessageId })
    if (!response?.ok) return fail(response?.error || QUEUE_RECALL_FAILED)
    const input = response.result?.input
    if (!input) return fail(response.result?.message || QUEUE_RECALL_FAILED)
    text = input.text || ''
  }
  const items = allQueuedItems(id, run)
  return {
    ok: true,
    id: clientMessageId,
    text,
    queuedCount: items.length,
    queuedItems: items
  }
}

export function setChatNotifyServer(server) {
  notifyServer = server
}

/**
 * 最近一次页面调用的 sender：定时任务是在页面之外触发的，需要一个「往哪里推事件」的
 * 目标。页面还开着时这里就是最近交互的那个窗口（shim 模式下它是广播所有 SSE 客户端的
 * 单例）；一个窗口都没有时退回静默 sender —— turn 照样跑、历史照样落盘，通知也会经
 * notify server 补上，只是没有实时的流式回放。
 */
let lastChatSender = null
const silentSender = { send() {}, isDestroyed: () => false }

function rememberChatSender(event) {
  if (event?.sender) lastChatSender = event.sender
}

function fallbackChatSender() {
  if (lastChatSender && !lastChatSender.isDestroyed?.()) return lastChatSender
  for (const run of runs.values()) {
    if (run.sender && !run.sender.isDestroyed?.()) return run.sender
  }
  return silentSender
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

/**
 * 会话文件是否存在。分享链接的有效性用它判定（链接就是凭据，指向的会话不在就当没这条
 * 链接），所以这里只认「文件名合法 + 文件在」：id 里的 `/`、`..` 一律不成立。
 */
export function sessionExists(sessionId) {
  const id = String(sessionId ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return false
  return existsSync(join(sessionsDir(), `${id}.json`))
}

/**
 * 另一个进程（第二个运行时实例，或终端里的 TUI / `mica exec`）是否正持有该 session 的
 * turn lease。桌面 host 自己从不取 lease——它的 turn 跑在 spawn 出去的 app-server 子进程里，
 * 由那个子进程持锁——所以本进程里跑着的会话由 `isChatSessionRunning` 拦，这里管的是别处。
 */
const hasLiveTurnLease = createTurnLeaseProbe({ lockDir: () => join(sessionsDir(), '.turn-locks') })

/**
 * 会话级的「正在别处运行」判定。工作区在运行时只有一份，所以本进程里同一个会话不会同时挂
 * 在两个节点上（`isChatSessionRunning` 只是防御性的一层）；真正会撞上的是另一个进程持着
 * turn lease。调用点只在本节点空闲、准备发起新 turn 时才问它，因此不与「本节点自己的 run」重叠。
 */
function sessionBusyElsewhere(sessionId) {
  if (!sessionId) return null
  if (isChatSessionRunning(sessionId)) return '该会话正在另一个窗口里运行，请等待完成后再发送'
  if (hasLiveTurnLease(sessionId)) return '该会话正在另一个窗口或终端运行，请等待完成后再发送'
  return null
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
    // compact 之后磁盘上的 lastUsage 仍是压缩前那次真实请求（Stats 对账口径），
    // 上下文徽标要显示压缩后的占用，直到下一次真实请求替换它。
    const displayTokens = Number(snapshot.displayUsage?.totalTokens) || 0
    return {
      providerId: snapshot.providerId || null,
      model: snapshot.model || null,
      effort: snapshot.effort || null,
      role: snapshot.role || 'default',
      cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
      protocol: protocolForProviderId(snapshot.providerId),
      contextWindowSize: Number(snapshot.contextWindowSize) || null,
      lastUsage:
        displayTokens > 0
          ? {
              // 与 ChatView 的 applyCompactMeta 保持同一种形状：只描述上下文占用
              totalTokens: displayTokens,
              inputTokens: displayTokens,
              outputTokens: 0,
              cachedInputTokens: 0
            }
          : lastUsage,
      cachedRate: inputTokens > 0 ? cachedInputTokens / inputTokens : 0,
      turnState: raw.turnState || 'completed',
      updatedAt: raw.updatedAt || null
    }
  } catch {
    return null
  }
}

/** 只取 cwd 时先读文件头，读不到才退回整份解析。 */
function readSessionCwd(sessionId) {
  const file = sessionFile(sessionId)
  if (!file || !existsSync(file)) return null
  return readTopLevelCwd(file) ?? readSessionMeta(sessionId)?.cwd ?? null
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

/**
 * By The Way 线程在回答时点亮侧栏那颗呼吸绿点。
 *
 * btw 是一个隔离子代理，没有 `turn/started` 事件，所以它自己的运行态必须
 * 单独往 notify 里写一份（`setBtwRunning`）；否则抽屉里字在流、侧栏却是静的。
 * 只认最后一条 entry：完成/失败都会把它转成 completed/error，灯随之熄灭。
 */
function applyBtwRunning(nodeId, snapshotEvent) {
  if (!notifyServer || !snapshotEvent) return
  const run = runs.get(nodeId)
  if (!run) return
  const entries = Array.isArray(snapshotEvent.thread?.entries) ? snapshotEvent.thread.entries : []
  const threadKey = snapshotEvent.thread?.id || ''
  // 多个 tab 各自在跑：任一条在回答就点亮。所以按线程 id 记一份，全部熄灭才灭灯
  // （只看「最后一条 entry」，另一个 tab 在跑时一刷新就会把灯关掉）。
  const answered = entries.some((entry) => entry.status === 'running')
  const busy = new Set(run.btwBusyThreads || [])
  if (answered) {
    if (threadKey) busy.add(threadKey)
  } else if (threadKey) {
    busy.delete(threadKey)
  }
  run.btwBusyThreads = busy
  notifyServer.setBtwRunning(`${nodeId}:mica`, busy.size > 0 || (!threadKey && answered))
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
      // One-shot commit: the commit plugin collects the git changes, asks its
      // own configured model once for the message, then runs add/commit/push.
      // No multi-turn loop, no agent.
      ['commit', '--format', 'json', '--dir', cwd],
      {
        cwd,
        env: buildSpawnEnv(
          process.env,
          isValidSessionId(payload.sessionId) ? payload.sessionId : null
        ),
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
    //   idle                       -> turn/start (fresh turn)
    //   busy + queue input         -> turn/steer (after_iteration injection into
    //                                 the active turn; host-side single-slot
    //                                 queue; Enter/Tab/Shift+Tab all land here)
    //   busy + explicit after_turn -> queue locally; replayed as turn/start when
    //                                 the current turn completes
    existing.sender = sender
    if (existing.running) {
      // 单槽排队（对齐 CLI）：已有任意排队（本地 after_turn 或 host
      // after_iteration）时，Enter/Tab/Shift+Tab 都拒绝新的排队输入。
      // host 侧队列必须计入：否则第二次 Enter 会走到 turn/steer，被 host 以
      // 「已有一条排队消息」拒绝，变成一条与消息不对应的错误事件。
      const queuedItemsNow = allQueuedItems(id, existing)
      const queuedCount = queuedItemsNow.length
      const dispatch = resolveBusyDispatch({
        running: true,
        queueMode: payload.queueMode,
        queuedCount
      })
      if (dispatch.action === 'reject') {
        return {
          ok: false,
          error: dispatch.message,
          queuedCount,
          queuedItems: queuedItemsNow
        }
      }
      if (dispatch.action === 'steer') {
        if (!sendSteer(existing, payload)) {
          disposeHost(id)
          return { ok: false, error: 'chat host 不可用，请重试' }
        }
        // steer 只是把输入写进 host 的 after_iteration 单槽，消息此刻还在排队、
        // 没被模型看到。必须如实回成 `queued`：否则渲染层按「已发送」处理乐观行
        // （解除 queued 标记、把 id 从排队 id 列表里删掉），撤回和 step_start
        // 的激活都失去依据，界面上就留下一条发不出去也撤不回的占位。
        // 真实通知（mica/queue/queued）到达后用同一个 id 覆盖，内容一致。
        if (payload.clientMessageId) {
          existing.hostPending = [
            {
              id: payload.clientMessageId,
              text: prompt,
              queueMode: 'after_iteration'
            }
          ]
        }
        const queuedItemsNow = allQueuedItems(id, existing)
        pushQueueState(id, existing)
        return {
          ok: true,
          queued: true,
          queueMode: 'after_iteration',
          position: 1,
          queuedItems: queuedItemsNow
        }
      }
      const enqueued = queuedRuns.enqueue(id, { sender, payload: { ...payload, prompt } })
      if (!enqueued.ok) {
        return {
          ok: false,
          error: '排队消息已达上限，请先发送或取消排队',
          queuedCount,
          queuedItems: allQueuedItems(id, existing)
        }
      }
      pushQueueState(id, existing)
      return {
        ok: true,
        queued: true,
        position: enqueued.position,
        queuedItems: allQueuedItems(id, existing)
      }
    }
    const accepted = sendTurnStart(existing, payload)
    if (!accepted) {
      disposeHost(id)
      return { ok: false, error: 'chat host 不可用，请重试' }
    }
    return { ok: true }
  }

  // 本节点空闲，准备真的发起一个新 turn：先确认这个会话没有在别处跑。
  // 同一进程里另一个窗口跑着由 `isChatSessionRunning` 拦，别的进程（另一个运行时实例、
  // 终端里的 TUI/exec）由 app-server 子进程写的 turn lease 拦——两处都会同时写同一个
  // session 文件，必须先拒绝，而不是等子进程报错或把历史写坏。
  const unavailable = sessionBusyElsewhere(
    payload.sessionId || existing?.sessionId || existing?.requestedSessionId || ''
  )
  if (unavailable) return { ok: false, error: unavailable }

  const spawned = spawnChatHost(id, sender, payload)
  if (!spawned.ok) return spawned
  const run = runs.get(id)
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

/**
 * 定时循环触发的一轮发送（loops.js 注入的 runner）。
 *
 * 语义上等同于用户此刻按了一下回车：走同一条 startRun，因此排队/steer/会话忙拦截都一致。
 *
 * 目标节点就是启动循环的那个工作区节点——用户能实时看到输出，也能中断。节点已被关掉时
 * 退回 `loop:<nodeId>` 起一个独立 run，历史照样落到会话文件里，下次打开就能看到。
 * 草稿节点（还没 sessionId）也允许：第一轮会创建会话，`turn/started` 再把 sessionId 绑回循环。
 */
export function runLoopTurn(loop) {
  const nodeId = typeof loop?.nodeId === 'string' ? loop.nodeId.trim() : ''
  const prompt = String(loop?.task || '').trim()
  if (!nodeId) return { ok: false, error: '定时任务没有归属的会话' }
  if (!prompt) return { ok: false, error: '定时任务的内容为空' }

  const sessionId = typeof loop.sessionId === 'string' ? loop.sessionId.trim() : ''
  // 会话文件没了（被另一个进程删掉）：把原因留给循环展示，别 spawn 一个必然报
  // "Session not found" 的 app-server。删除会话时会连循环一起清掉，这里只是兜底。
  if (sessionId) {
    const target = sessionFile(sessionId)
    if (!target || !existsSync(target)) return { ok: false, error: '会话不存在，可能已被删除' }
    // 会话已经在跑（用户正在聊 / 上一轮循环还没结束 / 别的进程持有 turn lease）：
    // 这一轮不发，交给调度器推后一个间隔重试，不计入执行次数。
    const unavailable = sessionBusyElsewhere(sessionId)
    if (unavailable) return { ok: false, error: '会话正在运行，本次已跳过' }
  }

  const existing = runs.get(nodeId)
  const sender =
    existing?.sender && !existing.sender.isDestroyed() ? existing.sender : fallbackChatSender()
  const accepted = startRun(sender, nodeId, {
    sessionId: sessionId || null,
    cwd: loop.cwd || null,
    prompt,
    clientMessageId: `loop:${nodeId}:${loop.fireCount + 1}`,
    maxTurns: 9999
  })
  if (!accepted?.ok) return { ok: false, error: accepted?.error || '发送失败' }
  return { ok: true, nodeId }
}

function writeHostRequest(run, request) {
  if (!run?.child?.stdin?.writable) return false
  run.child.stdin.write(`${JSON.stringify(request)}\n`)
  return true
}

function sendCodexRequest(run, method, params, options = {}) {
  if (!run?.child?.stdin?.writable) return false
  run.requestSeq = (run.requestSeq || 0) + 1
  const id = run.requestSeq
  run.pendingRequests = run.pendingRequests || new Map()
  run.pendingRequests.set(id, { method, params, resolve: options.resolve })
  run.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  return true
}

function sendTurnStart(run, payload) {
  // A resident host serves many turns, so the replay buffer and `prompt` must
  // describe the turn being started. The renderer trims persisted history at
  // this prompt boundary before replaying `run.events`; keeping a previous
  // turn's prompt (or its buffered events) makes it replay an answer the
  // session file already contains, which renders the same message twice.
  run.prompt = String(payload.prompt || '').trim()
  // 本轮的用户消息 id（渲染层乐观行的 id / 循环的 `loop:<nodeId>:<n>`）：随
  // `chat:run-started` 回传，渲染层据此判断这一轮的用户气泡是否已经在列表里，
  // 而不是按文本猜——定时任务每一轮的文本都一样。
  run.clientMessageId = payload.clientMessageId || null
  run.events = []
  const params = buildTurnStartParams({
    threadId: run.sessionId || run.requestedSessionId || '',
    prompt: payload.prompt,
    cwd: payload.cwd,
    model: payload.model,
    variant: payload.variant,
    role: payload.role,
    clientMessageId: payload.clientMessageId
  })
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

/** The host answers within one request round-trip; an edit that never comes back
 * (child died between write and reply) must not leave the editor spinning. */
const EDIT_MESSAGE_TIMEOUT_MS = 30_000

/**
 * Mica extension (`mica/turn/editMessage`): rewrite an already-sent user message
 * and run it again. The app-server truncates the session history at that message
 * (the Codex protocol can only append turns), saves it, and starts a fresh turn
 * with the edited text. Only allowed while the session is idle — the truncated
 * history and the new turn must not race an in-flight one.
 */
function editRunMessage(sender, id, payload = {}) {
  const prompt = String(payload.prompt || '').trim()
  const text = String(payload.text || '').trim()
  if (!prompt || !text) return Promise.resolve({ ok: false, error: '编辑内容为空' })

  const existingRun = runs.get(id)
  // 会话在别处跑着时不能编辑：截断历史会立刻落盘，而那一轮的持有者还在写同一个
  // session 文件。与 startRun 同一个判定，理由相同。
  const unavailable = sessionBusyElsewhere(
    payload.sessionId || existingRun?.sessionId || existingRun?.requestedSessionId || ''
  )
  if (unavailable) return Promise.resolve({ ok: false, error: unavailable })

  let run = existingRun
  if (run?.child) {
    run.sender = sender
    if (run.running) {
      return Promise.resolve({ ok: false, error: 'Mica 正在运行，空闲后才能重新发送' })
    }
    if (allQueuedItems(id, run).length > 0) {
      return Promise.resolve({ ok: false, error: '已有等待发送的消息，请先撤回后再编辑' })
    }
  } else {
    // Editing a history row in a session that has not been messaged in this
    // process yet: the resident host does not exist, so start it first (it
    // resumes the session from disk like chat:start does).
    const spawned = spawnChatHost(id, sender, payload)
    if (!spawned.ok) return Promise.resolve(spawned)
    run = runs.get(id)
  }

  const params = { threadId: run.sessionId || run.requestedSessionId || '' }
  params.prompt = prompt
  params.text = text
  if (Number.isInteger(payload.occurrenceFromEnd) && payload.occurrenceFromEnd > 0) {
    params.occurrenceFromEnd = payload.occurrenceFromEnd
  }
  if (payload.model) params.model = payload.model
  if (payload.variant) params.effort = payload.variant
  // Same role extension as turn/start: editing a message re-runs a turn, so a
  // role picked in the composer must apply (and persist) here too.
  if (payload.role) params.role = payload.role
  // Like sendTurnStart: the replay buffer and `prompt` describe the turn being
  // started, otherwise a renderer reload trims the transcript at the previous
  // turn's boundary and replays the wrong run.
  run.prompt = text
  // 编辑重发就地替换了那一行（历史被截断后由 mica/sessionHistory/replaced 交回），
  // 没有新的乐观气泡，别把上一轮的用户消息 id 当成这一轮的。
  run.clientMessageId = null
  run.events = []

  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, error: '编辑重发超时，请重试' }),
      EDIT_MESSAGE_TIMEOUT_MS
    )
    const settle = (result) => {
      clearTimeout(timer)
      resolve(result)
    }
    if (!sendCodexRequest(run, 'mica/turn/editMessage', params, { resolve: settle })) {
      settle({ ok: false, error: 'chat host 不可用，请重试' })
    }
  })
}

/** One request round-trip to the resident host. Unlike turn/start these are pure
 * queries/commands: a missing child (or a host that died between write and reply)
 * must resolve as a failure instead of leaving the caller spinning. */
const HOST_TASK_REQUEST_TIMEOUT_MS = 15_000
// 插件面板的动作可能要落盘、跑一次外部命令（导出聊天记录）再回视图，所以给它的往返
// 留更长一点的预算；超时只影响这一次点击，面板本身照旧可用。
const HOST_PANEL_REQUEST_TIMEOUT_MS = 60_000
function hostTaskRequest(run, method, params, { timeoutMs = HOST_TASK_REQUEST_TIMEOUT_MS } = {}) {
  if (!run?.child?.stdin?.writable)
    return Promise.resolve({ ok: false, error: 'chat host 不可用，请重试' })
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, error: 'chat host 请求超时，请重试' }),
      timeoutMs
    )
    const settle = (result) => {
      clearTimeout(timer)
      resolve(result)
    }
    if (!sendCodexRequest(run, method, params, { resolve: settle })) {
      settle({ ok: false, error: 'chat host 不可用，请重试' })
    }
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
  // 派生关系（子会话）：侧栏据此把这条会话挂到父会话下面。
  const parentSessionId =
    typeof payload.parentSessionId === 'string' && payload.parentSessionId.trim()
      ? payload.parentSessionId.trim()
      : ''

  // 这个进程是谁：绑定会话后就是会话 id，草稿态用页签 id。
  const owner = sessionId || id
  // 受控浏览器 / 终端以 MCP 接入，owner 写进配置的请求头 —— 端口和可用能力都是
  // 运行时的状态，所以只能在这一刻生成（`--mcp-config` 与用户配置合并）。
  const mcpConfigPath = writeControlMcpConfig({
    homeDir: resolveMicaHome(),
    origin: process.env[CONTROL_ORIGIN_ENV] || '',
    owner,
    kinds: availableControlKinds(),
    separator: process.platform === 'win32' ? '\\' : '/'
  })

  const args = buildAppServerArgs({
    sessionId,
    parentSessionId,
    cwd,
    model,
    variant,
    role,
    maxTurns: payload.maxTurns,
    mcpConfigPath
  })

  let child
  try {
    child = spawn(mica, args, {
      cwd: cwd || process.cwd(),
      // 还没绑定会话的草稿用页签 id 当 owner：agent 那一轮开出来的浏览器窗口照样
      // 能落到当前这个页签的图标上（node id 全程稳定）。
      env: buildSpawnEnv(process.env, owner),
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  // `@` 补全要先有一份工作区文件列表，否则用户敲下第一个 `@` 就卡在一次完整
  // `git ls-files`（大仓库约 1.7s）上。与 CLI 的 file-mention 插件同一时机预热，
  // 失败静默忽略（候选仍会在真正输入时现扫）。没有 cwd 时不预热：那时的后备值是
  // 运行时自己的 cwd（Finder 启动通常是 `/`），扫它既慢又没有意义。
  if (cwd) prewarmFileMentions(cwd)

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
    hostPending: [],
    // 会话级附着（chat-viewers.js）：ownerId 默认是创建者，观察者关页签时可能转让；
    // viewers 是「按 session 找过来的另一个页面」的心跳表，用来决定能不能回收。
    ownerId: id,
    ownerTransferredAt: 0,
    viewers: new Map(),
    // 最近一次后台任务 / subagent 快照（随 is-running 回给中途附着的客户端）
    lastSnapshots: {},
    // 正在回答的 By The Way 线程 id（抽屉的多个 tab 各自在跑，任一条在跑就点亮侧栏）
    btwBusyThreads: new Set()
  }
  run.sender = sender
  run.eventPacer = createChatEventPacer(({ sequence, event }) => {
    if (runs.get(id) === run && run.sender && !run.sender.isDestroyed()) {
      // sessionId 让「另一个页签打开同一会话」也能认领这一帧（它自己的 node id 不同）。
      run.sender.send('chat:event', { id, sessionId: runSessionId(run), sequence, event })
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
      rejectUnansweredTurns(id, run, message)
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
      const aborted = run.aborting || signal === 'SIGTERM' || signal === 'SIGINT'
      // stderr 常常在 close 之后才到，退而求其次用退出码，别让错误只剩一句「已退出」。
      const failure = run.stderr.trim() || `mica 进程已退出（code ${exitCode ?? 'null'}）`
      // host 在应答 turn/start 之前就退出（启动参数被拒绝、进程崩了）：这一轮从未跑过，
      // 撤回乐观气泡，别让用户以为消息已发送、历史里却查不到。
      let rejected = false
      if (!aborted) {
        // 紧随其后的 turn.error 通知会渲染成同一条错误，这里只做撤回，不重复提示。
        rejected = rejectUnansweredTurns(id, run, failure, { silent: true })
      }
      if (aborted) {
        postNotify(`${id}:mica`, 'turn.aborted', extra)
      } else {
        postNotify(`${id}:mica`, 'turn.error', { ...extra, summary: failure.slice(0, 200) })
      }
      sendChatExit(id, run, {
        exitCode,
        signal,
        // 已经用 chat:queue-error 报过同一条错误了，别再在会话里留一份一样的 /error。
        ...(exitCode && !rejected ? { error: failure } : {})
      })
    }
  })

  return { ok: true }
}

/**
 * host 走了但没应答的请求：带 resolve 的当场回失败，turn/start 转成 `chat:queue-error`
 * 让渲染层撤回乐观气泡并恢复草稿（与 Host 明确拒绝 turn/start 时同一条路径）。
 */
function rejectUnansweredTurns(id, run, message, { silent = false } = {}) {
  const { rejectedTurns } = settlePendingHostRequests(run, message)
  if (rejectedTurns.length === 0) return false
  run.running = false
  run.currentTurnId = null
  for (const rejected of rejectedTurns) {
    if (run.sender && !run.sender.isDestroyed()) {
      run.sender.send('chat:queue-error', {
        id,
        ...rejected,
        error: message,
        ...(silent ? { silent } : {})
      })
    }
  }
  return true
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
  if (!message.error) {
    // Request-level results the renderer awaits over IPC (chat:edit-message).
    // Turn/steer acks carry nothing the event stream does not already say.
    pending.resolve?.({ ok: true, result: message.result })
    return
  }
  // Request-level errors (busy turn/start, steer mismatch, ...). Surface as
  // an error event so the renderer sees why a message did not start.
  const errorMessage = message.error.message || 'chat host 请求失败'
  if (pending.resolve) {
    // A caller is awaiting this request over IPC (chat:edit-message). Hand it the
    // reason and stop here: pushing an `error` event for a turn that never
    // existed would make the renderer mark the run failed and show the message
    // twice.
    pending.resolve({ ok: false, error: errorMessage })
    return
  }
  if (pending.method === 'turn/start' || pending.method === 'turn/steer') {
    // The message never reached the host queue. Tell the renderer so it can
    // roll back the optimistic bubble instead of leaving it looking sent (and
    // queued) forever.
    if (run.sender && !run.sender.isDestroyed()) {
      run.sender.send('chat:queue-error', {
        id,
        method: pending.method,
        clientMessageId: pending.params?.clientMessageId || null,
        text: pending.params?.input?.[0]?.text || null,
        error: errorMessage
      })
    }
    run.hostPending = []
    if (pending.method === 'turn/start') {
      // No turn exists, so no turn/completed will arrive: clear the optimistic
      // running state (the host itself stays alive for the next message).
      // exitSent must be re-armed: it is only cleared by turn/started, so a
      // second failed start would otherwise leave the renderer stuck running.
      run.running = false
      run.currentTurnId = null
      run.exitSent = false
      sendChatExit(id, run, { exitCode: null, signal: null })
    }
    pushQueueState(id, run)
    return
  }
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
    // 草稿节点上启动的循环在这里才拿到 sessionId：补上绑定，归属与忙判定随后按会话工作。
    if (sessionID) bindLoopSessionId(id, sessionID)
    run.currentTurnId = params.turn?.id || null
    run.running = true
    run.aborting = false
    run.startedAt = notification.emittedAtMs || Date.now()
    run.exitSent = false
    run.toolOutputs.clear()
    // 与 turn/started 同步发出：渲染层只有在这一轮不是自己发起的时候（定时任务、
    // after_turn 排队重放、另一个窗口发起的发送）才需要它，见 pushRunStarted。
    pushRunStarted(id, run)
  } else if (method === 'mica/turn/input') {
    // 插件提交的一轮（`ctx.runtime.submit`）：客户端没有为它插过乐观气泡，启动文本只在
    // 这条通知里。补进对话的用户行由渲染层的 appendRunStartedMessage 负责，它按
    // clientMessageId / 末尾同文本幂等，重复推送不会多出一行。
    const text = typeof params.text === 'string' ? params.text.trim() : ''
    if (text) {
      run.prompt = text
      pushRunStarted(id, run)
    }
  } else if (method === 'turn/completed') {
    run.running = false
    run.currentTurnId = null
    // hostPending 只由 host 的 mica/queue/* 通知改写。turn 结束时清掉它会让
    // 还在 executor 队列里的输入在界面上凭空消失（只剩一条发不出去的占位），
    // 而 executor 每轮收尾都会推一次 queue:changed，那里才是队列的真实状态。
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
    // 排队输入只在**真正完成**的一轮之后接着发；中止/失败时留在队列里等用户
    // 撤回或下一次完成（与 message-queue 插件的 turn:after 同一条规则）。
    if (reason === 'completed') replayQueuedTurn(id, run)
    else pushQueueState(id, run)
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
    // host 每个工具迭代（每次模型请求）都会推一次用量：立刻转发给渲染层，
    // 让输入框状态栏的 tokens/cached/ctx 在长 turn 期间持续刷新，而不是等
    // turn/completed 的 step_finish 才更新一次。频率是一次模型请求一条，
    // 远低于 text delta，走常规事件缓冲即可；恢复重放时最后一条 usage 也会
    // 正确覆盖旧值。tokens 复刻 step_finish 的形状，渲染层共用一套解析。
    if (event && params.tokenUsage) {
      event.tokens = tokensFromCodexUsage(params.tokenUsage)
      pushChatEvent(run, event)
    }
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
  } else if (
    method === 'mica/backgroundTasks/updated' ||
    method === 'mica/subagentTasks/updated' ||
    method === 'mica/waitTasks/updated' ||
    method === 'mica/btw/updated'
  ) {
    // Long-lived host state snapshots: background shell tasks / running
    // subagents / pending `wait_for` waits / the By The Way（btw）thread survive
    // the parent turn and arrive on their own cadence, so
    // they must NOT go through the turn event buffer (appendBufferedEvent would
    // let frequent snapshots evict text/step_finish events and replay stale
    // lists on restore). Deliver directly; the renderer replaces the whole
    // list each time, so the latest snapshot always wins.
    const snapshotEvent = codexNotificationToEvent(notification)
    if (method === 'mica/btw/updated') applyBtwRunning(id, snapshotEvent)
    if (snapshotEvent && run.sender && !run.sender.isDestroyed()) {
      run.lastSnapshots = { ...(run.lastSnapshots || {}), [snapshotEvent.type]: snapshotEvent }
      run.sender.send('chat:event', {
        id,
        sessionId: runSessionId(run),
        sequence: ++run.sequence,
        event: snapshotEvent
      })
    }
    return
  } else if (method === 'mica/notes/updated') {
    // 面板保存了会话笔记：同一会话的其他窗口刷新编辑器。与能力开关同理，不占 turn。
    if (run.sender && !run.sender.isDestroyed()) {
      run.sender.send('chat:notes-updated', {
        id,
        sessionId: runSessionId(run),
        content: typeof params.content === 'string' ? params.content : ''
      })
    }
    return
  } else if (method === 'mica/capabilities/updated') {
    // 会话级能力开关变了：同一会话的其他窗口/标签页用这条快照刷新面板。
    // 它与 turn 生命周期无关，不进事件缓冲，也不改 running / hostPending。
    if (run.sender && !run.sender.isDestroyed()) {
      run.sender.send('chat:capabilities-updated', {
        id,
        sessionId: runSessionId(run),
        selection: {
          version: 1,
          disabledSkills: Array.isArray(params.disabledSkills) ? params.disabledSkills : [],
          disabledTools: Array.isArray(params.disabledTools) ? params.disabledTools : [],
          disabledMcpServers: Array.isArray(params.disabledMcpServers)
            ? params.disabledMcpServers
            : []
        }
      })
    }
    return
  } else if (method === 'mica/sessionHistory/replaced') {
    // A session_* tool replaced the persisted history mid-host (emitted after
    // the host applied the change and saved the session file). Reload the
    // session rows so the renderer swaps its transcript immediately instead of
    // keeping the stale messages until the session is reopened. Delivered
    // directly like the task snapshots: it is a snapshot, not a turn delta.
    const sessionID = run.sessionId || params.threadId || null
    const history = sessionID ? readHistory(sessionID) : []
    // 连同会话元信息一起交回：压缩会写 `displayUsage`，输入框左下角的 ctx 徽标读的是
    // 它。只换消息不换 meta，压完那数字还停在压缩前，看着像没生效。
    const meta = sessionID ? readSessionMeta(sessionID) : null
    const replacedEvent = codexNotificationToEvent(notification)
    if (replacedEvent && run.sender && !run.sender.isDestroyed()) {
      run.sender.send('chat:event', {
        id,
        sessionId: runSessionId(run),
        sequence: ++run.sequence,
        event: { ...replacedEvent, history, ...(meta ? { meta } : {}) }
      })
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

/**
 * 把本轮的起始信息（用户消息 + 起始时间）实时推给渲染层。
 *
 * 只有经过页面 `send()` 的一轮才有本地乐观气泡；host 主动发起的一轮（定时任务、
 * after_turn 排队重放、另一个窗口发起的发送、编辑重发）没有任何本地插入，渲染层只能
 * 从这里拿到用户消息——否则运行中只看到回答，用户气泡要等重新加载会话才出现。
 *
 * 直发而不进事件缓冲：它描述的是「这一轮」，恢复重放时由 `chat:is-running` 的
 * `prompt` 补上同一信息（见 `restore()`），塞进缓冲只会让重放顺序变复杂。
 */
function pushRunStarted(id, run) {
  const prompt = String(run?.prompt || '').trim()
  if (!prompt || !run?.sender || run.sender.isDestroyed()) return
  run.sender.send('chat:run-started', {
    id,
    sessionId: runSessionId(run),
    prompt: run.prompt,
    clientMessageId: run.clientMessageId || null,
    startedAt: run.startedAt || Date.now()
  })
}

function replayQueuedTurn(id, run) {
  const next = queuedRuns.take(id)
  if (!next) {
    pushQueueState(id, run)
    return
  }
  pushQueueState(id, run)
  run.running = true
  if (!sendTurnStart(run, next.payload)) run.running = false
}

function sendChatExit(id, run, payload) {
  if (run.exitSent) return
  // 同一盏 btw 呼吸灯：host 退出时线程不再有人回答，必须熄灭。
  run.btwBusyThreads?.clear()
  notifyServer?.setBtwRunning(`${id}:mica`, false)
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
    const items = allQueuedItems(id, run)
    run.sender.send('chat:exit', {
      id,
      sessionId: run.sessionId || run.requestedSessionId,
      ...payload,
      aborted: run.aborting,
      queuedCount: items.length,
      queuedItems: items
    })
  }
}

function disposeHost(id) {
  const run = runs.get(id)
  if (!run) return
  runs.delete(id)
  queuedRuns.clear(id)
  // host 一走 btw 就没有执行者了：不熄灭这盏灯，侧栏会永远显示「在跑」。
  run.btwBusyThreads?.clear()
  notifyServer?.setBtwRunning(`${id}:mica`, false)
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

/**
 * 点停止时把排队消息一起取回来。
 *
 * 「停下来」不等于「停下并把刚才排的那句话发出去」：用户按的是停止，排队消息应该回到
 * 输入框。两个槽都要取——本地 after_turn 队列，以及 host 的 after_iteration 单槽
 * （它活在 app-server 进程里，只能经 `mica/queue/recall` 取）。
 *
 * 取不到就留着（已经注入给模型，或 host 不响应）：中止之后它仍留在队列里，用户还能
 * 按 Shift+← 手动撤回，不会凭空消失。
 */
async function recallQueuedForAbort(id, run) {
  const recalled = []
  for (let item = queuedRuns.take(id); item; item = queuedRuns.take(id)) {
    recalled.push({ id: item.payload?.clientMessageId || '', text: item.payload?.prompt || '' })
  }
  if (!run?.child) return recalled
  // 单槽：最多一条。`run.hostPending` 只是 host 通知的镜像，可能落后（确认还在路上），
  // 所以先按已知 id 取；取不到再不带 id 取一次——宿主那边 `mica/queue/recall` 不带 id
  // 时取的就是槽里那一条，刚入队、确认还没到的消息因此也能取回。
  const pendingId = run.hostPending?.[0]?.id
  const candidates = pendingId ? [pendingId, undefined] : [undefined]
  for (const clientMessageId of candidates) {
    const response = await hostTaskRequest(
      run,
      'mica/queue/recall',
      clientMessageId ? { clientMessageId } : {},
      // 停止是交互动作，不能为了取队列陪 host 等满默认超时：取不到就当没排队。
      { timeoutMs: ABORT_RECALL_TIMEOUT_MS }
    )
    const input = response?.result?.input
    if (!response?.ok || !input) continue
    recalled.push({ id: input.id || clientMessageId || '', text: input.text || '' })
    break
  }
  return recalled
}

async function abortRun(id) {
  const run = runs.get(id)
  if (!run?.child) return { ok: false, recalled: [] }
  // 先撤回排队、再中断：撤回是唯一能保证「这段话没有被发出去」的顺序。
  const recalled = await recallQueuedForAbort(id, run)
  if (recalled.length) pushQueueState(id, run)
  // host 已经空闲、队列里却还留着一条（上一轮被中止、用户还没撤回）：停止同样把它
  // 退回输入框，界面不必再等一次点按。
  if (!run.running) return { ok: false, recalled }
  run.aborting = true
  // 强杀兜底只针对「点停止时正在跑的这一轮」：中止之后 host 可能立刻起了新的一轮
  // （排队重放、用户紧接着发的消息），那一轮是新的 turn/started（`aborting` 已被它
  // 清掉、turn id 也换了）。按旧的 5s 定时器不区分对象地杀进程，就会让新的一轮
  // 刚跑起来就被连人带 host 一起干掉——用户看到的就是「停止后它又跑了一下然后马上停」。
  const abortedTurnId = run.currentTurnId || null
  if (!sendInterrupt(run)) {
    try {
      run.child.kill('SIGTERM')
    } catch {
      // ignore
    }
    return { ok: true, recalled }
  }
  const timer = setTimeout(() => {
    if (runs.get(id) !== run) return
    if (!run.running || !run.aborting) return
    if (abortedTurnId && run.currentTurnId && run.currentTurnId !== abortedTurnId) return
    try {
      run.child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }, ABORT_FORCE_KILL_MS)
  timer.unref?.()
  return { ok: true, recalled }
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
      .map((id) => ({ id, efforts: [], defaultEffort: null }))
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
          // 「快速压缩（本地）」与交互式 /compact 同源：只把工具结果与媒体块
          // 换成占位符，不改对话文本、不丢轮次。--prune-only 是 lossy 的（无
          // 内容可清理时会丢弃最早轮次），不要在这里使用。
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
            toolArgumentsTrimmed: result.toolArgumentsTrimmed,
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

export function registerChatIpc() {
  ipcMain.handle('chat:start', (event, payload = {}) => {
    rememberChatSender(event)
    const id = payload.id
    if (!id) throw new Error('chat id is required')
    return startRun(event.sender, id, payload)
  })

  ipcMain.handle('chat:commit', (event, payload = {}) => {
    const commitId = payload.commitId
    if (!commitId) throw new Error('commit id is required')
    return startCommitRun(event.sender, commitId, payload)
  })

  ipcMain.handle('chat:abort', async (_event, { id } = {}) => {
    if (!id) return { ok: false, recalled: [] }
    return abortRun(id)
  })

  ipcMain.handle('chat:recall-queued', async (event, { id, clientMessageId } = {}) => {
    if (!id) return { ok: false, error: 'chat id 缺失', queuedCount: 0, queuedItems: [] }
    return recallQueuedRun(event.sender, id, clientMessageId)
  })

  // Freeze a queued message for the recall round-trip: the renderer holds it
  // before pulling the text back into the composer, so an iteration boundary
  // cannot send the text the user is re-editing. `held: false` releases it.
  ipcMain.handle('chat:hold-queued', async (event, { id, clientMessageId, held } = {}) => {
    if (!id) return { ok: false, error: 'chat id 缺失' }
    const run = runs.get(id)
    if (run?.child) run.sender = event.sender
    const local = queuedRuns.values(id)
    if (local.some((item) => item.payload?.clientMessageId === clientMessageId)) return { ok: true }
    const response = await hostTaskRequest(run, 'mica/queue/hold', {
      clientMessageId,
      held: held !== false
    })
    return { ok: Boolean(response?.ok), ...(response?.error ? { error: response.error } : {}) }
  })

  ipcMain.handle('chat:edit-message', (event, payload = {}) => {
    const id = payload.id
    if (!id) return { ok: false, error: 'chat id 缺失' }
    return editRunMessage(event.sender, id, payload)
  })

  /**
   * 用户在输入框里敲了字（`mica/input/activity`）。
   *
   * 只为「会话已经空闲很久」这类提前量服务：插件拿到这条信号后可以先把历史压小，
   * 下一轮请求就不必为膨胀的上下文付费。宿主不认识任何策略，只转发。
   *
   * 没有常驻进程就直接吞掉——绝不能为了几个按键去 spawn 一个 host。渲染层已经节流，
   * 所以这里不再攒批。
   */
  ipcMain.handle('chat:input-activity', (event, { id } = {}) => {
    const run = runs.get(id)
    if (!run?.child?.stdin?.writable) return { ok: true, forwarded: false }
    run.sender = event.sender
    // 不等回包：用户还在打字，这次压缩的结果与界面无关（插件自己记日志与状态）。
    void hostTaskRequest(run, 'mica/input/activity', {}).catch(() => {})
    return { ok: true, forwarded: true }
  })

  // Mica extensions (mica/backgroundTasks/*, mica/subagentTasks/*): the tasks
  // live in the resident host process, so these are plain request round-trips,
  // not turn starts. They never touch run.running/hostPending and stay usable
  // while a turn is streaming.
  ipcMain.handle('chat:kill-background-task', (event, { id, taskId, forceAfterMs } = {}) => {
    if (!id || !taskId) return { ok: false, error: '参数缺失' }
    const run = runs.get(id)
    if (run?.child) run.sender = event.sender
    return hostTaskRequest(run, 'mica/backgroundTasks/kill', {
      taskId,
      ...(forceAfterMs === undefined ? {} : { forceAfterMs })
    })
  })

  ipcMain.handle('chat:background-task-output', (event, { id, taskId, tailBytes } = {}) => {
    if (!id || !taskId) return { ok: false, error: '参数缺失' }
    const run = runs.get(id)
    if (run?.child) run.sender = event.sender
    return hostTaskRequest(run, 'mica/backgroundTasks/output', {
      taskId,
      ...(tailBytes ? { tailBytes } : {})
    })
  })

  ipcMain.handle('chat:subagent-detail', (event, { id, taskId } = {}) => {
    if (!id || !taskId) return { ok: false, error: '参数缺失' }
    const run = runs.get(id)
    if (run?.child) run.sender = event.sender
    return hostTaskRequest(run, 'mica/subagentTasks/detail', { taskId })
  })

  ipcMain.handle('chat:kill-subagent', (event, { id, taskId } = {}) => {
    if (!id || !taskId) return { ok: false, error: '参数缺失' }
    const run = runs.get(id)
    if (run?.child) run.sender = event.sender
    return hostTaskRequest(run, 'mica/subagentTasks/kill', { taskId })
  })

  // By The Way（CLI 的 `/btw`）：一个问题一次往返，但回答**不等**在这次往返里——
  // host 立刻回 `{ ok: true }`，答案随后经 `mica/btw/updated` 快照到达。所以这个
  // 请求不会被 turn 在跑挡掉，也不改 run.running/hostPending。
  //
  // `threadId` 决定落哪条线程（抽屉的一个 tab）：带上就是在那个 tab 里追问
  // （= `/btw -continue`），不带就是新开一个 tab。空问题 = 只建 tab 不提问。
  /**
   * 拿到（必要时按需起）这个节点的常驻 host。
   *
   * By The Way 的意义是「不往会话里发消息也能问」——刚打开一条历史会话就想问它是
   * 最典型的用法，要求用户先随便发一条消息才能用等于把最该成立的场景挡在门外。
   * 起法与发消息同源：按 sessionId resume（没有 sessionId 的草稿没有主流程记录可作
   * 背景，也没有地方记这次开销，直接如实拒绝）。
   */
  function ensureBtwRun(id, event, { sessionId, cwd } = {}) {
    let run = runs.get(id)
    if (run?.child?.stdin?.writable) {
      run.sender = event.sender
      return { run }
    }
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!targetSessionId) return { error: '先发一条消息，有了会话才能用 By The Way 提问' }
    // 别的进程（终端里的 TUI / 另一个运行时）正持有该会话的 turn lease 时不能起：
    // host 启动会 resume 同一个会话文件，btw 结束时还要把用量写回去。
    const unavailable = sessionBusyElsewhere(targetSessionId)
    if (unavailable) return { error: unavailable }
    const spawned = spawnChatHost(id, event.sender, {
      sessionId: targetSessionId,
      cwd: typeof cwd === 'string' ? cwd : ''
    })
    if (!spawned.ok) return { error: spawned.error }
    run = runs.get(id)
    if (!run) return { error: 'chat host 启动失败' }
    return { run }
  }

  /**
   * 能力面板用的 host：有常驻进程就直接用，否则按需起一个。
   *
   * 与 By The Way 的区别是允许草稿会话（还没有 sessionId）：选择只存在内存里，
   * 首轮保存会带上它——用户可以先关掉几个工具再开始第一条消息。
   */
  function ensureCapabilityRun(id, event, { sessionId, cwd } = {}) {
    let run = runs.get(id)
    if (run?.child?.stdin?.writable) {
      run.sender = event.sender
      return { run }
    }
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (targetSessionId) {
      const unavailable = sessionBusyElsewhere(targetSessionId)
      if (unavailable) return { error: unavailable }
    }
    const spawned = spawnChatHost(id, event.sender, {
      sessionId: targetSessionId,
      cwd: typeof cwd === 'string' ? cwd : ''
    })
    if (!spawned.ok) return { error: spawned.error }
    run = runs.get(id)
    if (!run) return { error: 'chat host 启动失败' }
    return { run }
  }

  ipcMain.handle(
    'chat:btw-ask',
    (event, { id, question, threadId, queue, sessionId, cwd } = {}) => {
      const text = typeof question === 'string' ? question.trim() : ''
      const thread = typeof threadId === 'string' ? threadId.trim() : ''
      if (!id) return { ok: false, error: 'chat id 缺失' }
      const ensured = ensureBtwRun(id, event, { sessionId, cwd })
      if (!ensured.run) return { ok: false, error: ensured.error }
      return hostTaskRequest(ensured.run, 'mica/btw/ask', {
        question: text,
        ...(thread ? { threadId: thread } : {}),
        ...(queue ? { queue: true } : {})
      })
    }
  )

  // 抽屉的 tab 条：线程活在 host 里，客户端只知道自己的 id，所以「重开页面/重开 app
  // 之后还有哪些 tab、各自聊了什么」只能问 host。
  ipcMain.handle('chat:btw-threads', (event, { id, sessionId } = {}) => {
    const run = runs.get(id)
    if (run?.child) {
      run.sender = event.sender
      return hostTaskRequest(run, 'mica/btw/threads', {})
    }
    // 还没有常驻 host（页面刚打开一条历史会话、或者 app 刚重启）：直接读会话的落盘
    // 快照。host 每次变更都会写、退出前还会 flush，所以它就是「关掉 app 之前的样子」；
    // 为了一次列表去 spawn 一整个 host 进程不值当。
    const target = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!target) return { ok: true, threads: [] }
    const stored = readBtwState(target)
    return {
      ok: true,
      threads: stored.map((thread) => ({ id: thread.id, entries: thread.entries }))
    }
  })

  ipcMain.handle('chat:btw-close', (event, { id, threadId } = {}) => {
    const run = runs.get(id)
    if (!run?.child) return { ok: true }
    run.sender = event.sender
    return hostTaskRequest(run, 'mica/btw/close', {
      threadId: typeof threadId === 'string' ? threadId : ''
    })
  })

  // By The Way 的「快速压缩」：与主对话的本地压缩同源（`toolResultsOnly`），
  // 只动发给模型的历史——不调用模型、不丢轮次，所以可以反复执行、也不受
  // 「线程正在回答」限制之外的任何忙守卫影响。
  ipcMain.handle('chat:btw-compact', async (event, { id, threadId, sessionId, cwd } = {}) => {
    const ensured = ensureBtwRun(id, event, { sessionId, cwd })
    if (!ensured.run) return { ok: false, error: ensured.error }
    return hostTaskRequest(ensured.run, 'mica/btw/compact', {
      threadId: typeof threadId === 'string' ? threadId : ''
    })
  })

  // 停止正在回答的那一问：纯命令，不启动任何东西，所以不碰 run 生命周期
  // （turn 正在跑也要能停 btw）。
  ipcMain.handle('chat:btw-interrupt', async (event, { id, threadId, sessionId, cwd } = {}) => {
    const ensured = ensureBtwRun(id, event, { sessionId, cwd })
    if (!ensured.run) return { ok: false, error: ensured.error }
    return hostTaskRequest(ensured.run, 'mica/btw/interrupt', {
      threadId: typeof threadId === 'string' ? threadId : ''
    })
  })

  // 撤回排队中的问题（排队条的 ✕），同样不启动任何东西。
  ipcMain.handle('chat:btw-recall', async (event, { id, threadId, sessionId, cwd } = {}) => {
    const ensured = ensureBtwRun(id, event, { sessionId, cwd })
    if (!ensured.run) return { ok: false, error: ensured.error }
    return hostTaskRequest(ensured.run, 'mica/btw/recall', {
      threadId: typeof threadId === 'string' ? threadId : ''
    })
  })

  ipcMain.handle('chat:history', (_event, { sessionId } = {}) => {
    rememberChatSender(_event)
    if (!sessionId) return []
    return readHistory(sessionId)
  })

  /**
   * 对话右侧的插件面板：读视图 / 转发动作。
   *
   * 面板的处理器活在会话的常驻 host 里（插件就在那个进程里），所以这里与能力面板同一条
   * 起法：有常驻进程就用，没有就按需起一个——刚打开一条历史会话时点开面板是很典型的
   * 场景，要求先发一条消息才能点等于把最该成立的用法挡在门外。宿主不认识任何具体插件：
   * 它只转 `pluginId + action`，视图长什么样由插件决定。
   */
  const pluginPanelRequest = (event, payload, method) => {
    const { id } = payload || {}
    const pluginId = typeof payload?.pluginId === 'string' ? payload.pluginId.trim() : ''
    if (!id) return { ok: false, error: 'chat id 缺失' }
    if (!pluginId) return { ok: false, error: '缺少插件 id' }
    const ensured = ensureCapabilityRun(id, event, {
      sessionId: payload?.sessionId,
      cwd: payload?.cwd
    })
    if (!ensured.run) return { ok: false, error: ensured.error }
    return hostTaskRequest(
      ensured.run,
      method,
      {
        pluginId,
        ...(method === 'mica/pluginPanel/action'
          ? {
              action: typeof payload?.action === 'string' ? payload.action : '',
              key: typeof payload?.key === 'string' ? payload.key : '',
              values: payload?.values && typeof payload.values === 'object' ? payload.values : {}
            }
          : {})
      },
      { timeoutMs: HOST_PANEL_REQUEST_TIMEOUT_MS }
      // 载荷在信封的 `result` 里；渲染层读的是 `{ ok, view }` / `{ ok, error }`。
    ).then(unwrapHostResult)
  }

  ipcMain.handle('chat:plugin-panel-view', (event, payload = {}) =>
    pluginPanelRequest(event, payload, 'mica/pluginPanel/view')
  )

  ipcMain.handle('chat:plugin-panel-action', (event, payload = {}) =>
    pluginPanelRequest(event, payload, 'mica/pluginPanel/action')
  )

  /**
   * 会话右键菜单的插件动作（清单 `desktop.sessionMenu`）。
   *
   * 与面板同一条起法：处理器活在会话的常驻 host 里（插件就在那个进程），没有常驻进程就
   * 按需起一个。结果里的 `copyText` 不在这里写剪贴板——页面拿到后自己写（运行时可能被
   * 局域网里另一台机器打开，那边写的是「用户眼前的剪贴板」）。
   */
  ipcMain.handle('chat:session-menu-run', async (event, payload = {}) => {
    const pluginId = typeof payload?.pluginId === 'string' ? payload.pluginId.trim() : ''
    const action = typeof payload?.action === 'string' ? payload.action.trim() : ''
    if (!pluginId || !action) return { ok: false, error: '缺少插件 id 或动作' }
    const requested = typeof payload?.id === 'string' ? payload.id.trim() : ''
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
    // 侧栏右键不带 chat id：这条会话可能开在某个页签里（用它已有的常驻 host，插件状态
    // 就是内存里那份），也可能根本没打开过（按需起一个，从会话文件 resume）。
    const id =
      requested || liveRunIdForSession(sessionId) || `session-menu:${sessionId || randomUUID()}`
    const ensured = ensureCapabilityRun(id, event, {
      sessionId: payload?.sessionId,
      cwd: payload?.cwd
    })
    if (!ensured.run) return { ok: false, error: ensured.error }
    const result = await hostTaskRequest(
      ensured.run,
      'mica/sessionMenu/run',
      { pluginId, action },
      { timeoutMs: HOST_PANEL_REQUEST_TIMEOUT_MS }
    ).then(unwrapHostResult)
    return result
  })

  // Mica extension (`mica/session/rename`): renaming has to go through whichever
  // process owns the session file. The resident host rewrites it from its
  // in-memory snapshot on every save, so a direct disk write from here is
  // silently reverted by that host's next turn — and is refused outright while
  // one runs. With no host around (idle session, or a host that was disposed)
  // nothing else writes the file and the direct path is exact.
  ipcMain.handle('chat:rename-session', async (event, { sessionId, title } = {}) => {
    const target = typeof sessionId === 'string' ? sessionId.trim() : ''
    const nextTitle = typeof title === 'string' ? title.trim() : ''
    if (!isValidSessionId(target) || !nextTitle) return { ok: false, error: '会话标题无效' }
    for (const run of runs.values()) {
      if (run.sessionId !== target && run.requestedSessionId !== target) continue
      if (!run.child?.stdin?.writable) continue
      run.sender = event.sender
      const result = await hostTaskRequest(run, 'mica/session/rename', { title: nextTitle })
      if (result?.ok === false) return { ok: false, error: result.error || '重命名失败' }
      return { ok: true, title: typeof result?.title === 'string' ? result.title : nextTitle }
    }
    // 另一个进程（终端里的 TUI / 另一个运行时实例）持着 turn lease：它随后会用
    // 自己的快照落盘，标题必然被覆盖，所以如实拒绝而不是写一个马上消失的标题。
    if (hasLiveTurnLease(target))
      return { ok: false, error: '该会话正在另一个终端或窗口里运行，请等待这一轮结束后再重命名' }
    try {
      return { ok: true, title: renameSessionFile(sessionsDir(), target, nextTitle) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('chat:input-history:read', () => readInputHistory())

  ipcMain.handle('chat:input-history:append', (_event, { text } = {}) => appendInputHistory(text))

  ipcMain.handle('chat:meta', (_event, { sessionId, cwd } = {}) => {
    rememberChatSender(_event)
    if (!sessionId) return readDefaultMeta(cwd)
    return readSessionMeta(sessionId)
  })

  ipcMain.handle('chat:dispose', (_event, { id } = {}) => {
    if (!id) return false
    if (!runs.has(id)) return false
    disposeHost(id)
    completedRuns.delete(id)
    return true
  })

  ipcMain.handle('chat:is-running', (event, { id, sessionId } = {}) => {
    rememberChatSender(event)
    const run = runs.get(id)
    if (run?.child) run.sender = event.sender
    const leaseSessionId = (typeof sessionId === 'string' && sessionId) || runSessionId(run) || ''
    // Restoring a chat node must see the same queue as a live `chat:queue-state`
    // push: the host-side after_iteration slot (`run.hostPending`) lives outside
    // the local after_turn queue, and returning only `queuedItems(id)` here
    // would drop the waiting row (and the optimistic message's queued marker)
    // as soon as the user switches away and back.
    const items = run ? allQueuedItems(id, run) : queuedItems(id)
    const queuedState = { queuedCount: items.length, queuedItems: items }
    // 「在别处运行」只认 turn lease（另一个进程：终端里的 TUI / mica exec / 另一个运行时
    // 实例）。**不能**把本进程里另一个节点正在跑同一会话也算进来——那是工作区里同一条会话
    // 挂了两个页签（`dedupeSessionNodes` 正在收敛的瞬态），报「另一个进程」会让用户对着一个
    // 马上就消失的死页签，以为是别处占了。另一个窗口里的发送走同一个 node，天然是协同的。
    const remoteRunning =
      !run?.running && Boolean(leaseSessionId) && hasLiveTurnLease(leaseSessionId)
    if (!run) {
      const completed = completedRuns.get(id)
      return completed
        ? {
            running: false,
            finished: true,
            remoteRunning,
            queuedCount: 0,
            queuedItems: [],
            ...completed
          }
        : {
            running: false,
            remoteRunning,
            sessionId: null,
            events: [],
            snapshots: [],
            ...queuedState
          }
    }
    if (!run.running) {
      return {
        running: false,
        finished: !run.exitSent,
        remoteRunning,
        ...queuedState,
        sessionId: run.sessionId,
        events: run.events.slice(),
        snapshots: runSnapshots(run),
        prompt: run.prompt,
        startedAt: run.startedAt
      }
    }
    return {
      running: true,
      remoteRunning: false,
      ...queuedState,
      sessionId: run.sessionId,
      events: run.events.slice(),
      snapshots: runSnapshots(run),
      prompt: run.prompt,
      startedAt: run.startedAt
    }
  })

  ipcMain.handle('chat:models', () => listModels())

  ipcMain.handle('chat:roles', () => listRoles())

  // 会话级能力（skills / tools / MCP servers）。目录与开关都只有常驻 host 知道，
  // 所以这里必要时按需起一个（与 By The Way 同一条路），再走一次普通请求。
  ipcMain.handle('chat:capabilities', async (event, { id, sessionId, cwd } = {}) => {
    if (!id) return { ok: false, error: 'chat id 缺失' }
    const ensured = ensureCapabilityRun(id, event, { sessionId, cwd })
    if (!ensured.run) return { ok: false, error: ensured.error }
    // hostTaskRequest 回的是 `{ ok, result }` 这一层信封，app-server 的载荷在
    // `result` 里。面板要的是载荷本身，所以这里拆包——否则读到的全是 undefined，
    // 表现为「三页签都是 0/0」。
    return unwrapHostResult(await hostTaskRequest(ensured.run, 'mica/capabilities/get', {}))
  })

  ipcMain.handle('chat:set-capabilities', async (event, { id, sessionId, cwd, selection } = {}) => {
    if (!id) return { ok: false, error: 'chat id 缺失' }
    const ensured = ensureCapabilityRun(id, event, { sessionId, cwd })
    if (!ensured.run) return { ok: false, error: ensured.error }
    return unwrapHostResult(
      await hostTaskRequest(ensured.run, 'mica/capabilities/set', { selection })
    )
  })

  // 会话笔记：用户与模型共同维护的 markdown，存在会话快照里（不在对话历史里），
  // 所以压缩不会动它。读写都走常驻 host —— 它手里的快照才是唯一事实来源，
  // 直接改 session 文件会被下一次保存覆盖。
  ipcMain.handle('chat:notes', async (event, { id, sessionId, cwd } = {}) => {
    if (!id) return { ok: false, error: 'chat id 缺失' }
    const ensured = ensureCapabilityRun(id, event, { sessionId, cwd })
    if (!ensured.run) return { ok: false, error: ensured.error }
    return unwrapHostResult(await hostTaskRequest(ensured.run, 'mica/notes/get', {}))
  })

  ipcMain.handle('chat:set-notes', async (event, { id, sessionId, cwd, content } = {}) => {
    if (!id) return { ok: false, error: 'chat id 缺失' }
    const ensured = ensureCapabilityRun(id, event, { sessionId, cwd })
    if (!ensured.run) return { ok: false, error: ensured.error }
    return unwrapHostResult(
      await hostTaskRequest(ensured.run, 'mica/notes/set', {
        content: typeof content === 'string' ? content : ''
      })
    )
  })

  // 插件的会话级设置：清单里标了 perSession 的字段才出现。默认值在插件设置里
  // （配置页写），这里读写的是本会话的覆盖，跟会话快照一起落盘。
  ipcMain.handle('chat:plugin-settings', async (event, { id, sessionId, cwd } = {}) => {
    if (!id) return { ok: false, error: 'chat id 缺失' }
    const ensured = ensureCapabilityRun(id, event, { sessionId, cwd })
    if (!ensured.run) return { ok: false, error: ensured.error }
    return unwrapHostResult(await hostTaskRequest(ensured.run, 'mica/pluginSettings/get', {}))
  })

  ipcMain.handle(
    'chat:set-plugin-settings',
    async (event, { id, sessionId, cwd, pluginId, values } = {}) => {
      if (!id) return { ok: false, error: 'chat id 缺失' }
      if (typeof pluginId !== 'string' || !pluginId) return { ok: false, error: 'pluginId 缺失' }
      const ensured = ensureCapabilityRun(id, event, { sessionId, cwd })
      if (!ensured.run) return { ok: false, error: ensured.error }
      return unwrapHostResult(
        await hostTaskRequest(ensured.run, 'mica/pluginSettings/set', { pluginId, values })
      )
    }
  )

  ipcMain.handle('chat:compact', async (_event, { sessionId, mode } = {}) => {
    if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: 'sessionId 缺失' }
    const resolvedMode = mode === 'local' ? 'local' : 'model'
    const started = Date.now()
    const result = await runCompactSession(sessionId, resolvedMode)
    // 压缩是最长的一次阻塞（实测 6–38 秒），但只按通道计时看不出是本地清理还是
    // 模型摘要。把请求的模式和子进程回报的实际策略一起记下来，才能判断下一次该
    // 优化哪条路径。
    logger('chat').info('compact.finished', {
      requestedMode: resolvedMode,
      ms: Date.now() - started,
      ok: result?.ok !== false,
      strategy: result?.strategy ?? null,
      beforeCount: result?.beforeCount ?? null,
      afterCount: result?.afterCount ?? null,
      beforeTokenEstimate: result?.beforeTokenEstimate ?? null,
      afterTokenEstimate: result?.afterTokenEstimate ?? null,
      savedRatio: result?.savedRatio ?? null
    })
    return result
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
