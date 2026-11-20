import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_TURN_LOG_OPEN,
  TURN_LOG_OPEN_STATE_KEY,
  toggleTurnLogOpen,
  turnLogContentCollapsed
} from './chat-turn-log-state'

describe('turn log open preference', () => {
  it('defaults to collapsed and uses one global ui-state key', () => {
    expect(DEFAULT_TURN_LOG_OPEN).toBe(false)
    expect(TURN_LOG_OPEN_STATE_KEY).toBe('turnLogOpen')
    expect(turnLogContentCollapsed(DEFAULT_TURN_LOG_OPEN)).toBe(true)
  })

  it('only changes when the user toggles it', () => {
    expect(toggleTurnLogOpen(false)).toBe(true)
    expect(toggleTurnLogOpen(true)).toBe(false)
    // 非布尔的旧值或异常值不能让思考区意外展开。
    expect(turnLogContentCollapsed(undefined)).toBe(true)
  })
})
