import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  bindLoopSession,
  catchUpLoops,
  dueLoop,
  emptyLoops,
  findLoop,
  markLoopFired,
  markLoopSkipped,
  nextLoopDueAt,
  normalizeLoops,
  removeLoop,
  removeLoopsForSession,
  setLoopInterval,
  setLoopStatus,
  setLoopTask,
  startLoop
} from './loop-state'

/**
 * 定时循环任务的宿主：磁盘上的 `userData/loops.json`、进程内的定时器，以及 `loops:*` 这组 IPC。
 *
 * 数据模型与状态转移在 loop-state.js；真正的「发一条消息」由注入的 runner 完成
 * （server/index.js 里接到 chat.js 的 runLoopTurn）。放在运行时而不是页面里，是因为循环
 * 必须在页签关掉、刷新、换设备打开时都继续跑——页面只是运行时的一个视口。
 *
 * 调度是「单定时器重排」：每次状态变化按最近的到期时刻重设一次，不用轮询，也不会随循环
 * 数量增长出多个定时器。到点时逐个跑，跑完再排下一次，因此上一轮没跑完不会重入。
 */

const FILE_NAME = 'loops.json'

let runner = null
let broadcast = () => {}
let cache = null
let timer = null
/** 同一时刻只跑一轮 tick：循环数超过定时器间隔时避免并发重入。 */
let ticking = false

/** 由 server 注入：把循环列表变更推给所有页面（等价于 ui-state 的广播）。 */
export function setLoopBroadcaster(fn) {
  broadcast = typeof fn === 'function' ? fn : () => {}
}

/** 由 server 注入：把一轮循环任务真的发出去。返回 `{ ok }` 或 `{ ok:false, skipped, error }`。 */
export function setLoopRunner(fn) {
  runner = typeof fn === 'function' ? fn : null
}

function file() {
  return join(app.getPath('userData'), FILE_NAME)
}

function load() {
  if (cache) return cache
  try {
    const raw = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : null
    // 启动时把过期循环收敛到「立刻跑一轮」，但先不落盘——由 scheduleNext/tick 决定后续。
    cache = catchUpLoops(normalizeLoops(raw))
  } catch {
    // 文件损坏时退回空列表：下一次写入会覆盖成合法内容，而不是让运行时起不来。
    cache = emptyLoops()
  }
  return cache
}

