import { describe, expect, test } from 'bun:test'
import {
  dedupeStatsSessions,
  normalizeUsageEvent,
  parseStatsSession,
  projectContent,
  projectMessages,
  projectSubagentRecords,
  projectUsage
} from './stats-core'

describe('Stats usage aggregation', () => {
  test('separates cached and uncached input and derives a reconcilable total', () => {
    const event = normalizeUsageEvent(
      { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, totalTokens: 999 },
      1,
      'model'
    )
    expect(event).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 40,
      uncachedInputTokens: 60,
      outputTokens: 20,
      totalTokens: 120
    })
  })

  test('uses per-request time and a stable created-at fallback for old records', () => {
    const session = parseStatsSession({
      id: 'one',
      createdAt: '2026-08-01T01:00:00.000Z',
      updatedAt: '2026-08-03T01:00:00.000Z',
      snapshot: {
        model: 'm',
        messages: [],
        usageHistory: [
          { occurredAt: '2026-08-02T02:00:00.000Z', inputTokens: 10 },
          { inputTokens: 20 }
        ]
      }
    })
    expect(session.usageEvents.map((event) => event.occurredAtMs)).toEqual([
      Date.parse('2026-08-02T02:00:00.000Z'),
      Date.parse('2026-08-01T01:00:00.000Z')
    ])
    expect(session.legacyUsageRecords).toBe(1)
  })

  test('counts a usage ID only once across a source session and its fork', () => {
    const raw = (id, createdAt, usageHistory) =>
      parseStatsSession({
        id,
        createdAt,
        updatedAt: createdAt,
        snapshot: { model: 'm', messages: [], usageHistory }
      })
    const shared = { usageId: 'shared', inputTokens: 100, outputTokens: 10 }
    const sessions = dedupeStatsSessions([
      raw('fork', '2026-08-02T00:00:00.000Z', [shared, { usageId: 'new', inputTokens: 20 }]),
      raw('source', '2026-08-01T00:00:00.000Z', [shared])
    ])
    expect(sessions.map((session) => [session.id, session.requests, session.totalTokens])).toEqual([
      ['source', 1, 110],
      ['fork', 1, 20]
    ])
  })

  test('repairs byte-for-byte duplicated usage in legacy fork snapshots', () => {
    const make = (id, createdAt) =>
      parseStatsSession({
        id,
        createdAt,
        updatedAt: createdAt,
        snapshot: {
          model: 'm',
          messages: [],
          usageHistory: [{ turnId: 1, requestIndex: 0, inputTokens: 50, outputTokens: 5 }]
        }
      })
    const sessions = dedupeStatsSessions([
      make('source', '2026-08-01T00:00:00.000Z'),
      make('fork', '2026-08-02T00:00:00.000Z')
    ])
    expect(sessions.reduce((total, session) => total + session.totalTokens, 0)).toBe(55)
  })

  test('flattens subagent usage records into the event stream with task lineage', () => {
    const session = parseStatsSession({
      id: 'with-subagent',
      createdAt: '2026-08-01T01:00:00.000Z',
      updatedAt: '2026-08-01T02:00:00.000Z',
      snapshot: {
        model: 'main-model',
        messages: [],
        usageHistory: [{ usageId: 'main-1', inputTokens: 500, outputTokens: 50 }],
        subagentUsageHistory: [
          {
            taskId: 'task-1',
            parentTaskId: 'task-0',
            initiatedByCallId: 'call-abc',
            subagentType: 'Explore',
            description: 'search files',
            status: 'completed',
            startedAt: '2026-08-01T01:30:00.000Z',
            finishedAt: '2026-08-01T01:31:00.000Z',
            requests: [
              {
                usageId: 'sub-1',
                occurredAt: '2026-08-01T01:30:05.000Z',
                inputTokens: 100,
                outputTokens: 20
              }
            ],
            summary: {
              records: 1,
              inputTokens: 100,
              outputTokens: 20,
              cachedInputTokens: 0,
              totalTokens: 120
            }
          }
        ]
      }
    })
    expect(session.subagentTasks).toBe(1)
    expect(session.requests).toBe(2)
    expect(session.inputTokens).toBe(600)
    expect(session.usageEvents).toEqual([
      expect.objectContaining({ usageId: 'main-1' }),
      expect.objectContaining({
        usageId: 'sub-1',
        isSubagent: true,
        subagentTaskId: 'task-1',
        subagentParentTaskId: 'task-0',
        initiatedByCallId: 'call-abc',
        subagentType: 'Explore',
        subagentStatus: 'completed',
        subagentDescription: 'search files',
        occurredAtMs: Date.parse('2026-08-01T01:30:05.000Z'),
        inputTokens: 100,
        outputTokens: 20
      })
    ])
  })

  test('falls back to the subagent task startedAt when requests lack occurredAt', () => {
    const session = parseStatsSession({
      id: 'legacy-subagent',
      createdAt: '2026-08-01T01:00:00.000Z',
      updatedAt: '2026-08-01T02:00:00.000Z',
      snapshot: {
        model: 'main-model',
        messages: [],
        usageHistory: [],
        subagentUsageHistory: [
          {
            taskId: 'task-2',
            subagentType: 'Implementer',
            description: 'write code',
            status: 'completed',
            startedAt: '2026-08-03T09:30:00.000Z',
            finishedAt: '2026-08-03T09:35:00.000Z',
            requests: [{ inputTokens: 50, outputTokens: 5 }],
            summary: {
              records: 1,
              inputTokens: 50,
              outputTokens: 5,
              cachedInputTokens: 0,
              totalTokens: 55
            }
          }
        ]
      }
    })
    expect(session.usageEvents[0].occurredAtMs).toBe(Date.parse('2026-08-03T09:30:00.000Z'))
    expect(session.usageEvents[0].dateAccuracy).toBe('session-created')
  })

  test('projects content blocks to text placeholders and truncates long strings', () => {
    expect(projectContent('short text', 100)).toBe('short text')
    expect(projectContent('x'.repeat(500), 100)).toBe(`${'x'.repeat(100)}…`)
    expect(
      projectContent(
        [
          { type: 'text', text: 'hello' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'thinking', text: 'hidden' }
        ],
        200
      )
    ).toBe('hello\n[image]\n[thinking]')
  })

  test('projects provider messages into a renderer-safe shape', () => {
    const out = projectMessages([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'grep_search', arguments: '{"pattern":"x"}' }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'no match' }
    ])
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'call_1', name: 'grep_search', arguments: '{"pattern":"x"}' }]
      },
      { role: 'tool', toolCallId: 'call_1', content: 'no match' }
    ])
  })

  test('projects usage and subagent records to a compact renderer shape', () => {
    expect(
      projectUsage({
        usageId: 'u-1',
        occurredAt: '2026-08-01T00:00:00.000Z',
        model: 'm',
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 2,
        totalTokens: 12,
        paidTokenRate: 0.4,
        rawUsage: { prompt_tokens: 10 }
      })
    ).toEqual({
      usageId: 'u-1',
      occurredAt: '2026-08-01T00:00:00.000Z',
      turnId: null,
      requestIndex: null,
      model: 'm',
      provider: null,
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 2,
      totalTokens: 12,
      paidTokenRate: 0.4
    })
    const records = projectSubagentRecords([
      {
        taskId: 'task-1',
        subagentType: 'Explore',
        status: 'completed',
        requests: [{ usageId: 'sub-1', inputTokens: 5, outputTokens: 1 }],
        summary: { records: 1 }
      }
    ])
    expect(records[0].taskId).toBe('task-1')
    expect(records[0].requests).toEqual([
      expect.objectContaining({ usageId: 'sub-1', inputTokens: 5, outputTokens: 1 })
    ])
    expect(records[0].summary).toEqual({ records: 1 })
  })
})
