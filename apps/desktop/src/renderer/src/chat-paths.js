// 聊天文本 / 回合日志里的路径识别与「快速打开」链路。纯函数，不碰 DOM。
//
// 与终端链接（terminal-links.js）同源但要面对散文：终端只对鼠标悬停的那一行做
// 判定，聊天里整篇文本都会过一遍，所以相对路径的判定更保守（见 looksLikePath），
// 宁可漏掉 `docs/readme` 也不要把 `and/or`、`TCP/IP` 变成可点元素。
//
// 识别不做存在性探测：判定纯靠文本，点击后由 host 返回结果（见 PathToken）。
// 这样每一条消息的渲染都不需要额外问一次文件系统。

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'avif',
  'ico',
  'heic',
  'tiff'
])

// 起始边界：行首、空白、开括号引号，以及中英文标点。没有这条约束会从词中间切出
// 路径（`and/or` 里切出 `/or`、`https://x/y` 里切出 `//x/y`）。
const BOUNDARY = `(?<=^|[\\s([{'"\`<,;，；、（）【】「」『』])`
// 路径体里不可能出现的字符：引号、重定向与通配符、括号，以及中英文句读。
// 句读必须排除，否则 `/a/b，然后` 会被整段吃成一条路径（尾部裁剪救不了夹在中间的）。
const PATH_BODY_STOP = `\\s'"\`<>|*?,;()\\[\\]{}，。、；：！？（）【】「」『』…—～`
// 锚定路径：绝对路径、家目录、显式相对路径、Windows 盘符
const ANCHORED = `(?:[A-Za-z]:[\\\\/]|~[\\\\/]|\\.{1,2}[\\\\/]|/)[^${PATH_BODY_STOP}\\n]+`
// 相对路径：至少一个分隔符，是否采纳交给 looksLikePath
const RELATIVE = `(?:[\\w@+.-]+[\\\\/])+[\\w@+.-]+`
const PATH_PATTERN = new RegExp(
  `${BOUNDARY}(${ANCHORED}|${RELATIVE})(?::(\\d+))?(?::(\\d+))?`,
  'g'
)

// 路径尾部的标点：句读、右括号、引号、表格分隔符等都不属于路径本身
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"`。，、；：！？）】」』》…]+$/
// 绝对路径判定（与 looksLikePath 的锚定分支保持一致）
const ANCHORED_PATH = /^(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/)/

export function isImagePath(value) {
  const path = String(value || '')
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(path)
  return Boolean(match && IMAGE_EXTENSIONS.has(match[1].toLowerCase()))
}

/**
 * 这个片段像不像一个真实路径。
 * 锚定写法（`/a`、`~/a`、`./a`、`C:\a`）一律采纳；相对写法要求「≥2 层目录」或
 * 「尾段带扩展名」，把 `and/or`、`TCP/IP` 这类斜杠词排除在外。
 */
export function looksLikePath(value) {
  const path = String(value || '').replace(/[\\/]+$/, '')
  if (!path) return false
  if (ANCHORED_PATH.test(path)) return true
  const segments = path.split(/[\\/]/).filter(Boolean)
  if (segments.length < 2) return false
  if (segments.length >= 3) return true
  return /\.[A-Za-z0-9]{1,8}$/.test(segments[segments.length - 1])
}

/** 从尾部剥掉 `:line:col` / `(line,col)` 定位后缀，返回 { path, line, column }。 */
export function splitLocation(value) {
  const raw = String(value || '')
  const paren = /\((\d+)(?:,(\d+))?\)$/.exec(raw)
  if (paren) {
    return {
      path: raw.slice(0, paren.index),
      line: Number(paren[1]),
      column: paren[2] ? Number(paren[2]) : null
    }
  }
  const colon = /:(\d+)(?::(\d+))?$/.exec(raw)
  if (colon) {
    return {
      path: raw.slice(0, colon.index),
      line: Number(colon[1]),
      column: colon[2] ? Number(colon[2]) : null
    }
  }
  return { path: raw, line: null, column: null }
}

/**
 * 在文本里找出所有路径候选，按出现顺序返回 `{ path, line, column, text, start, end }`。
 * `text` 是原样渲染的字符串（含定位后缀），`path` 是剥掉定位后的路径。
 */
