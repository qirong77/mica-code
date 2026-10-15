/**
 * 「引用对话」的唯一实现：把一条已存在的消息引用到输入框里。
 *
 * 引用就是一段**普通 prompt 文本**（没有结构化字段、不改会话格式、不改协议），
 * 所以发送、排队、持久化、分享页面都不需要为它做任何特殊处理。这里放着这份约定
 * 的全部逻辑——格式化、解析、插入草稿、移除，以及标题派生时剥离前导引用块——
 * CLI（会话标题/会话列表）与桌面端（输入框、对话流）共用同一份，
 * 不要在任何一侧另写一套。
 */

export type QuoteRole = 'user' | 'assistant'

export interface QuoteBlock {
  /** 整块（标签行 + 围栏 + 正文 + 围栏）在文本里的起止偏移，`end` 不含行尾换行。 */
  start: number
  end: number
  /** 标签里的署名：`我` / `模型`；认不出的自定义署名保留原文，`role` 为 null。 */
  label: string
  role: QuoteRole | null
  /** 围栏内的正文。 */
  text: string
}

export type QuoteSegment =
  | { type: 'text'; text: string }
  | { type: 'quote'; role: QuoteRole | null; label: string; text: string }

const LABEL_PREFIX = '引用对话（'
const LABEL_SUFFIX = '）：'
const ROLE_LABELS: Record<QuoteRole, string> = { user: '我', assistant: '模型' }
// 署名限长且不许换行：`引用对话（...）：` 必须是独立的一整行才算引用标签。
const LABEL_LINE = /^引用对话（([^）\n]{0,20})）：$/
const FENCE_LINE = /^(`{3,})[ \t]*$/

/** 引用正文里的图片引用：`[Image](路径)` / `![alt](路径)`。 */
const IMAGE_REFERENCE = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

function splitLines(source: string): Array<{ text: string; start: number; end: number }> {
  const lines: Array<{ text: string; start: number; end: number }> = []
  let start = 0
  while (start <= source.length) {
    const next = source.indexOf('\n', start)
    const end = next < 0 ? source.length : next
    lines.push({ text: source.slice(start, end), start, end })
    if (next < 0) break
    start = next + 1
  }
  return lines
}

function roleFromLabel(label: string): QuoteRole | null {
  if (label === ROLE_LABELS.user) return 'user'
  if (label === ROLE_LABELS.assistant) return 'assistant'
  return null
}

/** 正文里含反引号时围栏必须比它更长，否则引用一段 markdown 会把后面的正文撕开。 */
export function quoteFence(body: string): string {
  const runs = String(body ?? '').match(/`+/g) ?? []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * 引用正文里本来就有的图片引用降级成 `[图片]`：那张图本来就在模型上下文里，
 * 而 `[Image](路径)` 在发送时会被解析成图片块重新上传，引用一次等于白花一次图片
 * token。带 `!` 的 markdown 图片语法同样降级，普通链接原样保留。
 */
function quoteBodyText(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(IMAGE_REFERENCE, (match, alt: string, source: string) =>
      match.startsWith('!') || alt === 'Image' ? '[图片]' : match
    )
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '')
}

/** 生成引用块的文本（不含前后分隔空行，由 `insertQuoteBlock` 负责）。 */
export function formatQuoteBlock({
  role,
  text,
  label,
}: {
  role: QuoteRole | null
  text: string
  label?: string
}): string {
  const name = label || (role ? ROLE_LABELS[role] : '') || '对话'
  const body = quoteBodyText(text)
  const fence = quoteFence(body)
  return `${LABEL_PREFIX}${name}${LABEL_SUFFIX}\n${fence}\n${body}\n${fence}`
}

/** 找出文本里所有引用块（按出现顺序）。文本里没有 `引用对话（` 时直接返回空数组。 */
export function findQuoteBlocks(text: string): QuoteBlock[] {
  const source = String(text ?? '')
  if (!source.includes(LABEL_PREFIX)) return []
  const lines = splitLines(source)
  const blocks: QuoteBlock[] = []
  for (let index = 0; index < lines.length; index++) {
    const label = LABEL_LINE.exec(lines[index]!.text)
    if (!label) continue
    const opener = FENCE_LINE.exec(lines[index + 1]?.text ?? '')
    if (!opener) continue
    const fence = opener[1]!
    for (let cursor = index + 2; cursor < lines.length; cursor++) {
      const closer = FENCE_LINE.exec(lines[cursor]!.text)
      if (!closer || closer[1]!.length < fence.length) continue
      blocks.push({
        start: lines[index]!.start,
        end: lines[cursor]!.end,
        label: label[1]!,
        role: roleFromLabel(label[1]!),
        text: source.slice(lines[index + 2]!.start, lines[cursor]!.start).replace(/\n$/, ''),
      })
      index = cursor
      break
    }
  }
  return blocks
}

