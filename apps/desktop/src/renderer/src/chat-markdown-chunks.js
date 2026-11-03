/**
 * 把流式正文切成「已定型的前缀 + 还在增长的尾部」。
 *
 * 流式输出时每一帧都把整篇 markdown 交给 react-markdown 重解析，代价是 O(全文)：
 * 一段两万字的回答生成过程中会被从头解析上千次，越到后面越卡。切块之后只有最后一块
 * 每帧重解析，前面的块按内容 memo，成本降到 O(尾部)。
 *
 * 切点只在空行之后，并且要满足「下一行确实开始了另一个顶层块」：
 * - 列表与引用跨空行仍然属于同一个块，不能切开（否则宽松列表会变成两个 `<ul>`）；
 * - 缩进行可能是列表项里的续行，保守地不切；
 * - 围栏代码块内部一律不切。
 *
 * 不变量：`splitMarkdownChunks(text).join('') === text`。切点保留行尾换行，
 * 因此把各块原样拼回去仍是同一份文本（复制、查找都不受影响）。
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:\s|$)/
const QUOTE = /^ {0,3}>/
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/
const TABLE_ROW = /^ {0,3}\|/
const INDENTED = /^(?: {4}|\t)/
const HTML_BLOCK = /^ {0,3}<[A-Za-z!/]/

function classify(line) {
  if (FENCE_OPEN.test(line)) return 'fence'
  if (LIST_ITEM.test(line)) return 'list'
  if (QUOTE.test(line)) return 'quote'
  if (HEADING.test(line)) return 'heading'
  if (TABLE_ROW.test(line)) return 'table'
  if (HTML_BLOCK.test(line)) return 'html'
  if (INDENTED.test(line)) return 'indented'
  return 'text'
}

/** 空行两侧是否仍属于同一个顶层块。 */
function continuesAcrossBlank(previous, next) {
  if (!previous) return true
  if (next === 'indented') return true
  if (previous === 'list' && next === 'list') return true
  if (previous === 'quote' && next === 'quote') return true
  return false
}

function closingFence(line, fence) {
  if (!fence) return null
  const match = line.match(FENCE_OPEN)
  if (!match) return fence
  const marker = match[1]
  if (marker[0] !== fence.marker || marker.length < fence.length) return fence
  // 闭合围栏后面允许有空白，其他内容仍然算在代码块里。
  if (line.trim() !== marker) return fence
  return null
}

export function splitMarkdownChunks(source) {
  const text = typeof source === 'string' ? source : ''
  if (!text) return ['']
  const lines = text.split('\n')
  const chunks = []
  let start = 0
  let fence = null
  let previous = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (fence) {
      fence = closingFence(line, fence)
      previous = 'fence'
      continue
    }
    if (line.trim() === '') {
      let lookahead = index + 1
      while (lookahead < lines.length && lines[lookahead].trim() === '') lookahead += 1
      if (lookahead < lines.length) {
        const next = classify(lines[lookahead])
        if (!continuesAcrossBlank(previous, next)) {
          chunks.push(`${lines.slice(start, index + 1).join('\n')}\n`)
          start = index + 1
          previous = null
        }
      }
      continue
    }
    const open = line.match(FENCE_OPEN)
    if (open) {
      fence = { marker: open[1][0], length: open[1].length }
      previous = 'fence'
      continue
    }
    previous = classify(line)
  }

  chunks.push(lines.slice(start).join('\n'))
  return chunks
}
