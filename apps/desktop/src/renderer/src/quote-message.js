import {
  findQuoteBlocks,
  formatQuoteBlock,
  insertQuoteBlock,
  removeQuoteBlock,
  splitQuoteSegments
} from '@packages/mica-common/chatQuote.js'

// 引用块的解析/移除/分段全部来自 packages/mica-common/chatQuote.js（CLI 与桌面端共用同一份
// 约定），这里只加桌面端那一层：把一条消息引用进输入框草稿。
export { findQuoteBlocks, removeQuoteBlock, splitQuoteSegments }

/**
 * 生成引用块的文本（对话流里点「引用」用的就是它，配套的解析在 chatQuote）。
 */
export function buildQuoteBlock({ role, text, label }) {
  return formatQuoteBlock({ role, text, label })
}

/**
 * 把一条消息引用进草稿，返回新草稿与光标位置。
 *
 * 同一条消息重复引用不重复插入：草稿里已经有同样的块就把光标移到它后面，
 * 否则连点两下会攒出两段一模一样的引用。
 *
 * `label` 覆盖署名（默认按 role 取「我」/「模型」）。By The Way 的回答用它标成
 * 「By The Way」——那段字**不在**主对话历史里，标成「模型」会让人以为是从对话里引的。
 */
export function quoteIntoDraft(draft, caret, { role, text, label }) {
  const source = String(draft ?? '')
  const block = formatQuoteBlock({ role, text, label })
  const at = source.indexOf(block)
  if (at >= 0) {
    return { text: source, caret: Math.min(at + block.length + 2, source.length) }
  }
  return insertQuoteBlock(source, caret, block)
}
