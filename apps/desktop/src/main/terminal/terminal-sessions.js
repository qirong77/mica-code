/**
 * 终端控制的会话层：真实 PTY + 屏幕镜像。
 *
 * 每个会话就是一条**真实终端**：node-pty 打开 pty 设备与登录 shell，输出原样喂给
 * `@xterm/headless` 做 ANSI 解析，于是 AI 读到的屏幕文本与用户在窗口里看到的一致
 * （清屏、TUI 重绘、光标位置都由终端语义决定），而不是一堆转义序列。
 *
 * 页面与 AI 写的是同一条 pty，因此窗口里手敲的命令和 agent 输入的命令天然共享同一个
 * shell、同一个 cwd、同一份历史。
 */

import { existsSync } from 'node:fs'
import pty from 'node-pty'
import headless from '@xterm/headless'
import { resolveUsableCwd } from '../../host/cwd-utils.js'
import { resolveDefaultShell } from '../../host/shell-path.js'
import { parseBoolean } from '../shared/endpoint-http.js'
import {
  TERMINAL_MAX_SCREEN_LINES,
  TERMINAL_OUTPUT_BUFFER,
  TERMINAL_SCROLLBACK,
  TerminalRequestError,
  appendOutput,
  maskEchoedInput,
  normalizeCwd,
  normalizeKeys,
  normalizeLabel,
  normalizeSize,
  notFoundError,
  outputSince,
  readScreen
} from './terminal-core.js'

const { Terminal } = headless

const FLUSH_INTERVAL_MS = 16
const WAIT_POLL_MS = 50
const DEFAULT_WAIT_TIMEOUT_MS = 15000
const MAX_WAIT_TIMEOUT_MS = 120000
/** 读屏/改尺寸等请求等解析的上限：`tail -f` 这类持续输出不能让请求永久挂着 */
const READ_PARSE_BUDGET_MS = 2000
const MAX_INPUT_CHARS = 64 * 1024
const MAX_SESSIONS = 12
/** 进程自己退出的会话：没有窗口在看时，留一段时间供 AI 读最后屏幕，然后回收 */
const EXITED_TTL_MS = 10 * 60 * 1000
/**
 * 活着但没人管的会话：agent 建完就忘了的话，shell 会一直占着 fd 与内存。
 * 隐藏状态下连续这么久没有任何活动（输出、输入、改尺寸）就回收。
 */
const IDLE_TTL_MS = 6 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 1000
/** 只留最近几次输入用于回显判断，不用记整段历史 */
const RECENT_INPUT_LIMIT = 8

function defaultShell() {
  return resolveDefaultShell({
    platform: process.platform,
    env: process.env,
    exists: existsSync
  })
}

function shellArgsFor(shellPath) {
  if (process.platform === 'win32') return []
  const name = String(shellPath).split(/[\\/]/).pop()?.toLowerCase() || ''
  if (name === 'fish') return ['--login']
  if (['bash', 'zsh', 'sh', 'ksh', 'dash'].includes(name)) return ['-l']
  return []
}

function nowIso() {
  return new Date().toISOString()
}

function sessionSummary(session) {
  return {
    id: session.id,
    owner: session.owner || null,
    label: session.label,
    cwd: session.cwd,
    shell: session.shell,
    cols: session.cols,
    rows: session.rows,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    running: !session.exited,
    exitCode: session.exitCode,
    signal: session.signal ?? null,
    windowVisible: Boolean(session.windowVisible),
    outputSeq: session.output.seq,
    truncated: Boolean(session.output.truncated)
  }
}

