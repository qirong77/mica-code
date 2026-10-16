import { describe, expect, test } from 'bun:test'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  buildDraftSearchResults,
  buildSessionSearchResults,
  contentMatchMap,
  rankSearchItems,
  sessionSearchSinceMs,
  tokenizeSearchQuery
} from './session-search'

const NOW = new Date(2026, 0, 10, 12, 0, 0).getTime()
const day = 24 * 60 * 60 * 1000

const session = (id, overrides = {}) => ({
  id,
  title: `会话 ${id}`,
  cwd: `/work/${id}`,
  updatedAtMs: NOW,
  ...overrides
})

describe('contentMatchMap', () => {
  test('keys hits by session id and ignores malformed rows', () => {
    const map = contentMatchMap([
      { id: 'a', snippet: { text: '…正文…', ranges: [] } },
      { id: 'b' },
      null,
      { snippet: {} }
    ])
    expect([...map.keys()]).toEqual(['a'])
  })
})

describe('buildSessionSearchResults', () => {
  const tokens = tokenizeSearchQuery('mica')

  test('matches the title, the cwd basename and the session id', () => {
    const { items } = rankSearchItems(
      buildSessionSearchResults({
        sessions: [
          session('plain', { title: '会话一', cwd: '/work/plain' }),
          session('mica-search', { title: '会话二', cwd: '/work/nothing' }),
          session('title-hit', { title: 'Mica 搜索优化', cwd: '/work/nothing' })
        ],
        tokens,
        sinceMs: 0
      })
    )
    expect(items.map((item) => item.id)).toEqual(['title-hit', 'mica-search'])
  })

  test('drops sessions outside the time range even when the title matches', () => {
    const items = buildSessionSearchResults({
      sessions: [
        session('recent', { title: 'Mica 搜索' }),
        session('old', { title: 'Mica 搜索', updatedAtMs: NOW - 10 * day })
      ],
      tokens,
      sinceMs: sessionSearchSinceMs('3d', NOW)
    })
    expect(items.map((item) => item.id)).toEqual(['recent'])
  })

  test('keeps sessions that only match inside their conversation body', () => {
    const items = buildSessionSearchResults({
      sessions: [session('deep', { title: '无关标题', cwd: '/work/deep' })],
      tokens,
      sinceMs: 0,
      contentMatches: contentMatchMap([
        { id: 'deep', snippet: { text: '…聊到 Mica 的搜索…', ranges: [[3, 7]] } }
      ])
    })
    expect(items).toHaveLength(1)
    expect(items[0].snippet.text).toContain('Mica')
    expect(items[0].score).toBeGreaterThan(0)
  })

  test('ranks a title hit above a content-only hit', () => {
    const { items } = rankSearchItems(
      buildSessionSearchResults({
        sessions: [
          session('body', { title: '无关标题', cwd: '/work/body' }),
          session('title', { title: 'Mica 搜索', cwd: '/work/title' })
        ],
        tokens,
        sinceMs: 0,
        contentMatches: contentMatchMap([
          { id: 'body', snippet: { text: '…… Mica ……', ranges: [] } }
        ])
      })
    )
    expect(items.map((item) => item.id)).toEqual(['title', 'body'])
  })

  test('searches the group name and the loop task as weak extras', () => {
    const items = buildSessionSearchResults({
      sessions: [session('grouped', { title: '无关', cwd: '/work/grouped' })],
      tokens,
      sinceMs: 0,
      groupOf: () => 'mica 相关'
    })
    expect(items).toHaveLength(1)
    expect(items[0].label).toBe('')
  })

  test('reports highlight ranges for the title and the cwd', () => {
    const items = buildSessionSearchResults({
      sessions: [session('a', { title: 'Mica 搜索', cwd: '/Users/me/mica-code' })],
      tokens,
      sinceMs: 0
    })
    const [item] = items
    expect(item.titleRanges).toEqual([[0, 4]])
    expect(item.title.slice(...item.titleRanges[0])).toBe('Mica')
    expect(item.cwd.slice(...item.cwdRanges[0])).toBe('mica')
  })

  test('returns nothing without tokens', () => {
    expect(buildSessionSearchResults({ sessions: [session('a')], tokens: [], sinceMs: 0 })).toEqual(
      []
    )
  })
})

describe('buildDraftSearchResults', () => {
  test('matches draft tabs by name and cwd', () => {
    const items = buildDraftSearchResults({
      drafts: [
        { id: 'd1', text: 'mica 搜索优化', cwd: '/work/a' },
        { id: 'd2', text: '别的', cwd: '/work/mica-code' },
        { id: 'd3', text: '无关', cwd: '/work/c' }
      ],
      tokens: tokenizeSearchQuery('mica'),
      now: NOW
    })
    expect(items.map((item) => item.id)).toEqual(['d1', 'd2'])
    expect(items[0].kind).toBe('draft')
  })
})

describe('rankSearchItems', () => {
  test('sorts by relevance, then by recency, and reports the overflow', () => {
    const items = [
      { id: 'a', score: 100, updatedAtMs: 1 },
      { id: 'b', score: 300, updatedAtMs: 1 },
      { id: 'c', score: 100, updatedAtMs: 9 },
      { id: 'd', score: 200, updatedAtMs: 1 }
    ]
    const { items: ranked, overflow } = rankSearchItems(items, 3)
    expect(ranked.map((item) => item.id)).toEqual(['b', 'd', 'c'])
    expect(overflow).toBe(1)
    expect(rankSearchItems(items).items).toHaveLength(4)
    expect(SESSION_SEARCH_RESULT_LIMIT).toBeGreaterThan(3)
  })

  test('does not mutate the input', () => {
    const items = [
      { id: 'a', score: 1, updatedAtMs: 0 },
      { id: 'b', score: 2, updatedAtMs: 0 }
    ]
    rankSearchItems(items)
    expect(items.map((item) => item.id)).toEqual(['a', 'b'])
  })
})
