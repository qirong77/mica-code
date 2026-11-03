/**
 * 行悬停（GitLens 那种「这一行是谁改的」）的纯逻辑：请求参数、时间格式、悬停内容、
 * 缓存/去重。不 import monaco，也不直接调 `window.mica`——注入进来以便单测。
 */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** blame 侧的说明 → `git:blame` 的请求参数（null 表示这一侧没有可 blame 的内容）。 */
export function blameRequest(blame, line) {
  if (!blame || blame.kind === 'none') return null
  if (blame.kind === 'index') return { index: true, line }
  if (blame.kind === 'commit') {
    if (!blame.ref) return null
    return { ref: blame.ref, line }
  }
  return { line }
}

/** 相对时间用中文（与分支面板一致），超过一周给日期本身。 */
export function relativeTime(time, now = Date.now()) {
  const value = Number(time) || 0
  if (!value) return ''
  const diff = Math.max(0, now - value)
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`
  if (diff < 30 * DAY) return `${Math.floor(diff / (7 * DAY))} 周前`
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))} 个月前`
  return `${Math.floor(diff / (365 * DAY))} 年前`
}

/** 本地时间 `2024-05-06 15:04`；时区不在这里换算，用运行机器的本地时区。 */
export function absoluteTime(time) {
  const value = Number(time) || 0
  if (!value) return ''
  const date = new Date(value)
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 只转义真会破坏行内格式的几个字符；把 `-` `.` 也转义会让提交说明里满是反斜杠。
function escapeMarkdown(text) {
  return String(text || '').replace(/[\\`*_[\]<>]/g, (match) => `\\${match}`)
}

function inlineCode(text) {
  return `\`${String(text || '')
    .replace(/`/g, '\u0060\u200b')
    .replace(/\n/g, ' ')}\``
}

/**
 * 悬停内容（Monaco MarkdownString）。
 *
 * 一眼要能回答三个问题：谁、什么时候、哪个提交。所以第一行是作者 + 时间，第二行是
 * 短哈希 + 提交说明，最后一行是这一行在文件里的位置（以及是 diff 的哪一侧）。
 */
export function buildBlameHover(entry, { path = '', sourceLabel = '' } = {}) {
  if (!entry || entry.error) return null
  const when = [absoluteTime(entry.time), relativeTime(entry.time)].filter(Boolean).join(' · ')
  const lines = []
  if (entry.uncommitted) {
    lines.push(`**未提交的更改**${when ? ` · ${when}` : ''}`)
    if (entry.previous?.hash) lines.push(`上一版：\`${entry.previous.hash.slice(0, 8)}\``)
  } else {
    const author = escapeMarkdown(entry.author || '未知作者')
    lines.push(`**${author}**${when ? ` · ${when}` : ''}`)
    const subject = escapeMarkdown(entry.summary || '（没有提交说明）')
    lines.push(`${inlineCode(entry.shortHash || entry.hash?.slice(0, 8) || '')} ${subject}`)
  }
  const detail = [
    inlineCode(path || entry.filename || ''),
    `第 ${entry.line} 行`,
    sourceLabel ? escapeMarkdown(sourceLabel) : ''
  ]
    .filter(Boolean)
    .join(' · ')
  if (detail) lines.push(`---\n${detail}`)
  return lines.join('\n\n')
}

/** 缓存键：同一行在同一份内容里只查一次。 */
export function blameKey(meta, line) {
  return [
    meta?.cwd || '',
    meta?.path || '',
    meta?.blame?.kind || 'none',
    meta?.blame?.ref || '',
    line
  ].join('\u0000')
}

/**
 * 只有完整提交哈希可缓存；工作区、索引和符号 ref 随时可能变化。
 * 提交缓存命中上限后按插入顺序淘汰最早的条目。
 * `read(meta, options)` 由调用方注入（真实实现走 `window.mica.git.blame`）。
 */
export function createBlameResolver(read, { max = 400, sourceLabel } = {}) {
  const cache = new Map()
  const pending = new Map()
  let generation = 0
  const remember = (key, value) => {
    if (cache.size >= max) cache.delete(cache.keys().next().value)
    cache.set(key, value)
    return value
  }
  return {
    async lookup(meta, line) {
      const options = blameRequest(meta?.blame, line)
      if (!meta?.cwd || !meta?.path || !options) return null
      const immutable =
        meta.blame.kind === 'commit' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(meta.blame.ref)
      const key = blameKey(meta, line)
      const render = (entry) =>
        buildBlameHover(entry, {
          path: meta.path,
          sourceLabel: sourceLabel || meta.sourceLabel || ''
        })
      if (immutable && cache.has(key)) return render(cache.get(key))
      if (immutable && pending.has(key)) return render(await pending.get(key))
      const requestGeneration = generation
      const promise = Promise.resolve()
        .then(() => read(meta, options))
        .then((entry) => {
          if (immutable && entry && !entry.error && generation === requestGeneration)
            remember(key, entry)
          return entry
        })
        .catch(() => null)
        .finally(() => {
          if (pending.get(key) === promise) pending.delete(key)
        })
      if (immutable) pending.set(key, promise)
      return render(await promise)
    },
    clear() {
      generation += 1
      cache.clear()
      pending.clear()
    }
  }
}
