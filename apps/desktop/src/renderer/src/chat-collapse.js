/**
 * 主对话里长消息（用户贴的长文本、模型生成的压缩摘要）的折叠规则。
 *
 * 只做纯计算：DOM 侧把 `scrollHeight` / computed `lineHeight` 传进来，
 * 判定与行数都从这里出，组件不各写一套阈值。
 */
export const CHAT_COLLAPSE_LINES = 10

const IMAGE_REFERENCE = /\[Image\]\([^)]*\)/i

/**
 * 含图片引用的消息不折叠：折叠是按行高裁高度，缩略图会被裁掉一半，
 * 而图片本来也不是「文字太长」的问题。
 */
export function canCollapseMessage(text) {
  return !IMAGE_REFERENCE.test(String(text ?? ''))
}

/**
 * `scrollHeight` 是完整内容高度（折叠状态下仍然可读），`lineHeight` 取 computed
 * 值；computed 为 `normal` 时由调用方按 `fontSize * 1.28` 兜底，与 CSS 里的
 * `--chat-message-line-height` 保持一致。
 */
export function measureChatCollapse({ scrollHeight, lineHeight, lines = CHAT_COLLAPSE_LINES }) {
  const height = Number(lineHeight)
  const limit = Number.isFinite(lines) && lines > 0 ? lines : CHAT_COLLAPSE_LINES
  if (!Number.isFinite(height) || height <= 0) return { collapsible: false, totalLines: 0 }
  const totalLines = Math.ceil(Math.max(0, scrollHeight) / height)
  return { collapsible: scrollHeight > height * limit + 1, totalLines }
}
