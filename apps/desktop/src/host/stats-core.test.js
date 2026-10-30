import { describe, expect, test } from 'bun:test'
import { localDayKey } from '@packages/mica-web-shared/stats-day.js'
import {
  compressSessionStats,
  filterOwnedSubagentRecords,
  filterOwnedUsage,
  normalizeUsageEvent,
  parseSessionEvents,
  parseSessionText,
  projectContent,
  projectSubagentRecords,
  projectUsage,
  summarizeStatsDays,
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
    const { session, events } = parseSessionEvents({
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
    expect(events.map((event) => event.occurredAtMs)).toEqual([
      Date.parse('2026-08-02T02:00:00.000Z'),
      Date.parse('2026-08-01T01:00:00.000Z')
    ])
    expect(events.filter((event) => event.dateAccuracy !== 'exact')).toHaveLength(1)
    expect(session.id).toBe('one')
  })

  test('flattens subagent usage records into the event stream with task lineage', () => {
    const { session, events } = parseSessionEvents({
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
    expect(events).toHaveLength(2)
    expect(events.reduce((sum, event) => sum + event.inputTokens, 0)).toBe(600)
    expect(events).toEqual([
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
    const { session, events } = parseSessionEvents({
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
    expect(events).toHaveLength(2)
    expect(events.reduce((sum, event) => sum + event.inputTokens, 0)).toBe(580)
    expect(session.subagentTasks).toBe(0)
    expect(session.pluginRequests).toBe(1)
    expect(events[1]).toMatchObject({
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
    // 归属表由扫描器构建（见 stats-scanner.test.js）；详情视图只负责按它过滤。
    const sourceOwned = new Set(['id:shared'])
    const forkOwned = new Set(['id:own', 'id:sub-own'])

    expect(filterOwnedUsage([shared], sourceOwned)).toEqual([shared])
    expect(filterOwnedUsage([shared, { usageId: 'own', inputTokens: 20 }], forkOwned)).toEqual([
      { usageId: 'own', inputTokens: 20 }
    ])
    // The fork's copied subagent request is attributed to the source, its own one stays.
    expect(filterOwnedUsage([shared, { usageId: 'sub-own', inputTokens: 30 }], forkOwned)).toEqual([
      { usageId: 'sub-own', inputTokens: 30 }
    ])
    // 未知会话（老格式文件）没有归属信息，记录原样保留。
    expect(filterOwnedUsage([shared], null)).toEqual([shared])
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
    const { events } = parseSessionEvents({
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
    expect(events[0].occurredAtMs).toBe(Date.parse('2026-08-03T09:30:00.000Z'))
    expect(events[0].dateAccuracy).toBe('session-created')
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

  test('compresses a session into day rows without shipping usage events', () => {
    const firstDay = new Date(2026, 7, 2, 10, 0, 0)
    const secondDay = new Date(2026, 7, 3, 9, 0, 0)
    const compressed = compressSessionStats({
      version: 1,
      id: 'compressed',
      createdAt: firstDay.toISOString(),
      updatedAt: secondDay.toISOString(),
      snapshot: {
        model: 'main-model',
        messages: [{ role: 'assistant' }, { role: 'assistant' }],
        usageHistory: [
          {
            usageId: 'a',
            occurredAt: firstDay.toISOString(),
            turnId: 1,
            inputTokens: 100,
            cachedInputTokens: 40,
            outputTokens: 10
          },
          {
            usageId: 'b',
            occurredAt: new Date(2026, 7, 2, 18, 0, 0).toISOString(),
            turnId: 2,
            model: 'side-model',
            inputTokens: 50,
            outputTokens: 5
          },
          {
            usageId: 'c',
            occurredAt: secondDay.toISOString(),
            turnId: 3,
            inputTokens: 20,
            outputTokens: 2
          }
        ],
        subagentUsageHistory: [
          {
            taskId: 'task-1',
            subagentType: 'Explore',
            startedAt: firstDay.toISOString(),
            requests: [{ usageId: 'sub-1', inputTokens: 30, outputTokens: 3 }]
          },
          {
            taskId: 'plugin:session-rename:title',
            origin: 'plugin',
            pluginId: 'session-rename',
            description: '自动起标题',
            startedAt: secondDay.toISOString(),
            requests: [{ usageId: 'plugin-1', inputTokens: 8, outputTokens: 1 }]
          }
        ]
      }
    })

    expect(compressed.identities).toEqual(['id:a', 'id:b', 'id:c', 'id:sub-1', 'id:plugin-1'])
    // 逐条事件（含身份）不再离开 host：统计页只拿得到日行。
    expect(compressed.session.usageEvents).toBeUndefined()
    expect(compressed.session.requests).toBe(5)
    expect(compressed.session.turns).toBe(2)
    expect(compressed.session.days).toHaveLength(2)

    const [first, second] = compressed.session.days
    expect(first.day).toBe(localDayKey(firstDay.getTime()))
    expect(first.requests).toBe(3)
    // 同一轮里的主请求与 subagent 请求算同一个 turn。
    expect(first.turns).toBe(2)
    expect(first.inputTokens).toBe(180)
    expect(first.cachedInputTokens).toBe(40)
    expect(first.uncachedInputTokens).toBe(140)
    expect(first.totalTokens).toBe(198)
    expect(first.models).toHaveLength(2)
    expect(first.models).toContainEqual(
      expect.objectContaining({ model: 'main-model', requests: 2, totalTokens: 143 })
    )
    expect(first.models).toContainEqual(
      expect.objectContaining({ model: 'side-model', requests: 1, totalTokens: 55 })
    )
    expect(first.subagents).toEqual([
      {
        type: 'Explore',
        tasks: ['task-1'],
        requests: 1,
        inputTokens: 30,
        outputTokens: 3,
        totalTokens: 33
      }
    ])
    expect(first.plugins).toEqual([])

    expect(second.day).toBe(localDayKey(secondDay.getTime()))
    expect(second.plugins).toEqual([
      expect.objectContaining({
        pluginId: 'session-rename',
        purposes: ['自动起标题'],
        requests: 1,
        totalTokens: 9
      })
    ])
    // 会话总轮数来自 assistant 消息数，与逐日 turn 数不是一回事。
    expect(compressed.session.turns).toBe(2)
  })

  test('keeps legacy records counted per day and per session', () => {
    const day = new Date(2026, 7, 5, 12, 0, 0)
    const compressed = compressSessionStats({
      version: 1,
      id: 'legacy',
      createdAt: day.toISOString(),
      updatedAt: day.toISOString(),
      snapshot: {
        model: 'm',
        messages: [],
        usageHistory: [
          { turnId: 1, requestIndex: 0, inputTokens: 50, outputTokens: 5 },
          { usageId: 'exact', occurredAt: day.toISOString(), inputTokens: 10, outputTokens: 1 }
        ]
      }
    })
    expect(compressed.session.legacyUsageRecords).toBe(1)
    expect(compressed.session.days[0].legacy).toBe(1)
    expect(summarizeStatsDays([])).toEqual([])
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
