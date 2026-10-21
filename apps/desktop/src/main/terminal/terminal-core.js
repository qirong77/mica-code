/**
 * 终端控制的纯逻辑：尺寸归一化、cwd 解析、按键映射、屏幕快照。
 *
 * 「终端控制」里的终端是**真实终端**：node-pty 开的是真实 pty 设备 + 登录 shell，和
 * Terminal.app / VS Code 的底层一样。这里的快照只是把真实输出解析成屏幕文本给 AI 读，
 * 不参与执行，也不替代页面里的 xterm。
 *
 * 不 import electron，bun test 可以直接覆盖。
 */

export const TERMINAL_SERVICE_APP = 'mica-code-terminal'
export const TERMINAL_SERVICE_VERSION = 1

/** 与内置终端一致：进来先给一个 120×32 的可用尺寸 */
export const TERMINAL_DEFAULT_SIZE = { cols: 120, rows: 32 }
export const TERMINAL_MIN_SIZE = { cols: 20, rows: 5 }
export const TERMINAL_MAX_SIZE = { cols: 400, rows: 200 }
/** headless 镜像保留的滚动行数；屏幕快照最多读这么多 */
export const TERMINAL_SCROLLBACK = 2000
/** AI 默认看到的屏幕长度（行） */
export const TERMINAL_DEFAULT_SCREEN_LINES = 200
export const TERMINAL_MAX_SCREEN_LINES = 2000
/** 输出环形缓冲：断线重连按 seq 续传，超出就标记 truncated 让页面重建 */
export const TERMINAL_OUTPUT_BUFFER = 256 * 1024

const MAX_CWD = 4096
const MAX_LABEL = 60

export class TerminalRequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'TerminalRequestError'
    this.status = status
  }
}

export function notFoundError(message) {
  return new TerminalRequestError(message, 404)
}

export function timeoutError(message) {
  return new TerminalRequestError(message, 504)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 尺寸：非数字/越界就回落到默认值或边界。pty 与 headless 必须用同一个尺寸，
 * 否则 AI 读到的换行位置会和页面显示对不上。
 */
export function normalizeSize(input = {}, fallback = TERMINAL_DEFAULT_SIZE) {
  const cols = Number.parseInt(String(input.cols ?? ''), 10)
  const rows = Number.parseInt(String(input.rows ?? ''), 10)
  return {
    cols: clamp(
      Number.isInteger(cols) && cols > 0 ? cols : fallback.cols,
      TERMINAL_MIN_SIZE.cols,
      TERMINAL_MAX_SIZE.cols
    ),
    rows: clamp(
      Number.isInteger(rows) && rows > 0 ? rows : fallback.rows,
      TERMINAL_MIN_SIZE.rows,
      TERMINAL_MAX_SIZE.rows
    )
  }
}

/** 只接受字符串形式的绝对/相对路径；真正可用性由会话创建时的目录解析兜底 */
export function normalizeCwd(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_CWD || trimmed.includes('\0')) return ''
  return trimmed
}

export function normalizeLabel(value, fallback = '终端') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_LABEL) : fallback
}

/** 屏幕快照最多取多少行（0/负数 → 默认） */
export function normalizeMaxLines(value, fallback = TERMINAL_DEFAULT_SCREEN_LINES) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return clamp(parsed, 1, TERMINAL_MAX_SCREEN_LINES)
}

/* --------------------------------------------------------------------- 按键 */

/**
 * 命名按键 → 终端转义序列。单字符原样透传（大小写、符号都按用户给的来）。
 * 未知按键抛错而不是静默忽略：agent 拼错 `Enter` 时应该立刻知道，而不是以为输入了。
 */
