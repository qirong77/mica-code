/**
 * 停靠区里「轮次」的排布规则。
 *
 * 模型的思考是按段推送的：每调一次工具就断一次。一段一行会把同一轮的想法拆成一叠
 * 碎块，所以同一轮的思考合并成**一个块**（`mergeTurnThinking`），持续追加。
 *
 * 轮次之间的关系也一样：停靠区原来只显示正在跑的那一轮，跑完就整块清空，模型想过
 * 什么全不见了。所以按轮次分组（`groupActivityRounds`），历史轮次在停靠区里各收成
 * 一行，最新一轮摊开——一轮跑完不会消失，也不会被下一轮的思考顶掉。
 */

const ROUND_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

export function isActivityMessage(message) {
  return message?.kind === 'reasoning' || message?.kind === 'tool'
}

/** 活动行归属的轮次键：拿不到 `step_start`（重放缓冲被挤掉）时是空串，单独成块。 */
export function turnActivityKey(message) {
  return message?.turnId || ''
}

/** 停靠区最多留几轮（含最新一轮）：再往前的轮次已经翻过去了，留着只是把列表拉长。 */
export const MAX_TURN_LOG_ROUNDS = 6

/**
 * 同一轮里**相邻**的思考合成一块，其余顺序原样保留：模型每调一次工具，思考就断成
 * 一段，段与段之间夹着工具行。跨工具行去合并会把后面所有思考都提到最前面，工具行
 * 全被挤到末尾——那不是原来的排版。相邻段之间没有别的行，合起来才只是「一段很长
 * 的思考」，顺序一点没动。
 *
 * 合并后的文本取各段的**当前**内容，所以正在流式增长的那一段每帧都在里面，块只会
 * 往后长，不会跳。
 */
export function mergeTurnThinking(messages) {
  const rows = Array.isArray(messages) ? messages : []
  const merged = []
  // 上一个输出行还是思考、且属于同一轮，就并进去；中间夹过任何别的行都重新起一块。
  let open = null
  for (const message of rows) {
    if (message?.kind !== 'reasoning') {
      open = null
      merged.push({ message })
      continue
    }
    const text = String(message.text ?? '').trim()
    if (open && open.key === turnActivityKey(message)) {
      if (text) open.message.text = open.message.text ? `${open.message.text}\n\n${text}` : text
      continue
    }
    open = { key: turnActivityKey(message), message: { ...message, text } }
    merged.push(open)
  }
  return merged.map((entry) => entry.message)
}

/**
 * 按轮次把活动行分组，保持出现顺序。最后一组就是「最新一轮」，停靠区把它摊开，
 * 其余各收成一行。
 *
 * 只保留最后 `limit` 轮：单轮的思考与工具行本来就多，整场会话全挂在停靠区里会让
 * 这块日志越来越长、越滚越深。
 */
export function groupActivityRounds(messages, { limit = MAX_TURN_LOG_ROUNDS } = {}) {
  const rounds = []
  let current = null
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isActivityMessage(message)) continue
    const key = turnActivityKey(message)
    if (!current || current.key !== key) {
      current = { key, messages: [] }
      rounds.push(current)
    }
    current.messages.push(message)
  }
  const kept = limit > 0 && rounds.length > limit ? rounds.slice(-limit) : rounds
  return kept.map((round, index) => ({ ...round, label: roundLabel(index + 1) }))
}

/** 「轮次一」这样的位置名：位置在停靠区里，不在整场会话里。 */
export function roundLabel(index) {
  const numeral = ROUND_NUMERALS[index - 1]
  return `轮次${numeral ?? index}`
}

/**
 * 这一轮活动行的收尾时刻：最后一条已完成的行的时间。
 *
 * 历史轮次拿它当「现在」算耗时——再用 `Date.now()` 算，会把那一轮的耗时报成
 * 「到现在为止」，越看越离谱。
 */
export function turnActivitySettledAt(messages) {
  let settled = null
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isActivityMessage(message)) continue
    const candidates =
      message.kind === 'tool'
        ? [message.tool?.finishedAt, message.tool?.updatedAt]
        : [message.updatedAt]
    for (const value of candidates) {
      if (Number.isFinite(value) && (settled == null || value > settled)) settled = value
    }
  }
  return settled
}

/**
 * 停靠区右上角那个开关的文案：这一轮在停靠区里的位置。
 *
 * 位置只在停靠区里成立（只留最近 `MAX_TURN_LOG_ROUNDS` 轮），所以与 `roundLabel`
 * 用同一套数字，不假装是整场会话的第几轮。停靠区在回合结束后仍留着上一轮，
 * 那时候说「正在进行」就是假的，所以按运行状态换说法。
 */
export function roundSwitchLabel(index, running) {
  const numeral = ROUND_NUMERALS[index - 1] ?? index
  return running ? `正在进行第${numeral}轮思考` : `共${numeral}轮思考`
}
