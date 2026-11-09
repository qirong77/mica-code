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
  summarizeLedgerEntries,
  summarizeStatsDays,
  usageIdentity
} from './stats-core'

describe('Stats usage aggregation', () => {
  test('aggregates new timing independently for session and ledger records', () => {
    const time = new Date(2026, 7, 2, 12).getTime()
    const records = [
      { outputTokens: 150, generationOutputTokens: 99, generationDurationMs: 2000, responseWaitMs: 0 },
      { outputTokens: 50, generationOutputTokens: 49, generationDurationMs: 1000, responseWaitMs: 300 },
      { outputTokens: 40, durationMs: 100, firstTokenMs: 10 },
      { outputTokens: 10, generationDurationMs: 0, responseWaitMs: -1 },
      { generationDurationMs: 1000, responseWaitMs: Infinity }
    ]
    const [row] = summarizeStatsDays(
      records.map((record) => normalizeUsageEvent(record, time, 'm'))
    )
    expect(row.speedModels[0]).toMatchObject({
      generationOutputTokens: 148,
      generationDurationMs: 3000,
      generationSamples: 2,
      responseWaitMs: 300,
      responseWaitSamples: 2
    })
    const [ledger] = summarizeLedgerEntries([
      { ...records[0], occurredAt: new Date(time).toISOString(), pluginId: 'p', model: 'm' }
    ])
    expect(ledger.days[0].speedModels[0]).toMatchObject({
      generationOutputTokens: 99,
      generationDurationMs: 2000,
      generationSamples: 1,
      responseWaitMs: 0,
      responseWaitSamples: 1
    })
    const legacy = normalizeUsageEvent(records[2], time, 'm')
    expect(legacy.responseWaitMs).toBeNull()
    expect(legacy.generationDurationMs).toBeNull()
  })

  test('rejects old or invalid generation numerators without dropping response wait or usage', () => {
    const time = new Date(2026, 7, 2, 12).getTime()
    const numerators = [undefined, 0, -1, 100, 101, 1.5, '99', Infinity, NaN]
    const records = numerators.map((generationOutputTokens) => ({
      outputTokens: 100, generationOutputTokens, generationDurationMs: 1000, responseWaitMs: 20
    }))
    const [day] = summarizeStatsDays(records.map((record) => normalizeUsageEvent(record, time, 'm')))
    expect(day.outputTokens).toBe(900)
    expect(day.speedModels[0].generationSamples).toBeUndefined()
    expect(day.speedModels[0].responseWaitSamples).toBe(9)
  })

  test('groups timestamped speed requests by minute without inventing times for old records', () => {
    const base = new Date(2026, 7, 2, 12, 15).getTime()
    const events = [
      {
        occurredAt: new Date(base + 4000).toISOString(),
        responseWaitMs: 100,
        generationDurationMs: 1000,
        generationOutputTokens: 49,
        outputTokens: 50
      },
      {
        occurredAt: new Date(base + 21000).toISOString(),
        responseWaitMs: 300,
        generationDurationMs: 1000,
        generationOutputTokens: 149,
        outputTokens: 150
      },
      { occurredAt: new Date(base + 61000).toISOString(), responseWaitMs: 600 },
      { responseWaitMs: 1000 }
    ].map((entry) => normalizeUsageEvent({ providerId: 'p', model: 'm', ...entry }, base, 'm'))
    const [day] = summarizeStatsDays(events)
    expect(day.speedModels[0].responseWaitSamples).toBe(4)
    expect(day.speedMinutes).toHaveLength(2)
    expect(day.speedMinutes[0]).toMatchObject({
      at: base,
      models: [
        {
          responseWaitMs: 400,
          responseWaitSamples: 2,
          generationOutputTokens: 198,
          generationSamples: 2
        }
      ]
    })
    expect(day.speedMinutes[1]).toMatchObject({
      at: base + 60000,
      models: [{ responseWaitMs: 600, responseWaitSamples: 1 }]
    })
  })

  test('aggregates only valid request timing samples by day and provider', () => {
    const time = new Date(2026, 7, 2, 12).getTime()
    const events = [
      { providerId: 'a', model: 'm', outputTokens: 100, durationMs: 1000, firstTokenMs: 0 },
      { providerId: 'a', model: 'm', outputTokens: 50, durationMs: 2000, firstTokenMs: 300 },
      { providerId: 'a', model: 'm', outputTokens: 50 },
      { providerId: 'a', model: 'm', durationMs: 1000, firstTokenMs: -1 },
      { providerId: 'b', model: 'm', outputTokens: 10, durationMs: 0, firstTokenMs: 200 }
    ].map((usage) => normalizeUsageEvent(usage, time, 'm'))
    const [day] = summarizeStatsDays(events)
    expect(day.speedModels).toEqual([
      {
        provider: 'a',
        model: 'm',
        outputTokens: 150,
        durationMs: 3000,
        throughputSamples: 2,
        firstTokenMs: 300,
        firstTokenSamples: 2
      },
      {
        provider: 'b',
        model: 'm',
        outputTokens: 0,
        durationMs: 0,
        throughputSamples: 0,
        firstTokenMs: 200,
        firstTokenSamples: 1
      }
    ])
  })

  test('uses request provider IDs without inferring from protocol or parent session', () => {
    const { events } = parseSessionEvents({
      createdAt: '2026-08-01T01:00:00.000Z',
      updatedAt: '2026-08-01T02:00:00.000Z',
      snapshot: {
        providerId: 'parent',
        model: 'm',
        usageHistory: [{ provider: 'openai', providerId: 'actual' }, { provider: 'openai' }],
        subagentUsageHistory: [
          { provider: 'other', requests: [{ provider: 'openai' }, { providerId: 'child' }] }
        ]
      }
    })
    expect(events.map((event) => event.provider)).toEqual(['actual', null, null, 'child'])
    const [ledger] = summarizeLedgerEntries([
      {
        id: '1',
        occurredAt: '2026-08-01T01:00:00.000Z',
        pluginId: 'p',
        model: 'm',
        provider: 'openai',
        providerId: 'ledger-provider',
        durationMs: 1000,
        outputTokens: 10
      },
      {
        id: '2',
        occurredAt: '2026-08-01T01:00:00.000Z',
        pluginId: 'p',
        model: 'm',
        provider: 'openai',
        durationMs: 1000,
        outputTokens: 10
      }
    ])
    expect(ledger.days[0].speedModels.map((row) => row.provider)).toEqual(['ledger-provider', null])
  })

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
    expect(session.id).toBe('one')
  })

  test('flattens subagent usage records into the event stream with source lineage', () => {
    const { events } = parseSessionEvents({
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
    expect(events).toHaveLength(2)
    expect(events.reduce((sum, event) => sum + event.inputTokens, 0)).toBe(600)
    expect(events).toEqual([
      expect.objectContaining({ usageId: 'main-1' }),
      expect.objectContaining({
        usageId: 'sub-1',
        // 带着发起它的 tool call = 主对话派出去的委派，归到 subagentType 名下。
        source: { kind: 'delegation', id: 'Explore', pluginId: null },
        taskId: 'task-1',
        purpose: 'search files',
        occurredAtMs: Date.parse('2026-08-01T01:30:05.000Z'),
        inputTokens: 100,
        outputTokens: 20
      })
    ])
  })

  test('classifies delegated, plugin and built-in helper requests as different sources', () => {
    const { events } = parseSessionEvents({
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
    expect(events[1]).toMatchObject({
      usageId: 'plugin-1',
      source: { kind: 'plugin', id: 'session-rename', pluginId: 'session-rename' },
      purpose: '自动起标题'
    })

    // 没有 pluginId 也没有发起它的 tool call：内核后台助手（压缩摘要、桌面旁问）。
    const helper = parseSessionEvents({
      id: 'with-helper',
      createdAt: '2026-08-01T01:00:00.000Z',
      updatedAt: '2026-08-01T02:00:00.000Z',
      snapshot: {
        model: 'main-model',
        messages: [],
        usageHistory: [],
        subagentUsageHistory: [
          {
            taskId: 'compact-summary',
            subagentType: 'compact',
            description: '压缩摘要',
            startedAt: '2026-08-01T01:10:00.000Z',
            requests: [{ usageId: 'helper-1', inputTokens: 5 }]
          }
        ]
      }
    })
    expect(helper.events[0].source).toEqual({ kind: 'helper', id: 'compact', pluginId: null })
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
            initiatedByCallId: 'call-1',
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
    // 主对话与委派各占一行来源：插件提供委派也要能和主对话分账。
    expect(first.sources).toEqual([
      expect.objectContaining({
        kind: 'main',
        id: 'main',
        pluginId: null,
        requests: 2,
        totalTokens: 165,
        tasks: [],
        purposes: []
      }),
      {
        kind: 'delegation',
        id: 'Explore',
        // 老记录（这条没有 pluginId）归到内核那一组，界面按 pluginId 分父级。
        pluginId: null,
        tasks: ['task-1'],
        purposes: [],
        requests: 1,
        inputTokens: 30,
        cachedInputTokens: 0,
        uncachedInputTokens: 30,
        outputTokens: 3,
        totalTokens: 33
      }
    ])

    expect(second.day).toBe(localDayKey(secondDay.getTime()))
    expect(second.sources).toEqual([
      expect.objectContaining({
        kind: 'main',
        id: 'main',
        requests: 1,
        totalTokens: 22
      }),
      expect.objectContaining({
        kind: 'plugin',
        id: 'session-rename',
        purposes: ['自动起标题'],
        requests: 1,
        totalTokens: 9
      })
    ])
    // 会话总轮数来自 assistant 消息数，与逐日 turn 数不是一回事。
    expect(compressed.session.turns).toBe(2)
  })

  test('files records without a request time under the session created day', () => {
    const day = new Date(2026, 7, 5, 12, 0, 0)
    const compressed = compressSessionStats({
      version: 1,
      id: 'no-request-time',
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
    expect(compressed.session.days[0].requests).toBe(2)
    expect(compressed.session.requests).toBe(2)
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