export function createTerminalSessions({
  onChange = () => {},
  // 注入点只给测试用：bun 下 node-pty 的原生绑定不会送数据
  spawnPty = (file, args, options) => pty.spawn(file, args, options),
  // 0 关掉自动回收（测试里用 sweep() 手动触发）
  sweepIntervalMs = SWEEP_INTERVAL_MS,
  exitedTtlMs = EXITED_TTL_MS,
  idleTtlMs = IDLE_TTL_MS
} = {}) {
  const sessions = new Map()
  let sequence = 0

  function emit(type, session, extra = {}) {
    try {
      onChange({ type, session, summary: sessionSummary(session), ...extra })
    } catch (error) {
      console.error('[mica-terminal] 事件处理失败:', error)
    }
  }

  function touch(session) {
    session.updatedAt = nowIso()
    session.lastActivityAt = Date.now()
  }

  function flush(session) {
    session.flushTimer = null
    const chunk = session.pending
    session.pending = ''
    if (!chunk || session.closed) return
    const seqFrom = session.output.seq
    session.pendingWrites += 1
    session.term.write(chunk, () => {
      session.pendingWrites = Math.max(0, session.pendingWrites - 1)
      if (session.pendingWrites > 0) return
      const resolvers = session.idleResolvers
      session.idleResolvers = []
      for (const resolve of resolvers) resolve()
    })
    session.output = appendOutput(session.output, chunk, TERMINAL_OUTPUT_BUFFER)
    session.lastOutputAt = Date.now()
    touch(session)
    emit('output', session, { chunk, seqFrom, seq: session.output.seq })
  }

  function scheduleFlush(session) {
    if (session.flushTimer || session.closed) return
    session.flushTimer = setTimeout(() => flush(session), FLUSH_INTERVAL_MS)
    session.flushTimer.unref?.()
  }

  /**
   * 等 headless 把已排队的输出解析完。
   *
   * `term.write('')` 只保证排到队尾，不保证前面的块已经处理完；这里按每次写入的回调
   * 计数，否则刚执行完命令就读屏会读到半截，AI 会误判命令没有输出。
   *
   * `budgetMs` 是硬上限：终端在高吞吐输出时 pendingWrites 可能长期不归零，没有预算
   * 的话读屏与 wait 会一直卡在这里，超时形同虚设。
   */
  function whenParsed(session, budgetMs = Number.POSITIVE_INFINITY) {
    // 还没到 flush 的这段输出也要算进来，否则读到的是少一块的屏幕
    if (session.pending && !session.closed) flush(session)
    if (session.pendingWrites === 0) return Promise.resolve()
    const parsed = new Promise((resolve) => session.idleResolvers.push(resolve))
    if (!Number.isFinite(budgetMs)) return parsed
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, budgetMs))
      timer.unref?.()
      void parsed.then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  function get(id) {
    const session = sessions.get(String(id || ''))
    if (!session) throw notFoundError(`没有这个终端会话：${id}`)
    return session
  }

  async function create(options = {}) {
    // 只数还活着的会话：进程自己退出（例如 agent 跑完 `exit`）的会话不该继续占名额
    const live = [...sessions.values()].filter((session) => !session.exited).length
    if (live >= MAX_SESSIONS) {
      throw new TerminalRequestError(`终端会话数已达上限（${MAX_SESSIONS}），先关闭不用的再开`)
    }
    const requested = normalizeCwd(options.cwd)
    const { cwd } = resolveUsableCwd(requested || process.env.HOME || process.cwd())
    const shell = normalizeCwd(options.shell) || defaultShell()
    if (!existsSync(shell)) {
      throw new TerminalRequestError(`shell 不存在：${shell}`)
    }
    const { cols, rows } = normalizeSize(options)
    const id = `term-${++sequence}`
    const term = new Terminal({
      cols,
      rows,
      scrollback: TERMINAL_SCROLLBACK,
      allowProposedApi: true,
      logLevel: 'off'
    })

    let proc
    try {
      proc = spawnPty(shell, shellArgsFor(shell), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'Mica Code'
        }
      })
    } catch (error) {
      term.dispose()
      throw new TerminalRequestError(
        `无法启动终端（${shell}）：${error instanceof Error ? error.message : String(error)}`
      )
    }

    const session = {
      id,
      owner: options.owner || null,
      label: normalizeLabel(options.label),
      cwd,
      requestedCwd: requested || null,
      shell,
      cols,
      rows,
      term,
      pty: proc,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      exited: false,
      exitCode: null,
      signal: null,
      exitedAt: null,
      closed: false,
      pending: '',
      pendingWrites: 0,
      idleResolvers: [],
      flushTimer: null,
      lastOutputAt: Date.now(),
      lastActivityAt: Date.now(),
      recentInputs: [],
      output: { seq: 0, data: '', truncated: false },
      windowVisible: false
    }
    sessions.set(id, session)

    proc.onData((data) => {
      if (session.closed) return
      session.pending += data
      scheduleFlush(session)
    })

    proc.onExit(({ exitCode, signal }) => {
      if (session.closed) return
      session.exited = true
      session.exitCode = exitCode ?? null
      session.signal = signal ?? null
      session.exitedAt = Date.now()
      touch(session)
      // 退出前把最后一段输出落进屏幕镜像，AI 不会漏掉「进程报错后退出」的那几行
      flush(session)
      emit('exit', session)
    })

    emit('created', session)
    return session
  }

  function list({ owner = null } = {}) {
    const items = [...sessions.values()].map(sessionSummary)
    return owner ? items.filter((item) => item.owner === owner) : items
  }

  async function detail(id, { maxLines } = {}) {
    const session = get(id)
    await whenParsed(session, READ_PARSE_BUDGET_MS)
    if (session.closed) throw notFoundError(`没有这个终端会话：${id}`)
    const screen = readScreen(session.term, { maxLines })
    return {
      ...sessionSummary(session),
      screen,
      inputLine: screen.inputLine,
      cursor: screen.cursor
    }
  }

  function write(id, input = {}) {
    const session = get(id)
    if (session.exited) throw new TerminalRequestError('终端进程已退出，不能再输入')
    const raw = input.data
    const text = input.text
    let payload = ''
    if (typeof raw === 'string' && raw) payload += raw
    if (typeof text === 'string' && text) payload += text
    if (payload.length > MAX_INPUT_CHARS) {
      throw new TerminalRequestError(`一次最多输入 ${MAX_INPUT_CHARS} 个字符`)
    }
    if (!payload) throw new TerminalRequestError('缺少要输入的内容（data 或 text）')
    if (input.submit === true || input.submit === '1' || input.submit === 'true') payload += '\r'
    session.pty.write(payload)
    // 把「刚有输入」算作活动：紧接着的 wait idleMs 要从现在开始计时
    const at = Date.now()
    session.lastOutputAt = at
    // 记下原文：wait 的 text 需要区分「命令回显」和「命令输出」
    session.recentInputs.push({ data: payload, at })
    if (session.recentInputs.length > RECENT_INPUT_LIMIT) session.recentInputs.shift()
    touch(session)
    return { seq: session.output.seq }
  }

  function keys(id, value) {
    const session = get(id)
    if (session.exited) throw new TerminalRequestError('终端进程已退出，不能再输入')
    const payload = normalizeKeys(value)
    session.pty.write(payload)
    touch(session)
    return { seq: session.output.seq }
  }

  async function resize(id, input = {}) {
    const session = get(id)
    if (session.exited) throw new TerminalRequestError('终端进程已退出，不能再调整尺寸')
    const { cols, rows } = normalizeSize(input, { cols: session.cols, rows: session.rows })
    if (cols === session.cols && rows === session.rows) {
      await whenParsed(session, READ_PARSE_BUDGET_MS)
      if (session.closed) throw notFoundError(`没有这个终端会话：${id}`)
      return { ...sessionSummary(session), screen: readScreen(session.term) }
    }
    // term 与 pty 必须一起改：先动 headless，它拒绝时直接报错，不留「报的尺寸与实际
    // 折行不一致」的分叉状态
    try {
      session.term.resize(cols, rows)
    } catch (error) {
      throw new TerminalRequestError(
        `无法调整终端尺寸：${error instanceof Error ? error.message : String(error)}`
      )
    }
    try {
      session.pty.resize(cols, rows)
    } catch (error) {
      session.term.resize(session.cols, session.rows)
      throw new TerminalRequestError(
        `无法调整终端尺寸：${error instanceof Error ? error.message : String(error)}`
      )
    }
    session.cols = cols
    session.rows = rows
    touch(session)
    emit('changed', session)
    await whenParsed(session, READ_PARSE_BUDGET_MS)
    // 等解析期间会话可能被关掉，此时 term 已经 dispose
    if (session.closed) throw notFoundError(`没有这个终端会话：${id}`)
    return { ...sessionSummary(session), screen: readScreen(session.term) }
  }

  function readOutput(id, { since = 0 } = {}) {
    const session = get(id)
    return outputSince(session.output, since)
  }

  /**
   * 等终端到达某个状态：屏幕出现文本 / 正则匹配 / 输出静默 / 进程退出。
   *
   * 用轮询而不是事件订阅：条件可能在任何一次输出后成立，也可能一开始就成立（例如
   * 命令早就跑完了），轮询对「先发生再看」和「先看再等」是同一种写法。间隔 50ms，
   * 对 agent 的操作节奏足够快。
   */
  async function waitFor(id, options = {}) {
    const session = get(id)
    const text = typeof options.text === 'string' ? options.text : ''
    const regexSource = typeof options.regex === 'string' ? options.regex : ''
    let regex = null
    if (regexSource) {
      try {
        regex = new RegExp(regexSource)
      } catch (error) {
        throw new TerminalRequestError(
          `正则不合法：${error instanceof Error ? error.message : error}`
        )
      }
    }
    const idleMs = Number.parseInt(String(options.idleMs ?? ''), 10)
    const wantIdle = Number.isInteger(idleMs) && idleMs > 0
    const wantExit = parseBoolean(options.exited)
    const expectExitCode = Number.parseInt(String(options.expectExitCode ?? ''), 10)
    const wantExitCode = Number.isInteger(expectExitCode)
    if (!text && !regex && !wantIdle && !wantExit && !wantExitCode) {
      throw new TerminalRequestError(
        'wait 需要 text、regex、idleMs、exited、expectExitCode 至少一个条件'
      )
    }
    // 默认过滤刚输入命令的回显：否则 agent 敲完命令再等自己的输出，会立刻命中命令本身
    // 默认过滤刚输入命令的回显：否则 agent 敲完命令再等自己的输出，会立刻命中命令本身
    const skipEcho = options.skipEcho === undefined ? true : parseBoolean(options.skipEcho)
    const timeoutMs = Math.min(
      MAX_WAIT_TIMEOUT_MS,
      Math.max(100, Number.parseInt(String(options.timeoutMs ?? ''), 10) || DEFAULT_WAIT_TIMEOUT_MS)
    )
    const startedAt = Date.now()

    for (;;) {
      if (session.closed) {
        return { matched: false, reason: 'closed', elapsedMs: Date.now() - startedAt }
      }
      // 用剩余预算兜底：持续输出时 pendingWrites 可能始终大于 0
      await whenParsed(session, Math.max(0, timeoutMs - (Date.now() - startedAt)))
      if (session.closed) {
        return { matched: false, reason: 'closed', elapsedMs: Date.now() - startedAt }
      }
      // 匹配范围要覆盖滚动历史：标记可能已经滚出默认的 200 行窗口
      const screen = readScreen(session.term, { maxLines: TERMINAL_MAX_SCREEN_LINES })
      const masked = skipEcho ? maskEchoedInput(screen.text, session.recentInputs) : null
      const matchText = masked ? masked.text : screen.text
      if (masked && masked.masked > 0) {
        screen.text = matchText
        screen.lines = matchText.split('\n')
      }
      if (wantExit && session.exited) {
        return { matched: true, reason: 'exited', elapsedMs: Date.now() - startedAt, screen }
      }
      if (wantExitCode && session.exited) {
        // 不匹配就立刻返回实际退出码：继续耗满超时会让 agent 以为命令还在跑
        return {
          matched: session.exitCode === expectExitCode,
          reason: 'exitCode',
          exitCode: session.exitCode,
          signal: session.signal ?? null,
          elapsedMs: Date.now() - startedAt,
          screen
        }
      }
      if (text && matchText.includes(text)) {
        return { matched: true, reason: 'text', elapsedMs: Date.now() - startedAt, screen }
      }
      if (regex && regex.test(matchText)) {
        return { matched: true, reason: 'regex', elapsedMs: Date.now() - startedAt, screen }
      }
      // 至少等满 idleMs：等待开始前就已经安静下来的终端（比如刚启动完的 shell）不能
      // 立刻判定「稳定」，否则刚写进去的命令还没跑就被读走了
      if (wantIdle && Date.now() - Math.max(session.lastOutputAt, startedAt) >= idleMs) {
        return { matched: true, reason: 'idle', elapsedMs: Date.now() - startedAt, screen }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return { matched: false, reason: 'timeout', elapsedMs: Date.now() - startedAt, screen }
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
    }
  }

  function setWindowVisible(id, visible) {
    const session = sessions.get(String(id || ''))
    if (!session) return
    if (session.windowVisible === Boolean(visible)) return
    session.windowVisible = Boolean(visible)
    touch(session)
    emit('changed', session)
  }

  /**
   * 自动回收没人管的会话，避免 agent 建了不关的终端越积越多。
   *
   * 两条线都以「窗口没在显示」为前提：正在看的终端一律不动。
   * - 进程已退出：留十分钟供 AI 读最后屏幕，然后回收。
   * - 进程还活着：隐藏且连续 6 小时没有任何活动才回收；只要还有输出、输入或
   *   改尺寸就重新计时，正在跑东西的 shell 不会被误杀。
   */
  function shouldRecycle(session, now) {
    if (session.windowVisible) return false
    if (session.exited) return now - (session.exitedAt || now) >= exitedTtlMs
    return now - (session.lastActivityAt || now) >= idleTtlMs
  }

  function sweep(now = Date.now()) {
    const removed = []
    for (const session of [...sessions.values()]) {
      if (!shouldRecycle(session, now)) continue
      try {
        close(session.id)
        removed.push(session.id)
      } catch {
        // 单个会话回收失败不影响其他会话
      }
    }
    return removed
  }

  const sweepTimer = sweepIntervalMs > 0 ? setInterval(() => sweep(), sweepIntervalMs) : null
  sweepTimer?.unref?.()

  function close(id) {
    const session = get(id)
    if (session.closed) return { closed: session.id }
    session.closed = true
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    // 唤醒还在等解析的请求（detail / resize / wait），否则它们会永远挂着
    const resolvers = session.idleResolvers
    session.idleResolvers = []
    for (const resolve of resolvers) resolve()
    try {
      // destroy 会先 SIGHUP 再关掉 master fd；只 kill 会把 pty 句柄留着
      if (typeof session.pty.destroy === 'function') session.pty.destroy()
      else session.pty.kill()
    } catch {
      // 进程可能已经退出
    }
    try {
      session.term.dispose()
    } catch {
      // 已释放
    }
    sessions.delete(session.id)
    emit('closed', session)
    return { closed: session.id }
  }

  function shutdown() {
    if (sweepTimer) clearInterval(sweepTimer)
    for (const session of [...sessions.values()]) {
      try {
        close(session.id)
      } catch {
        // 忽略单个会话的关闭失败
      }
    }
  }

  return {
    create,
    list,
    get,
    detail,
    write,
    keys,
    resize,
    readOutput,
    waitFor,
    setWindowVisible,
    sweep,
    close,
    shutdown,
    summary: sessionSummary
  }
}
