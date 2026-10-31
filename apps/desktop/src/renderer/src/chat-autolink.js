// GFM autolink 的两处修补（桌面端）。
//
// 1. 全角标点截断：micromark 的 autolink literal 只把 ASCII 标点当作可裁剪尾部，所以
//    模型写「已部署到 http://10.190.46.109:9200。」时那个全角句号会留在 href 里：下划线
//    盖住句号，点开的目标也多一个 %E3%80%82（CLI 的 marked 更宽，连标点后面的中文都会
//    吞进去）。判定在 `@packages/mica-common/autolink.js`（CLI 的 marked 渲染共用同一份），
//    这里把 mdast 里 `link` 节点在第一个全角标点处截断、剩下的作为纯文本排到链接后面。
//
// 2. 强调包着裸 URL：autolink literal 的地址一直吃到空白为止，把紧随其后的 `**` 和它
//    后面的中文一起吞进链接，于是那对强调分隔符永远配不上，页面上留下字面量 `**`
//    （`**http://127.0.0.1:8877**（在浏览器里打开即可）`）。分词阶段已经错了，mdast
//    上救不回来，只能在解析前把这种写法换成显式 autolink `<URL>`，让解析器在 `>` 收尾。
import { findAutolinks, splitAutolinkPunctuation } from '@packages/mica-common/autolink.js'

function splitLink(node) {
  if (!node || node.type !== 'link' || typeof node.url !== 'string') return null
  const children = Array.isArray(node.children) ? node.children : []
  if (children.length !== 1 || children[0]?.type !== 'text') return null
  const split = splitAutolinkPunctuation(node.url, children[0].value)
  if (!split) return null
  return [
    { ...node, url: split.url, children: [{ ...children[0], value: split.text }] },
    { type: 'text', value: split.trailing }
  ]
}

function walk(node) {
  if (!node || !Array.isArray(node.children)) return
  const next = []
  let changed = false
  for (const child of node.children) {
    const replacement = splitLink(child)
    if (replacement) {
      changed = true
      next.push(...replacement)
      continue
    }
    walk(child)
    next.push(child)
  }
  if (changed) node.children = next
}

/** remark 插件：在第一个全角标点处截断链接，剩下的留在链接外面。 */
export function remarkAutolinkPunctuation() {
  return (tree) => {
    walk(tree)
  }
}

// 强调分隔符包着的裸 URL：`**http://x**`、`*https://x*`、`__www.x.com__` …
// 捕获组 2 用惰性匹配，先撞到的那个同款分隔符就是收尾。
const EMPHASIS_AUTOLINK = /(\*\*|__|\*|_)((?:https?:\/\/|www\.)[^\s<>"'`]+?)\1/g

function rewriteSegment(segment) {
  return segment.replace(EMPHASIS_AUTOLINK, (whole, marker, candidate) => {
    const [hit] = findAutolinks(candidate)
    if (!hit || hit.start !== 0) return whole
    const tail = candidate.slice(hit.end)
    // 显式 autolink 只认带协议的地址；`www.` 用标准链接写法，显示文本仍是原文。
    const body = hit.text.startsWith('www.') ? `[${hit.text}](http://${hit.text})` : `<${hit.url}>`
    return `${marker}${body}${tail}${marker}`
  })
}

// 行内代码用反引号串括起，围栏代码用整行 ``` / ~~~ —— 里面的 `**URL**` 是代码，
// 换掉就等于改了用户看到的代码。
function rewriteOutsideInlineCode(line) {
  let out = ''
  let index = 0
  while (index < line.length) {
    const tick = line.indexOf('`', index)
    if (tick < 0) return out + rewriteSegment(line.slice(index))
    let size = 1
    while (line[tick + size] === '`') size += 1
    const fence = '`'.repeat(size)
    const close = line.indexOf(fence, tick + size)
    if (close < 0) return out + rewriteSegment(line.slice(index))
    out += rewriteSegment(line.slice(index, tick)) + line.slice(tick, close + size)
    index = close + size
  }
  return out
}

/**
 * 解析前把「强调包着裸 URL」的写法换成显式 autolink，避开 autolink literal 吞掉收尾的
 * 强调分隔符。代码块与行内代码原样保留。
 */
export function protectEmphasisAutolinks(text) {
  const source = String(text ?? '')
  if (!source.includes('*') && !source.includes('_')) return source
  let fence = null
  return source
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (fence) {
        if (marker && marker[1][0] === fence.character && marker[1].length >= fence.size) {
          fence = null
        }
        return line
      }
      if (marker) {
        fence = { character: marker[1][0], size: marker[1].length }
        return line
      }
      return rewriteOutsideInlineCode(line)
    })
    .join('\n')
}
