import { describe, expect, it } from 'bun:test'
import {
  MAX_RECENT_CWDS,
  collectRecentCwds,
  cwdMatchRank,
  cwdQueryTokens,
  matchesCwdQuery,
  normalizeCwd,
  rankCwdMatches,
  splitCwd
} from './cwd-recents'

const session = (cwd, updatedAtMs) => ({ id: `${cwd}-${updatedAtMs}`, cwd, updatedAtMs })

describe('normalizeCwd', () => {
  it('trims whitespace and drops trailing separators', () => {
    expect(normalizeCwd('  /Users/qi/project/  ')).toBe('/Users/qi/project')
    expect(normalizeCwd('/Users/qi/project///')).toBe('/Users/qi/project')
  })

  it('keeps the root directory and rejects empty values', () => {
    expect(normalizeCwd('/')).toBe('/')
    expect(normalizeCwd('')).toBe('')
    expect(normalizeCwd(null)).toBe('')
    expect(normalizeCwd(42)).toBe('')
  })
})

describe('collectRecentCwds', () => {
  it('dedupes cwds, keeps the latest use and counts sessions', () => {
    const entries = collectRecentCwds([
      session('/a', 10),
      session('/b', 30),
      session('/a', 20),
      session('', 99),
      session(null, 99)
    ])
    expect(entries).toEqual([
      { path: '/b', usedAtMs: 30, sessionCount: 1 },
      { path: '/a', usedAtMs: 20, sessionCount: 2 }
    ])
  })

  it('sorts by recency and caps the pool', () => {
    const entries = collectRecentCwds([session('/a', 1), session('/b', 3), session('/c', 2)], {
      limit: 2
    })
    expect(entries.map((entry) => entry.path)).toEqual(['/b', '/c'])
  })

  it('never returns more than the default cap', () => {
    const many = Array.from({ length: MAX_RECENT_CWDS + 20 }, (_, index) =>
      session(`/dir-${index}`, index)
    )
    expect(collectRecentCwds(many)).toHaveLength(MAX_RECENT_CWDS)
  })

  it('tolerates a missing session list', () => {
    expect(collectRecentCwds(undefined)).toEqual([])
  })
})

describe('cwdQueryTokens / matchesCwdQuery', () => {
  it('splits on whitespace, lowercases and drops empties', () => {
    expect(cwdQueryTokens('  Mica   DESKTOP ')).toEqual(['mica', 'desktop'])
  })

  it('requires every token to appear somewhere in the path', () => {
    expect(matchesCwdQuery('/Users/qi/mica-code/apps/desktop', ['mica', 'desktop'])).toBe(true)
    expect(matchesCwdQuery('/Users/qi/mica-code', ['mica', 'desktop'])).toBe(false)
    expect(matchesCwdQuery('/anything', [])).toBe(true)
  })
})

describe('splitCwd', () => {
  it('splits the last segment off the path', () => {
    expect(splitCwd('/Users/qi/project')).toEqual({ head: '/Users/qi/', tail: 'project' })
    expect(splitCwd('/')).toEqual({ head: '/', tail: '' })
    expect(splitCwd('project')).toEqual({ head: '', tail: 'project' })
  })
})

describe('cwdMatchRank', () => {
  it('ranks end-segment hits above hits elsewhere in the path', () => {
    expect(cwdMatchRank('/a/apps/desktop', 'desktop')).toBe(0)
    expect(cwdMatchRank('/a/desktop-tools', 'desktop')).toBe(1)
    expect(cwdMatchRank('/a/my-desktop-app', 'desktop')).toBe(2)
    expect(cwdMatchRank('/desktop/a/other', 'desktop')).toBe(3)
  })
})

describe('rankCwdMatches', () => {
  const entries = [
    { path: '/Users/qi/mica-code', usedAtMs: 50, sessionCount: 3 },
    { path: '/Users/qi/mica-code/apps/desktop', usedAtMs: 10, sessionCount: 1 },
    { path: '/Users/qi/desktop', usedAtMs: 1, sessionCount: 1 },
    { path: '/tmp/other', usedAtMs: 90, sessionCount: 1 }
  ]

  it('keeps the recency order when the query is empty', () => {
    expect(rankCwdMatches(entries, '').map((entry) => entry.path)).toEqual([
      '/Users/qi/mica-code',
      '/Users/qi/mica-code/apps/desktop',
      '/Users/qi/desktop',
      '/tmp/other'
    ])
  })

  it('filters out non-matching paths and puts the folder name hit first', () => {
    expect(rankCwdMatches(entries, 'desktop').map((entry) => entry.path)).toEqual([
      '/Users/qi/desktop',
      '/Users/qi/mica-code/apps/desktop'
    ])
  })

  it('supports multi-token queries', () => {
    expect(rankCwdMatches(entries, 'mica desktop').map((entry) => entry.path)).toEqual([
      '/Users/qi/mica-code/apps/desktop'
    ])
  })

  it('lets any token claim the end segment', () => {
    // `mica des`：两条都命中（`Desktop` 段里也有 des），但只有 desktop 是项目名直接命中
    const ranked = rankCwdMatches(
      [
        { path: '/Users/qi/Desktop/mica-code/website', usedAtMs: 90, sessionCount: 1 },
        { path: '/Users/qi/Desktop/mica-code/apps/desktop', usedAtMs: 1, sessionCount: 1 }
      ],
      'mica des'
    )
    expect(ranked.map((entry) => entry.path)).toEqual([
      '/Users/qi/Desktop/mica-code/apps/desktop',
      '/Users/qi/Desktop/mica-code/website'
    ])
  })

  it('prefers the shorter path for the same rank', () => {
    const ranked = rankCwdMatches(
      [
        { path: '/deep/nested/desktop', usedAtMs: 90, sessionCount: 1 },
        { path: '/desktop', usedAtMs: 1, sessionCount: 1 }
      ],
      'desktop'
    )
    expect(ranked.map((entry) => entry.path)).toEqual(['/desktop', '/deep/nested/desktop'])
  })

  it('is case insensitive', () => {
    expect(rankCwdMatches(entries, 'MICA').map((entry) => entry.path)).toEqual([
      '/Users/qi/mica-code',
      '/Users/qi/mica-code/apps/desktop'
    ])
  })

  it('honours the limit and tolerates junk input', () => {
    expect(rankCwdMatches(entries, 'qi', { limit: 2 })).toHaveLength(2)
    expect(rankCwdMatches(null, 'qi')).toEqual([])
    expect(rankCwdMatches([{}], 'qi')).toEqual([])
  })
})
