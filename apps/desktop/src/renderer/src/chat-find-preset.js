/**
 * 侧栏会话搜索 → 主对话区查找条的初始条件。
 *
 * 侧栏搜索按空格分词、词与词之间是 AND 语义（`tokenizeSearchQuery`），而查找条一次只有
 * 一个条件，所以多个词串成「任一命中」的正则：逐词转义后 `|` 起来。串成字面量会一个都
 * 搜不到（AND 的两段原文通常不在同一句话里），转义少了则 `a.b` 会把 `axb` 也点亮。
 *
 * 纯逻辑放这里，构造规则才能被单测锁住；DOM 扫描 / 高亮在 ChatFind.jsx。
 */

import { escapeFindText } from './chat-find.js'

/** 把侧栏搜索的词拼成查找条的初始查询；没有可用的词就不该打开查找条（返回 null）。 */
export function findPresetForSearch(tokens) {
  const words = (Array.isArray(tokens) ? tokens : [])
    .map((token) => String(token ?? '').trim())
    .filter(Boolean)
  if (words.length === 0) return null
  if (words.length === 1) return { query: words[0], regex: false }
  return { query: words.map(escapeFindText).join('|'), regex: true }
}