export function findPathCandidates(text) {
  const source = String(text || '')
  if (!source) return []
  const results = []
  const pattern = new RegExp(PATH_PATTERN.source, 'g')
  let match
  while ((match = pattern.exec(source))) {
    const start = match.index
    const trimmed = match[1].replace(TRAILING_PUNCTUATION, '')
    if (!trimmed) continue
    // URL 的 `//host/path` 会被锚定分支吃成一条路径，这里挡掉
    if (trimmed.startsWith('//')) continue
    // 锚定分支把 `:line` 吃进了路径体，相对分支则留给正则的定位分组
    const location = splitLocation(trimmed)
    const path = location.path
    const line = location.line ?? (match[2] ? Number(match[2]) : null)
    const column = location.column ?? (match[3] ? Number(match[3]) : null)
    if (!looksLikePath(path)) continue
    const text = line == null ? trimmed : `${path}:${line}${column == null ? '' : `:${column}`}`
    results.push({
      path,
      line,
      column,
      text,
      start,
      end: start + text.length
    })
  }
  return results
}

/**
 * 把纯文本切成 `{ type: 'text' }` / `{ type: 'path' }` 片段，供渲染层插入可点元素。
 */
export function splitTextByPaths(text) {
  const source = String(text || '')
  const candidates = findPathCandidates(source)
  if (!candidates.length) return source ? [{ type: 'text', text: source }] : []
  const segments = []
  let cursor = 0
  for (const candidate of candidates) {
    if (candidate.start > cursor) {
      segments.push({ type: 'text', text: source.slice(cursor, candidate.start) })
    }
    segments.push({ type: 'path', ...candidate })
    cursor = candidate.end
  }
  if (cursor < source.length) segments.push({ type: 'text', text: source.slice(cursor) })
  return segments
}

// --- Markdown 接入 ---------------------------------------------------------
//
// 用 remark 插件把文本节点里的路径换成链接节点，再由 Markdown 的 `a` 组件渲染成
// PathToken。链接的 url 用 `#mica-path=` 前缀承载原始信息（`#` 不会撞上 react-markdown
// 的 url 清洗），`a` 组件在渲染前把它拦下来，DOM 里不会留下这个 href。

const PATH_HREF_PREFIX = '#mica-path='

export function pathHref({ path, line = null, column = null }) {
  return `${PATH_HREF_PREFIX}${encodeURIComponent(JSON.stringify({ path, line, column }))}`
}

export function parsePathHref(href) {
  if (typeof href !== 'string' || !href.startsWith(PATH_HREF_PREFIX)) return null
  try {
    const value = JSON.parse(decodeURIComponent(href.slice(PATH_HREF_PREFIX.length)))
    if (!value || typeof value.path !== 'string' || !value.path) return null
    return { path: value.path, line: value.line ?? null, column: value.column ?? null }
  } catch {
    return null
  }
}

function linkifyTextNode(node) {
  const segments = splitTextByPaths(node.value)
  if (!segments.some((segment) => segment.type === 'path')) return [node]
  return segments.map((segment) =>
    segment.type === 'path'
      ? {
          type: 'link',
          url: pathHref(segment),
          children: [{ type: 'text', value: segment.text }]
        }
      : { type: 'text', value: segment.text }
  )
}

const SKIPPED_NODE_TYPES = new Set(['code', 'inlineCode', 'html', 'link', 'linkReference'])

function walkAndLinkify(node) {
  if (!node || !Array.isArray(node.children)) return
  const next = []
  let changed = false
  for (const child of node.children) {
    if (child?.type === 'text' && typeof child.value === 'string') {
      const replacement = linkifyTextNode(child)
      if (replacement.length !== 1 || replacement[0] !== child) changed = true
      next.push(...replacement)
      continue
    }
    // 链接内部、代码块与原始 HTML 里的路径保持原样：前者已经是链接，后者是代码。
    if (!SKIPPED_NODE_TYPES.has(child?.type)) walkAndLinkify(child)
    next.push(child)
  }
  if (changed) node.children = next
}

/** remark 插件：把普通文本里的路径变成 `#mica-path=` 链接节点。 */
export function remarkPathLinks() {
  return (tree) => {
    walkAndLinkify(tree)
  }
}
