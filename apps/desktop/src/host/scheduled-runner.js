import { app, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  createScheduledTask,
  dueTasks,
  emptyScheduled,
  nextDueAt,
  normalizeScheduled,
  recordTaskRun,
  recordTaskSkip,
  removeScheduledTask,
  removeTasksForSession,
  updateScheduledTask
} from './scheduled-tasks'

/**
 * 定时任务的宿主：磁盘上的 `userData/scheduled-tasks.json`、进程内的定时器，以及
 * `schedule:*` 这组 IPC。数据模型与校验在 scheduled-tasks.js，真正的「发一条消息」
 * 由注入的 runner 完成（server/index.js 里接到 chat.js 的 runScheduledTurn）。
 *
 * 为什么放在运行时而不是页面里：任务必须在页签关掉、页面刷新、换设备打开时都继续跑，
 * 而页面只是运行时的一个视口。任务列表同样是共享状态，变更会广播给所有页面。
 *
 * 调度是「单定时器重排」：每次状态变化都按最近的到期时刻重设一次，不用轮询，也不会
 * 随着任务数量增长出多个定时器。到点时逐个跑，跑完再排下一次——因此一个任务的前一轮
 * 还没跑完不会重入。
 */

const FILE_NAME = 'scheduled-tasks.json'

let runner = null
let broadcast = () => {}
let cache = null
let timer = null
/** 同一时刻只跑一轮 tick：任务超过定时器间隔时避免并发重入。 */
let ticking = false

/** 由 server 注入：把任务列表变更推给所有页面（等价于 ui-state 的广播）。 */
export function setScheduledBroadcaster(fn) {
  broadcast = typeof fn === 'function' ? fn : () => {}
}

/** 由 server 注入：真正把一条定时消息发出去。返回 `{ ok }` 或 `{ ok:false, skipped, error }`。 */
export function setScheduledRunner(fn) {
  runner = typeof fn === 'function' ? fn : null
}

function file() {
  return join(app.getPath('userData'), FILE_NAME)
}

function load() {
  if (cache) return cache
  try {
    cache = normalizeScheduled(existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : null)
  } catch {
    // 文件损坏时退回空列表：下一次写入会把它覆盖成合法内容，而不是让运行时起不来。
    cache = emptyScheduled()
  }
  return cache
}

function persist(next) {
  const normalized = normalizeScheduled(next)
  const changed = JSON.stringify(normalized) !== JSON.stringify(cache)
  cache = normalized
  if (changed) {
    try {
      const target = file()
      mkdirSync(dirname(target), { recursive: true })
      // 先写临时文件再改名：进程被强杀时不会留下半截 JSON 让所有任务凭空消失。
      const temporary = `${target}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
      renameSync(temporary, target)
    } catch (error) {
      console.error('[mica-desktop] 保存定时任务失败:', error)
    }
  }
  broadcastTasks()
  scheduleNext()
  return normalized
}

function broadcastTasks(reason = 'change') {
  broadcast('schedule:changed', { reason, tasks: load().tasks })
}

export function getScheduledSnapshot() {
  return { tasks: load().tasks }
}

/* ------------------------------------------------------------------- 调度 */

function scheduleNext() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const at = nextDueAt(load())
  if (at === null) return
  // setTimeout 的上限是一周（间隔的最大值），不会溢出；到点后再由 tick 重新排。
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
    const now = Date.now()
    for (const task of dueTasks(load(), now)) {
      await trigger(task.id, { manual: false })
    }
  } finally {
    ticking = false
    scheduleNext()
  }
}

/**
 * 触发一条任务。`manual` 是「立即发送一次」：语义与自动触发完全一致（都消耗一次配额、
 * 都重排下一次），区别只是不等定时器。
 */
async function trigger(id, { manual }) {
  const task = load().tasks.find((item) => item.id === id)
  if (!task) return { ok: false, error: '定时任务不存在' }
  if (task.status !== 'active') return { ok: false, error: '定时任务已暂停或已完成' }
  let result
  try {
    result = runner ? await runner(task) : { ok: false, error: '定时任务执行器不可用' }
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (result?.ok) {
    persist(recordTaskRun(load(), id, { at: Date.now() }))
    return { ok: true }
  }
  // 会话正忙 / host 不可用：不算一次发送，只推后一个间隔。
  persist(
    recordTaskSkip(load(), id, {
      at: Date.now(),
      error: result?.error || (manual ? '发送失败' : '本次跳过，稍后重试')
    })
  )
  return { ok: false, error: result?.error || '发送失败' }
}

/* --------------------------------------------------------------------- IPC */

export function registerScheduledIpc() {
  ipcMain.handle('schedule:list', () => getScheduledSnapshot())

  ipcMain.handle('schedule:create', (_event, payload = {}) => {
    const result = createScheduledTask(load(), { ...payload, id: payload.id || randomUUID() })
    if (!result.ok) return { ok: false, error: result.error, tasks: load().tasks }
    persist(result.scheduled)
    return { ok: true, task: result.task, tasks: load().tasks }
  })

  ipcMain.handle('schedule:update', (_event, { id, patch } = {}) => {
    const result = updateScheduledTask(load(), id, patch || {})
    if (!result.ok) return { ok: false, error: result.error, tasks: load().tasks }
    persist(result.scheduled)
    return { ok: true, task: result.task, tasks: load().tasks }
  })

  ipcMain.handle('schedule:delete', (_event, { id } = {}) => {
    persist(removeScheduledTask(load(), id))
    return { ok: true, tasks: load().tasks }
  })

  ipcMain.handle('schedule:run-now', async (_event, { id } = {}) => {
    const result = await trigger(id, { manual: true })
    return { ...result, tasks: load().tasks }
  })

  // 运行时启动时排一次：进程重启前已经过期的任务会在启动后立刻补跑一轮。
  scheduleNext()
}

/** 删除会话时连带清掉它的定时任务（会话没了，任务只会永远失败）。 */
export function dropTasksForSession(sessionId) {
  return persist(removeTasksForSession(load(), sessionId))
}

/** 运行时退出前清掉定时器（列表已经时落盘的，不需要 flush）。 */
export function disposeScheduled() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