function persist(next, reason = 'change') {
  const normalized = normalizeLoops(next)
  const changed = JSON.stringify(normalized) !== JSON.stringify(cache)
  cache = normalized
  if (changed) {
    try {
      const target = file()
      mkdirSync(dirname(target), { recursive: true })
      // 先写临时文件再改名：进程被强杀时不会留下半截 JSON 让所有循环凭空消失。
      const temporary = `${target}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
      renameSync(temporary, target)
    } catch (error) {
      console.error('[mica-desktop] 保存定时任务失败:', error)
    }
  }
  broadcast('loops:changed', { reason, loops: normalized.loops })
  scheduleNext()
  return normalized
}

export function getLoopSnapshot() {
  return { loops: load().loops }
}

/* ------------------------------------------------------------------- 调度 */

function scheduleNext() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const at = nextLoopDueAt(load())
  if (at === null) return
  // 间隔上限是一周，不会掉进 setTimeout 的溢出区间；到点后再由 tick 重排。
  timer = setTimeout(
    () => {
      timer = null
      void tick()
    },
    Math.max(0, at - Date.now())
  )
  timer.unref?.()
}

async function tick() {
  if (ticking) return
  ticking = true
  try {
    // 一次只取最早已到期的那个：跑完它 marks 出新时刻，下一轮 tick 继续，天然串行。
    let due = dueLoop(load(), Date.now())
    while (due) {
      await trigger(due.nodeId)
      due = dueLoop(load(), Date.now())
    }
  } finally {
    ticking = false
    scheduleNext()
  }
}

/**
 * 触发一轮。会话正忙（用户正在聊 / 上一轮还没跑完 / 别的进程持有 turn lease）时跳过这一轮，
 * 不计入执行次数，只把下一次推后一个间隔——绝不并发写同一个 session。
 */
async function trigger(nodeId) {
  const loop = findLoop(load(), nodeId)
  if (!loop) return { ok: false, error: '定时任务不存在' }
  if (loop.status !== 'active') return { ok: false, error: '定时任务已暂停' }

  let result
  try {
    result = runner ? await runner(loop) : { ok: false, error: '定时任务执行器不可用' }
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const at = Date.now()
  if (result?.ok) {
    persist(markLoopFired(load(), nodeId, { at }), 'fired')
    return { ok: true }
  }
  persist(markLoopSkipped(load(), nodeId, { at, error: result?.error || '发送失败' }), 'skipped')
  return { ok: false, error: result?.error || '发送失败' }
}

/* --------------------------------------------------------------------- IPC */

export function registerLoopIpc() {
  ipcMain.handle('loops:list', () => getLoopSnapshot())

  ipcMain.handle('loops:start', async (_event, payload = {}) => {
    const result = startLoop(load(), {
      nodeId: payload.nodeId,
      sessionId: payload.sessionId || null,
      cwd: payload.cwd || null,
      intervalMs: payload.intervalMs,
      task: payload.task
    })
    if (!result.ok) return { ok: false, error: result.error, loops: load().loops }
    persist(result.loops, result.replaced ? 'replaced' : 'started')
    // 与 CLI「启动即执行第一次」一致：不等第一个间隔，立刻跑一轮。
    await trigger(payload.nodeId)
    return { ok: true, replaced: result.replaced, loops: load().loops }
  })

  ipcMain.handle('loops:stop', (_event, { nodeId } = {}) => {
    const exists = Boolean(findLoop(load(), nodeId))
    if (exists) persist(removeLoop(load(), nodeId), 'stopped')
    return { ok: exists, loops: load().loops }
  })

  ipcMain.handle('loops:set-status', (_event, { nodeId, status } = {}) => {
    const result = setLoopStatus(load(), nodeId, status)
    if (!result.ok) return { ok: false, error: result.error, loops: load().loops }
    persist(result.loops, status === 'active' ? 'resumed' : 'paused')
    return { ok: true, loop: result.loop, loops: load().loops }
  })

  ipcMain.handle('loops:set-interval', (_event, { nodeId, intervalMs } = {}) => {
    const result = setLoopInterval(load(), nodeId, intervalMs)
    if (!result.ok) return { ok: false, error: result.error, loops: load().loops }
    persist(result.loops, 'interval')
    return { ok: true, loop: result.loop, loops: load().loops }
  })

  ipcMain.handle('loops:set-task', (_event, { nodeId, task } = {}) => {
    const result = setLoopTask(load(), nodeId, task)
    if (!result.ok) return { ok: false, error: result.error, loops: load().loops }
    persist(result.loops, 'task')
    return { ok: true, loop: result.loop, loops: load().loops }
  })

  ipcMain.handle('loops:fire-now', async (_event, { nodeId } = {}) => {
    const result = await trigger(nodeId)
    return { ...result, loops: load().loops }
  })

  scheduleNext()
}

/** `turn/started` 里节点才拿到 sessionId：补上绑定，让归属与忙判定能按会话工作。 */
export function bindLoopSessionId(nodeId, sessionId) {
  const before = load()
  const after = bindLoopSession(before, nodeId, sessionId)
  if (after !== before) persist(after, 'bound')
}

/** 删除会话时连带清掉它的循环（会话文件没了，循环只会每轮失败）。 */
export function dropLoopsForSession(sessionId) {
  const before = load()
  const after = removeLoopsForSession(before, sessionId)
  if (after !== before) persist(after, 'session-removed')
}

/** 关掉的节点（页签被关闭）是否还该继续跑：循环是服务端的，节点关掉也继续，故此处不清理。 */

/** 运行时退出前清掉定时器（列表已经落盘，不需要 flush）。 */
export function disposeLoops() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