export function hasQuoteBlock(text: string): boolean {
  return findQuoteBlocks(text).length > 0
}

/** 把文本切成「普通文本 / 引用块」两种片段，供对话流渲染。 */
export function splitQuoteSegments(text: string): QuoteSegment[] {
  const source = String(text ?? '')
  const blocks = findQuoteBlocks(source)
  if (!blocks.length) return [{ type: 'text', text: source }]
  const segments: QuoteSegment[] = []
  let cursor = 0
  for (const block of blocks) {
    if (block.start > cursor) segments.push({ type: 'text', text: source.slice(cursor, block.start) })
    segments.push({ type: 'quote', role: block.role, label: block.label, text: block.text })
    cursor = block.end
  }
  if (cursor < source.length) segments.push({ type: 'text', text: source.slice(cursor) })
  return segments
}

/**
 * 把引用块插进草稿：块必须独立成段（光标在行中间时前后补空行，已经在一行的开头
 * 就不重复补），光标落在块后的空行上让用户直接接着写。以 textarea 的当前值与
 * 光标位置为准，插完由调用方回填草稿。
 */
export function insertQuoteBlock(
  draft: string,
  caret: number,
  block: string
): { text: string; caret: number } {
  const source = String(draft ?? '')
  const at = Math.min(Math.max(Number.isFinite(caret) ? caret : source.length, 0), source.length)
  const head = source.slice(0, at)
  const tail = source.slice(at)
  const prefix = head === '' || head.endsWith('\n') ? '' : '\n\n'
  // 块与后面的内容之间固定留一个空行；tail 自己已经带了空行就不重复补。
  const suffix = tail.startsWith('\n\n') ? '' : tail.startsWith('\n') ? '\n' : '\n\n'
  const inserted = `${prefix}${block}${suffix}`
  return {
    text: `${head}${inserted}${tail}`,
    // 光标落在块后面的空行之后：无论空行是补出来的还是 tail 自带的，都正好
    // 跳过两个换行（`\n\n`），用户接着写就是在块下方另起一段。
    caret: at + prefix.length + block.length + 2,
  }
}

/**
 * 删掉一个引用块（输入框引用条上的 ✕）。只动这一个块与它自己的分隔换行，
 * 不碰用户写的正文；块在文本开头时顺带收敛掉留下的前导空行。
 */
export function removeQuoteBlock(text: string, block: QuoteBlock): string {
  const source = String(text ?? '')
  const current = findQuoteBlocks(source).find((item) => item.start === block.start && item.end === block.end)
  if (!current) return source
  let start = current.start
  let end = current.end
  const trailing = end >= source.length
  // 块是靠换行独立成行的：先吃掉它前面那个行尾换行
  if (start > 0 && source[start - 1] === '\n') start -= 1
  if (trailing) {
    // 尾部块：连同它留下的前导空行一起收敛，别让草稿以空行结尾
    while (start > 0 && source[start - 1] === '\n') start -= 1
  } else if (source[end] === '\n') {
    end += 1
  }
  if (start === 0) {
    // 开头块：收敛掉留下的前导空行
    while (end < source.length && source[end] === '\n') end += 1
  }
  return source.slice(0, start) + source.slice(end)
}

/**
 * 标题派生用：去掉开头连续的引用块，剩下的才是用户真正写的话。整条消息只有引用
 * （引用完直接发送）时退回引用内容的首行，避免标题变成一串围栏。
 */
export function quoteTitleText(text: string): string {
  const source = String(text ?? '')
  let rest = source
  for (;;) {
    // 块之间的空行不算内容：跳过前导空白后再看开头是不是引用块
    const body = rest.replace(/^\s+/, '')
    const block = findQuoteBlocks(body)[0]
    if (!block || block.start !== 0) break
    rest = body.slice(block.end)
  }
  const stripped = rest.replace(/\s+/g, ' ').trim()
  if (stripped) return stripped
  const block = findQuoteBlocks(source)[0]
  if (!block) return source.replace(/\s+/g, ' ').trim()
  const body = block.text.replace(/\s+/g, ' ').trim()
  return body ? `引用（${block.label}）：${body}` : '引用对话'
}