const NAMED_KEYS = {
  enter: '\r',
  return: '\r',
  newline: '\r',
  tab: '\t',
  escape: '\x1b',
  esc: '\x1b',
  space: ' ',
  backspace: '\x7f',
  delete: '\x1b[3~',
  insert: '\x1b[2~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  'shift+tab': '\x1b[Z',
  'ctrl+a': '\x01',
  'ctrl+b': '\x02',
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+e': '\x05',
  'ctrl+f': '\x06',
  'ctrl+g': '\x07',
  'ctrl+h': '\x08',
  'ctrl+k': '\x0b',
  'ctrl+l': '\x0c',
  'ctrl+n': '\x0e',
  'ctrl+o': '\x0f',
  'ctrl+p': '\x10',
  'ctrl+q': '\x11',
  'ctrl+r': '\x12',
  'ctrl+s': '\x13',
  'ctrl+t': '\x14',
  'ctrl+u': '\x15',
  'ctrl+v': '\x16',
  'ctrl+w': '\x17',
  'ctrl+x': '\x18',
  'ctrl+y': '\x19',
  'ctrl+z': '\x1a',
  'ctrl+left': '\x1b[1;5D',
  'ctrl+right': '\x1b[1;5C'
}

const KEY_ALIASES = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  return: 'enter',
  esc: 'escape',
  del: 'delete'
}

export function keySequence(key) {
  const raw = String(key ?? '')
  if (!raw) throw new TerminalRequestError('按键不能为空')
  const compact = raw.toLowerCase().replace(/[\s_]+/g, '')
  const named = NAMED_KEYS[KEY_ALIASES[compact] || compact]
  if (named) return named
  // 单个 Unicode 字符（含空格之外的符号）直接写进终端
  if ([...raw].length === 1) return raw
  // `Ctrl+C` 之外的组合键写法（`alt+b` 之类）交给调用方用 input 直接发转义序列
  throw new TerminalRequestError(
    `不认识的按键：${raw}（可用 Enter/Tab/Escape/方向键/Ctrl+C…，或直接传单字符）`
  )
}

export function normalizeKeys(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TerminalRequestError('keys 必须是非空数组，例如 ["Enter"]')
  }
  if (value.length > 50) throw new TerminalRequestError('一次最多发送 50 个按键')
  return value.map(keySequence).join('')
}

/* --------------------------------------------------------------- 屏幕快照 */

/** 刚输入的命令在多长时间内算作「可能是回显」 */
export const ECHO_WINDOW_MS = 30 * 1000

function lineText(line) {
  return line ? line.translateToString(true) : ''
}

