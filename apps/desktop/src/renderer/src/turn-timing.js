/**
 * 桌面端把 Codex 事件翻译成 `mica-common/turnTiming` 的最小事件。
 *
 * 区间切分、聚合与落盘形态都在 `mica-common` 里：进程侧（`AgentRuntime` 每轮跑完
 * 把记录写进会话快照）与这里（桌面端实时那一轮）必须算出同一份结果，否则弹窗与
 * 会话详情里的百分比会在某次改动之后悄悄对不上。
 */
import {
  applyTurnTimingTick,
  createTurnTimingState,
  groupPercents,
  summarizeTurnTiming
} from '@packages/mica-common/turnTiming.js'

export { createTurnTimingState, groupPercents, summarizeTurnTiming }

function turnOutcome(reason) {
  if (reason === 'aborted') return 'aborted'
  if (reason === 'error') return 'error'
  return 'completed'
}

export function applyTurnTimingEvent(state, event) {
  if (!event || typeof event.type !== 'string') return state
  const raw = Number(event.timestamp)
  const at = Number.isFinite(raw) && raw > 0 ? raw : Date.now()

  if (event.type === 'step_start') return applyTurnTimingTick(state, { type: 'turn-start', at })
  if (!state || !state.startedAt) return state

  if (event.type === 'text' || event.type === 'reasoning') {
    const text = typeof event.part?.text === 'string' ? event.part.text : ''
    return applyTurnTimingTick(state, { type: 'output', at, chars: text.length })
  }

  if (event.type === 'tool_use') {
    const part = event.part
    if (!part?.tool) return state
    const callID = part.callID || ''
    const status = part.state?.status || 'completed'
    if (status === 'pending' || status === 'running') {
      return applyTurnTimingTick(state, {
        type: 'tool-start',
        at,
        tool: part.tool,
        callID,
        displayText: part.displayText || ''
      })
    }
    return applyTurnTimingTick(state, { type: 'tool-end', at, callID, status: 'completed' })
  }

  if (event.type === 'step_finish') {
    return applyTurnTimingTick(state, {
      type: 'turn-end',
      at,
      outcome: turnOutcome(event.part?.reason)
    })
  }

  return state
}
