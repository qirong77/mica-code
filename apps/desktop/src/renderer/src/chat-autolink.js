// GFM autolink 的全角标点截断（remark 插件）。
//
// micromark 的 autolink literal 只把 ASCII 标点当作可裁剪尾部，所以模型写
// 「已部署到 http://10.190.46.109:9200。」时那个全角句号会留在 href 里：下划线
// 盖住句号，点开的目标也多一个 %E3%80%82（CLI 的 marked 更宽，连标点后面的中文
// 都会吞进去）。判定在
// `@packages/mica-common/autolink.js`（CLI 的 marked 渲染共用同一份），这里只负责
// 把 mdast 里 `link` 节点在第一个全角标点处截断、剩下的作为纯文本节点排到链接后面。
import { splitAutolinkPunctuation } from '@packages/mica-common/autolink.js'

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