function normalizeEchoText(value) {
  return String(value ?? '')
    .replace(/[\p{Cc}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 去掉「刚输入的命令回显」所在的行。
 *
 * shell 会把输入原样回显到屏幕上，agent 敲完 `echo done` 再等 `done` 时，命令自己的
 * 回显就已经命中了。这里按最近写入的原文做行级过滤：回显行包含整段输入原文，而命令
 * 真正的输出通常不含。只是启发式——确实要匹配回显时可以关掉（`skipEcho: false`）。
 */
export function maskEchoedInput(
  text,
  inputs = [],
  { now = Date.now(), windowMs = ECHO_WINDOW_MS } = {}
) {
  const source = String(text ?? '')
  // 多行粘贴时 shell 逐行回显：按行拆开，每行都能对上自己的回显
  const needles = (inputs || [])
    .filter((entry) => entry && now - Number(entry.at || 0) <= windowMs)
    .flatMap((entry) => String(entry.data ?? '').split(/\r?\n|\r/))
    .map(normalizeEchoText)
    .filter((payload) => payload.length >= 2)
  if (needles.length === 0) return { text: source, masked: 0 }

  const lines = source.split('\n')
  const normalized = lines.map(normalizeEchoText)
  const maskedLines = new Set()
  for (const needle of needles) {
    // 取最后一处「带提示符」的命中：同一条命令重复执行时，最近的回显最靠下。
    // 整行就等于输入原文的通常是命令打印出来的同一段文本（`echo done` 的输出 `done`、
    // 脚本自己打出的名字），遮掉它会让 wait 永远等不到，所以只在没有别的候选时才用
    let index = -1
    for (let cursor = normalized.length - 1; cursor >= 0; cursor -= 1) {
      const line = normalized[cursor]
      if (line && line !== needle && line.includes(needle)) {
        index = cursor
        break
      }
    }
    if (index < 0) {
      // 没有带提示符的命中，只剩整行等于输入原文的行：兜底遮最后一处
      for (let cursor = normalized.length - 1; cursor >= 0; cursor -= 1) {
        if (normalized[cursor] === needle) {
          maskedLines.add(cursor)
          break
        }
      }
      continue
    }
    maskedLines.add(index)
    // 输入被打断成多行回显时，回显上方还会留下几行与输入原文完全相同的碎片，一并遮掉；
    // 回显下方的整行命中是命令自己打印的输出，保留
    for (let cursor = 0; cursor < index; cursor += 1) {
      if (normalized[cursor] === needle) maskedLines.add(cursor)
    }
  }
  if (maskedLines.size === 0) return { text: source, masked: 0 }
  return {
    text: lines.filter((_, index) => !maskedLines.has(index)).join('\n'),
    masked: maskedLines.size
  }
}

/**
 * 读 headless 镜像的屏幕。返回的是「真实终端此刻显示的内容」：已经过 ANSI 解析，
 * 光标位置、清屏、TUI 重绘都按终端语义落定，AI 不会看到一堆转义字符。
 *
 * - `lines` 从 `startLine` 开始，最多 `maxLines` 行（默认 200，含滚动历史）；
 * - `cursor` 是 buffer 坐标，`inputLine` 是光标左侧的当前输入行；
 * - 尾部空行会去掉，但保留光标所在行，方便判断「命令还在输入」。
 */
export function readScreen(term, { maxLines = TERMINAL_DEFAULT_SCREEN_LINES } = {}) {
  const buffer = term.buffer.active
  const cursorAbsoluteY = buffer.baseY + buffer.cursorY
  // 终点不能只看光标：程序把光标停在屏幕上方而内容在下方时（清屏后重绘、进度条覆盖、
  // `\033[HA` 之类），以光标为终点会把下半屏整块裁掉，AI 以为命令没有输出
  let lastUsed = cursorAbsoluteY
  for (let y = buffer.baseY + buffer.cursorY + 1; y < buffer.baseY + buffer.length; y += 1) {
    const line = buffer.getLine(y)
    if (line && line.translateToString(true) !== '') lastUsed = y
  }
  const usedLines = Math.max(1, lastUsed + 1)
  const startLine = Math.max(0, usedLines - normalizeMaxLines(maxLines))
  const lines = []
  for (let y = startLine; y < usedLines; y += 1) lines.push(lineText(buffer.getLine(y)))
  // 去掉尾部空行，但保留光标所在行：命令还没回车时最后一行是空的也算「还在输入」
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') {
    if (startLine + lines.length - 1 === cursorAbsoluteY) break
    lines.pop()
  }
  const cursorLine = buffer.getLine(cursorAbsoluteY)
  return {
    text: lines.join('\n'),
    lines,
    startLine,
    totalLines: usedLines,
    cols: term.cols,
    rows: term.rows,
    cursor: { x: buffer.cursorX, y: buffer.cursorY, absoluteY: cursorAbsoluteY },
    inputLine: cursorLine ? cursorLine.translateToString(true, 0, buffer.cursorX) : '',
    scrollback: buffer.baseY
  }
}

/** 屏幕文本（不含坐标信息），给 `format=text` 用 */
export function screenText(term, options) {
  return readScreen(term, options).text
}

/* ----------------------------------------------------------------- 输出缓冲 */

/**
 * 追加输出并维护 `seq`（累计字符数）。只保留最近 `limit` 个字符：
 * 断线客户端按 `since` 续传，落在窗口外就用 `truncated` 告诉它重建屏幕。
 */
export function appendOutput(state, data, limit = TERMINAL_OUTPUT_BUFFER) {
  const text = String(data ?? '')
  if (!text) return state
  const next = {
    seq: state.seq + text.length,
    data: state.data + text,
    truncated: Boolean(state.truncated)
  }
  if (next.data.length > limit) {
    next.data = next.data.slice(next.data.length - limit)
    next.truncated = true
  }
  return next
}

/** 从 `since` 开始取缓冲；`since` 超出窗口时只能给整段并标 truncated */
export function outputSince(state, since = 0) {
  const start = Math.max(0, Number(since) || 0)
  if (start >= state.seq) return { seq: state.seq, data: '', truncated: Boolean(state.truncated) }
  const bufferStart = state.seq - state.data.length
  const truncated = Boolean(state.truncated) && start < bufferStart
  const offset = Math.max(0, start - bufferStart)
  return { seq: state.seq, data: state.data.slice(offset), truncated }
}
