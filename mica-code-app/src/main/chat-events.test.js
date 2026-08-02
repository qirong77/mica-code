import { describe, expect, it } from 'bun:test'
import { appendBufferedEvent, buildChatArgs, createChatEventPacer } from './chat-events'

function timerHarness() {
  let scheduled = null
  return {
    setTimer(callback, delay) {
      scheduled = { callback, delay }
      return scheduled
    },
    clearTimer(timer) {
      if (scheduled === timer) scheduled = null
    },
    fire() {
      const timer = scheduled
      scheduled = null
      timer?.callback()
    },
    delay() {
      return scheduled?.delay
    }
  }
}

function record(sequence, type, text, sessionID = 's1') {
  return {
    sequence,
    event: { type, sessionID, part: { type, text } }
  }
}

describe('chat event buffering', () => {
  it('coalesces long text and reasoning delta streams without crossing part boundaries', () => {
    const events = []
    for (let sequence = 1; sequence <= 1000; sequence++) {
      appendBufferedEvent(events, {
        sequence,
        event: {
          type: 'text',
          sessionID: 's1',
          part: { type: 'text', text: String(sequence % 10) }
        }
      })
    }
    appendBufferedEvent(events, {
      sequence: 1001,
      event: { type: 'tool_use', sessionID: 's1', part: { type: 'tool', tool: 'read_file' } }
    })
    appendBufferedEvent(events, {
      sequence: 1002,
      event: {
        type: 'reasoning',
        sessionID: 's1',
        part: { type: 'reasoning', text: 'after tool' }
      }
    })

    expect(events).toHaveLength(3)
    expect(events[0].sequence).toBe(1000)
    expect(events[0].event.part.text).toHaveLength(1000)
    expect(events.map((record) => record.event.type)).toEqual(['text', 'tool_use', 'reasoning'])
  })
})

describe('chat live event pacing', () => {
  it('coalesces consecutive deltas until the pacing window expires', () => {
    const emitted = []
    const timers = timerHarness()
    const pacer = createChatEventPacer((value) => emitted.push(value), timers)
    const first = record(1, 'text', 'hello ')

    pacer.push(first)
    pacer.push(record(2, 'text', 'world'))

    expect(emitted).toEqual([])
    expect(timers.delay()).toBe(32)
    timers.fire()
    expect(emitted).toEqual([record(2, 'text', 'hello world')])
    expect(first).toEqual(record(1, 'text', 'hello '))
  })

  it('flushes in order at type, session, and non-delta boundaries', () => {
    const emitted = []
    const timers = timerHarness()
    const pacer = createChatEventPacer((value) => emitted.push(value), timers)
    const tool = {
      sequence: 5,
      event: { type: 'tool_use', sessionID: 's2', part: { tool: 'read_file' } }
    }

    pacer.push(record(1, 'text', 'a'))
    pacer.push(record(2, 'reasoning', 'b'))
    pacer.push(record(3, 'reasoning', 'c', 's2'))
    pacer.push(record(4, 'reasoning', 'd', 's2'))
    pacer.push(tool)

    expect(emitted).toEqual([
      record(1, 'text', 'a'),
      record(2, 'reasoning', 'b'),
      record(4, 'reasoning', 'cd', 's2'),
      tool
    ])
    timers.fire()
    expect(emitted).toHaveLength(4)
  })

  it('supports an explicit flush before process exit', () => {
    const emitted = []
    const timers = timerHarness()
    const pacer = createChatEventPacer((value) => emitted.push(value), timers)

    pacer.push(record(7, 'text', 'partial'))
    expect(pacer.flush()).toBe(true)
    expect(pacer.flush()).toBe(false)
    expect(emitted).toEqual([record(7, 'text', 'partial')])
    timers.fire()
    expect(emitted).toHaveLength(1)
  })
})

describe('chat CLI arguments', () => {
  it('separates prompts from mica options even when the prompt starts with a dash', () => {
    expect(buildChatArgs({ prompt: '--help', sessionId: 's1' })).toEqual([
      'run',
      '--format',
      'json',
      '--thinking',
      '--session',
      's1',
      '--',
      '--help'
    ])
    expect(buildChatArgs({ prompt: '--' }).slice(-2)).toEqual(['--', '--'])
  })

  it('passes model, effort and role overrides through to the mica CLI', () => {
    expect(
      buildChatArgs({
        prompt: 'hello',
        model: 'krill/gpt-5.6-terra',
        variant: 'high',
        role: 'coder'
      })
    ).toEqual([
      'run',
      '--format',
      'json',
      '--thinking',
      '--model',
      'krill/gpt-5.6-terra',
      '--variant',
      'high',
      '--role',
      'coder',
      '--',
      'hello'
    ])
    expect(buildChatArgs({ prompt: 'hi' })).not.toContain('--model')
  })
})
