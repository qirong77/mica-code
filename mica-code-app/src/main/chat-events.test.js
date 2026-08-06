import { describe, expect, it } from 'bun:test'
import {
  appendBufferedEvent,
  buildAppServerArgs,
  buildChatEnv,
  CHAT_MCP_INIT_TIMEOUT_MS,
  codexNotificationToEvent,
  createChatEventPacer,
  tokensFromCodexUsage
} from './chat-events'

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
  it('bounds managed MCP startup through an environment variable compatible with older CLIs', () => {
    const source = { PATH: '/usr/bin' }
    expect(buildChatEnv(source)).toEqual({
      PATH: '/usr/bin',
      MICA_MCP_INIT_TIMEOUT_MS: String(CHAT_MCP_INIT_TIMEOUT_MS)
    })
    expect(source).toEqual({ PATH: '/usr/bin' })
  })

  it('builds resident app-server arguments with overrides', () => {
    expect(
      buildAppServerArgs({
        sessionId: 's1',
        cwd: '/tmp/work',
        model: 'krill/gpt-5.6-terra',
        variant: 'high',
        role: 'coder',
        maxTurns: 50
      })
    ).toEqual([
      'app-server',
      '--session',
      's1',
      '--dir',
      '/tmp/work',
      '--model',
      'krill/gpt-5.6-terra',
      '--variant',
      'high',
      '--role',
      'coder',
      '--max-turns',
      '50'
    ])
  })

  it('omits optional app-server flags when absent', () => {
    const args = buildAppServerArgs({})
    expect(args[0]).toBe('app-server')
    for (const flag of ['--session', '--dir', '--model', '--variant', '--role', '--max-turns']) {
      expect(args).not.toContain(flag)
    }
  })

  it('maps codex turn/started to a step_start app event', () => {
    const event = codexNotificationToEvent({
      method: 'turn/started',
      emittedAtMs: 1234,
      params: { threadId: 's1', turn: { id: 'turn-1', status: 'inProgress' } }
    })
    expect(event).toMatchObject({
      type: 'step_start',
      timestamp: 1234,
      sessionID: 's1',
      turnId: 'turn-1'
    })
  })

  it('maps codex agentMessage/reasoning deltas to text/reasoning events', () => {
    expect(
      codexNotificationToEvent({
        method: 'item/agentMessage/delta',
        params: { threadId: 's1', turnId: 't1', itemId: 'i1', delta: 'hi' }
      })
    ).toMatchObject({ type: 'text', part: { type: 'text', text: 'hi' } })
    expect(
      codexNotificationToEvent({
        method: 'item/reasoning/textDelta',
        params: { threadId: 's1', turnId: 't1', itemId: 'i1', delta: 'think', contentIndex: 0 }
      })
    ).toMatchObject({ type: 'reasoning', part: { type: 'reasoning', text: 'think' } })
  })

  it('maps codex commandExecution items to pending/completed tool events', () => {
    const started = codexNotificationToEvent({
      method: 'item/started',
      params: {
        threadId: 's1',
        turnId: 't1',
        item: {
          type: 'commandExecution',
          id: 'c1',
          command: 'run_shell {"cmd":"ls"}',
          status: 'inProgress'
        }
      }
    })
    expect(started).toMatchObject({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'run_shell',
        callID: 'c1',
        state: { status: 'pending', input: { cmd: 'ls' } }
      }
    })
    const completed = codexNotificationToEvent({
      method: 'item/completed',
      params: {
        threadId: 's1',
        turnId: 't1',
        item: {
          type: 'commandExecution',
          id: 'c1',
          command: 'run_shell',
          status: 'completed',
          aggregatedOutput: 'out'
        }
      }
    })
    expect(completed).toMatchObject({
      type: 'tool_use',
      part: {
        type: 'tool',
        callID: 'c1',
        state: { status: 'completed', output: 'out' }
      }
    })
  })

  it('maps codex turn/completed and token usage for step_finish', () => {
    const event = codexNotificationToEvent({
      method: 'turn/completed',
      params: {
        threadId: 's1',
        turn: { id: 't1', status: 'completed' }
      }
    })
    expect(event).toMatchObject({ type: 'step_finish', part: { reason: 'completed' } })
    expect(
      codexNotificationToEvent({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 's1',
          turnId: 't1',
          tokenUsage: {
            total: { total_tokens: 100 },
            last: {
              total_tokens: 10,
              input_tokens: 4,
              cached_input_tokens: 2,
              output_tokens: 6,
              reasoning_output_tokens: 1,
              cache_write_input_tokens: 0
            }
          }
        }
      })
    ).toMatchObject({ type: 'usage', tokenUsage: expect.any(Object) })
  })

  it('builds step_finish tokens from the last codex usage', () => {
    expect(
      tokensFromCodexUsage({
        total: { total_tokens: 100 },
        last: {
          total_tokens: 10,
          input_tokens: 4,
          cached_input_tokens: 2,
          output_tokens: 6,
          reasoning_output_tokens: 1,
          cache_write_input_tokens: 3
        }
      })
    ).toEqual({
      total: 10,
      input: 4,
      output: 6,
      reasoning: 1,
      cache: { read: 2, write: 3 }
    })
    expect(tokensFromCodexUsage(null)).toEqual({
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 }
    })
  })
})
