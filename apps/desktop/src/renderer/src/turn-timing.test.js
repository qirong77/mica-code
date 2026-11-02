import { describe, expect, it } from 'bun:test'
import {
  applyTurnTimingEvent,
  createTurnTimingState,
  groupPercents,
  summarizeTurnTiming
} from './turn-timing'

const BASE = 1_700_000_000_000

function stepStart(at) {
  return { type: 'step_start', timestamp: at }
}

function text(at, body = 'x') {
  return { type: 'text', timestamp: at, part: { type: 'text', text: body } }
}

function reasoning(at, body = 'r') {
  return { type: 'reasoning', timestamp: at, part: { type: 'reasoning', text: body } }
}

function toolStart(at, name, callID) {
  return {
    type: 'tool_use',
    timestamp: at,
    part: {
      type: 'tool',
      tool: name,
      callID,
      displayText: `${name} x`,
      state: { status: 'pending' }
    }
  }
}

function toolDone(at, name, callID) {
  return {
    type: 'tool_use',
    timestamp: at,
    part: { type: 'tool', tool: name, callID, state: { status: 'completed', output: 'ok' } }
  }
}

function stepFinish(at, reason = 'completed') {
  return { type: 'step_finish', timestamp: at, part: { type: 'step-finish', reason } }
}

function run(events) {
  const state = events.reduce(applyTurnTimingEvent, createTurnTimingState())
  return summarizeTurnTiming(state, state.lastAt)
}

function group(summary, id) {
  return summary.groups.find((entry) => entry.id === id)
}

describe('turn timing', () => {
  it('splits one round into wait / generate / tool and keeps them back to back', () => {
    const summary = run([
      stepStart(BASE),
      text(BASE + 2000), // 2s 等首字
      text(BASE + 2500),
      toolStart(BASE + 3000, 'read_file', 'c1'),
      toolDone(BASE + 3400, 'read_file', 'c1'),
      text(BASE + 5400), // 工具回来后等 2s 才出下一个 token
      stepFinish(BASE + 6000)
    ])

    expect(summary.totalMs).toBe(6000)
    expect(group(summary, 'wait').totalMs).toBe(4000) // 2s 首字 + 2s 第二轮
    // 最后一次输出一直延续到本轮结束（step_finish 就是它跑完的那一刻）
    expect(group(summary, 'generate').totalMs).toBe(1600)
    expect(group(summary, 'tool').totalMs).toBe(400)
    const sums = summary.groups.reduce((total, entry) => total + entry.totalMs, 0)
    expect(sums).toBe(summary.totalMs)
    expect(summary.timeline.map((item) => [item.kind, item.offsetMs, item.durationMs])).toEqual([
      ['wait', 0, 2000],
      ['generate', 2000, 1000],
      ['tool', 3000, 400],
      ['wait', 3400, 2000],
      ['generate', 5400, 600]
    ])
  })

  it('lists each tool call in order with its own duration', () => {
    const summary = run([
      stepStart(BASE),
      text(BASE + 100),
      toolStart(BASE + 200, 'read_file', 'c1'),
      toolDone(BASE + 500, 'read_file', 'c1'),
      toolStart(BASE + 600, 'run_shell', 'c2'),
      toolDone(BASE + 2600, 'run_shell', 'c2'),
      stepFinish(BASE + 2700)
    ])

    const tools = group(summary, 'tool')
    expect(tools.count).toBe(2)
    expect(tools.items.map((item) => item.tool)).toEqual(['read_file', 'run_shell'])
    expect(tools.items.map((item) => item.durationMs)).toEqual([300, 2000])
    expect(summary.toolCalls).toBe(2)
  })

  it('counts requests by wait segments and excludes the tail', () => {
    const summary = run([
      stepStart(BASE),
      text(BASE + 1000),
      toolStart(BASE + 1200, 'grep_search', 'c1'),
      toolDone(BASE + 1300, 'grep_search', 'c1'),
      text(BASE + 2300),
      stepFinish(BASE + 2400)
    ])

    expect(group(summary, 'wait').count).toBe(2)
    expect(summary.requests).toBe(2)
  })

  it('keeps only the latest round', () => {
    const first = run([stepStart(BASE), text(BASE + 500), stepFinish(BASE + 800)])
    expect(first.totalMs).toBe(800)

    const state = [
      stepStart(BASE),
      text(BASE + 500),
      stepFinish(BASE + 800),
      stepStart(BASE + 10000),
      text(BASE + 11000),
      stepFinish(BASE + 11500)
    ].reduce(applyTurnTimingEvent, createTurnTimingState())
    const summary = summarizeTurnTiming(state)
    expect(summary.startedAt).toBe(BASE + 10000)
    expect(summary.totalMs).toBe(1500)
  })

  it('marks a tool that never came back when the turn is aborted', () => {
    const summary = run([
      stepStart(BASE),
      text(BASE + 100),
      toolStart(BASE + 200, 'run_shell', 'c1'),
      stepFinish(BASE + 5000, 'aborted')
    ])

    const tools = group(summary, 'tool')
    expect(tools.items[0].status).toBe('aborted')
    expect(tools.items[0].durationMs).toBe(4800)
    expect(summary.outcome).toBe('aborted')
  })

  it('keeps counting while the round is still running', () => {
    const state = [
      stepStart(BASE),
      text(BASE + 3000),
      toolStart(BASE + 3200, 'read_file', 'c1')
    ].reduce(applyTurnTimingEvent, createTurnTimingState())
    const summary = summarizeTurnTiming(state, BASE + 4200)

    expect(summary.running).toBe(true)
    expect(summary.totalMs).toBe(4200)
    expect(group(summary, 'tool').items[0].durationMs).toBe(1000)
  })

  it('has nothing to show before the first turn', () => {
    expect(summarizeTurnTiming(createTurnTimingState())).toBeNull()
    expect(applyTurnTimingEvent(createTurnTimingState(), text(BASE))).toEqual(
      createTurnTimingState()
    )
  })

  it('extends a stream even when reasoning and text interleave', () => {
    const summary = run([
      stepStart(BASE),
      reasoning(BASE + 500, 'try'),
      text(BASE + 1500, 'answer'),
      stepFinish(BASE + 2000)
    ])

    expect(group(summary, 'generate').count).toBe(1)
    expect(group(summary, 'generate').totalMs).toBe(1500)
    expect(group(summary, 'generate').items[0].chars).toBe(9)
  })

  it('rounds group percents so they still add up to 100', () => {
    const groups = [
      { id: 'wait', count: 2, totalMs: 2634, ratio: 0.2634 },
      { id: 'generate', count: 2, totalMs: 1066, ratio: 0.1066 },
      { id: 'tool', count: 1, totalMs: 6300, ratio: 0.63 }
    ]

    expect(groupPercents(groups)).toEqual([26, 11, 63])
  })

  it('keeps empty groups at zero percent', () => {
    const groups = [
      { id: 'wait', count: 1, totalMs: 1000, ratio: 1 },
      { id: 'generate', count: 0, totalMs: 0, ratio: 0 },
      { id: 'tool', count: 0, totalMs: 0, ratio: 0 }
    ]

    expect(groupPercents(groups)).toEqual([100, 0, 0])
  })
})
