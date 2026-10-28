import { describe, expect, test } from 'bun:test'
import {
  dedupeStatsSessions,
  filterOwnedSubagentRecords,
  filterOwnedUsage,
  normalizeUsageEvent,
  ownedUsageIdentities,
  parseSessionText,
  parseStatsSession,
  projectContent,
  projectSubagentRecords,
  projectUsage,
  usageIdentity
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

  test('separates plugin model requests from delegated subagents', () => {
    const session = parseStatsSession({
      id: 'with-plugin-request',
      createdAt: '2026-08-01T01:00:00.000Z',
      updatedAt: '2026-08-01T02:00:00.000Z',
      snapshot: {
        model: 'main-model',
        messages: [],
        usageHistory: [{ usageId: 'main-1', inputTokens: 500, outputTokens: 50 }],
        subagentUsageHistory: [
          {
            taskId: 'plugin:session-rename:自动起标题',
            origin: 'plugin',
            pluginId: 'session-rename',
            subagentType: 'plugin:session-rename',
            description: '自动起标题',
            status: 'completed',
            startedAt: '2026-08-01T01:10:00.000Z',
            finishedAt: '2026-08-01T01:10:03.000Z',
            requests: [{ usageId: 'plugin-1', inputTokens: 80, outputTokens: 8 }]
          }
        ]
      }
    })

    // 插件请求照样算进本会话的开销，但不该被当成一次委派子代理任务。
    expect(session.requests).toBe(2)
    expect(session.inputTokens).toBe(580)
    expect(session.subagentTasks).toBe(0)
    expect(session.pluginRequests).toBe(1)
    expect(session.usageEvents[1]).toMatchObject({
      usageId: 'plugin-1',
      isSubagent: false,
      isPlugin: true,
      pluginId: 'session-rename',
      pluginPurpose: '自动起标题'
    })
  })

  test('gives raw records and projected events the same identity', () => {
    const raw = { usageId: 'u1', inputTokens: 10 }
    expect(usageIdentity(raw)).toBe('id:u1')
    expect(normalizeUsageEvent(raw, 0, 'm').identity).toBe('id:u1')

    const legacy = { turnId: 1, requestIndex: 0, inputTokens: 50, outputTokens: 5 }
    expect(usageIdentity(legacy)).toBe(usageIdentity({ ...legacy }))
    // Same numbers but a different record: legacy identity is content based, not value based.
    expect(usageIdentity(legacy)).not.toBe(usageIdentity({ ...legacy, inputTokens: 51 }))
  })

  test('detail view keeps only the events the session owns after dedupe', () => {
    const shared = { usageId: 'shared', inputTokens: 100, outputTokens: 10 }
    const raw = (id, createdAt, usageHistory, subagentUsageHistory) => ({
      id,
      createdAt,
      updatedAt: createdAt,
      title: id,
      cwd: '/tmp',
      snapshot: { model: 'm', messages: [], usageHistory, subagentUsageHistory }
    })
    const source = parseStatsSession(raw('source', '2026-08-01T00:00:00.000Z', [shared]))
    const subagentRecord = {
      taskId: 'task',
      subagentType: 'Explore',
      description: 'look around',
      status: 'completed',
      startedAt: '2026-08-02T00:00:00.000Z',
      requests: [shared, { usageId: 'sub-own', inputTokens: 30 }],
      summary: {
        records: 2,
        inputTokens: 130,
        outputTokens: 10,
        cachedInputTokens: 0,
        totalTokens: 140
      }
    }
    const fork = parseStatsSession(
      raw(
        'fork',
        '2026-08-02T00:00:00.000Z',
        [shared, { usageId: 'own', inputTokens: 20 }],
        [subagentRecord]
      )
    )
    const sessions = dedupeStatsSessions([source, fork])
    const sourceOwned = ownedUsageIdentities(sessions, 'source')
    const forkOwned = ownedUsageIdentities(sessions, 'fork')

    expect(filterOwnedUsage([shared], sourceOwned)).toEqual([shared])
    expect(filterOwnedUsage([shared, { usageId: 'own', inputTokens: 20 }], forkOwned)).toEqual([
      { usageId: 'own', inputTokens: 20 }
    ])
    // The fork's copied subagent request is attributed to the source, its own one stays.
    expect(filterOwnedUsage([shared, { usageId: 'sub-own', inputTokens: 30 }], forkOwned)).toEqual([
      { usageId: 'sub-own', inputTokens: 30 }
    ])
    // A session outside the deduped scan (legacy file format) keeps its records untouched.
    expect(ownedUsageIdentities(sessions, 'missing')).toBeNull()
    expect(filterOwnedUsage([shared], ownedUsageIdentities(sessions, 'missing'))).toEqual([shared])
    // Records get a summary recomputed from the requests the session actually owns
    // (same 口径 as mica-agent's summarizeUsageHistory).
    const [record] = filterOwnedSubagentRecords(
      [
        {
          ...subagentRecord,
          requests: [shared, { usageId: 'sub-own', inputTokens: 30, totalTokens: 30 }]
        }
      ],
      forkOwned
    )
    expect(record.requests).toEqual([{ usageId: 'sub-own', inputTokens: 30, totalTokens: 30 }])
    expect(record.summary).toEqual({
      records: 1,
      inputTokens: 30,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 30
    })
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

describe('parseSessionText', () => {
  const session = (conversationMessages) => ({
    version: 1,
    id: 's-1',
    title: 't',
    snapshot: { conversationMessages }
  })

  test('collects user and assistant text, skipping notices and tool payloads', () => {
    const parsed = parseSessionText(
      session([
        { role: 'user', content: '帮我优化会话搜索' },
        { role: 'notice', content: '命令执行失败：boom' },
        { role: 'assistant', content: [{ type: 'text', text: '好的，先看实现' }] },
        { role: 'assistant', content: [{ type: 'image', source: {} }] }
      ])
    )
    expect(parsed.text).toContain('帮我优化会话搜索')
    expect(parsed.text).toContain('好的，先看实现')
    expect(parsed.text).toContain('[image]')
    expect(parsed.text).not.toContain('boom')
    expect(parsed.truncated).toBe(false)
  })

  test('includes displayContent so plugin-injected messages stay searchable', () => {
    const parsed = parseSessionText(
      session([{ role: 'user', content: '现在是几点', displayContent: '定时任务：检查构建状态' }])
    )
    expect(parsed.text).toContain('定时任务：检查构建状态')
    expect(parsed.text).toContain('现在是几点')
  })

  test('does not duplicate content that matches displayContent', () => {
    const parsed = parseSessionText(
      session([{ role: 'user', content: '同样的一句话', displayContent: '同样的一句话' }])
    )
    expect(parsed.text).toBe('同样的一句话')
  })

  test('caps the body, keeps both ends, and reports truncation', () => {
    const parsed = parseSessionText(
      session([
        { role: 'user', content: '开头标记' },
        { role: 'assistant', content: 'x'.repeat(200) },
        { role: 'assistant', content: '结尾标记' }
      ]),
      { maxChars: 100 }
    )
    expect(parsed.text.length).toBeLessThanOrEqual(100)
    expect(parsed.text.startsWith('开头标记')).toBe(true)
    expect(parsed.text.endsWith('结尾标记')).toBe(true)
    expect(parsed.truncated).toBe(true)
  })

  test('skips compact boundary metadata but keeps the checkpoint summary', () => {
    const parsed = parseSessionText(
      session([
        { role: 'user', content: '[Mica compact boundary]\n\n{"prompts":["搜索会话"]}' },
        { role: 'user', content: '[Mica compact checkpoint]\n\n摘要：搜索会话的优化' },
        { role: 'assistant', content: '好的' }
      ])
    )
    expect(parsed.text).toContain('摘要：搜索会话的优化')
    expect(parsed.text).not.toContain('compact boundary')
  })

  test('returns null when there is nothing to search', () => {
    expect(parseSessionText(session([]))).toBeNull()
    expect(parseSessionText(session([{ role: 'notice', content: 'only a notice' }]))).toBeNull()
    expect(parseSessionText({ id: 's', snapshot: {} })).toBeNull()
    expect(parseSessionText(null)).toBeNull()
  })
})
