/**
 * 回合日志里「思考」的合并规则。
 *
 * 同一个想法常被模型分成好几段流式吐出来，日志里就成了好几个 reasoning 项。分块显示
 * 时它们各带一块淡色底、彼此隔开，读起来像几段互不相干的引用，也看不出这是「模型的
 * 思考」还是回答的一部分。这里只在**相邻**的 reasoning 之间合并：中间隔着工具调用
 * 时必须断开，因为那是「想过 → 做了 → 又想了」，本来就是两段。
 */
export const THINKING_BODY_LINES = 4

/** 段落结束标点：前一段以此收尾才另起一段，否则直接接上（片段常在同一句话里被切开）。 */
const TERMINAL_PUNCTUATION = /[。！？；…」』）】:：.!?;]$/

export function joinThinkingText(left, right) {
  const head = String(left ?? '').trimEnd()
  const tail = String(right ?? '').trimStart()
  if (!head) return tail
  if (!tail) return head
  if (head.endsWith('\n')) return `${head}\n${tail}`
  return TERMINAL_PUNCTUATION.test(head) ? `${head}\n\n${tail}` : `${head}${tail}`
}

/**
 * 把回合日志的消息序列按「相邻 reasoning 合并」重排。
 *
 * 返回的新数组里，连续思考变成单个 `{ kind: 'thinking', text, startedAt, updatedAt, done }`；
 * 其余消息原样透传（引用不变，`TurnLogItem` 的 memo 仍然靠引用比较生效）。
 */
export function mergeThinkingRuns(items = []) {
  const merged = []
  for (const item of items) {
    if (item?.kind !== 'reasoning') {
      merged.push(item)
      continue
    }
    const previous = merged[merged.length - 1]
    if (previous?.kind === 'thinking') {
      merged[merged.length - 1] = {
        ...previous,
        text: joinThinkingText(previous.text, item.text),
        startedAt: previous.startedAt ?? item.startedAt,
        updatedAt: item.updatedAt ?? previous.updatedAt,
        done: Boolean(previous.done && item.done)
      }
      continue
    }
    merged.push({
      kind: 'thinking',
      id: item.id,
      turnId: item.turnId,
      text: String(item.text ?? ''),
      startedAt: item.startedAt,
      updatedAt: item.updatedAt ?? item.startedAt,
      done: Boolean(item.done)
    })
  }
  return merged
}

/** 这段思考已经想了多久：结束时用 `updatedAt`，还在想时用当前时刻。 */
export function thinkingElapsedMs(item, now = Date.now()) {
  const started = Number(item?.startedAt)
  if (!Number.isFinite(started) || started <= 0) return 0
  const ended = item?.done ? Number(item.updatedAt) : Number(now)
  const end = Number.isFinite(ended) && ended > 0 ? ended : now
  return Math.max(0, end - started)
}
