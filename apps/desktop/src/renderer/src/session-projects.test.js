import { describe, expect, it } from 'bun:test'
import {
  collectGroupDigests,
  groupSubtreeIds,
  resolveGroupCwd,
  sessionSectionOf,
  sessionsByGroup
} from './session-projects'

const projects = {
  version: 1,
  groups: [
    { id: 'root', name: '根', parentId: null },
    { id: 'child', name: '子', parentId: 'root' },
    { id: 'other', name: '别的', parentId: null }
  ],
  assignments: { s1: 'root', s2: 'child' }
}

describe('sessionSectionOf', () => {
  it('lets a pin win over a group assignment', () => {
    expect(sessionSectionOf('s1', { pins: { s1: 1 }, projects })).toEqual({
      section: 'pinned',
      groupId: null
    })
  })

  it('reports the owning group, otherwise recent', () => {
    expect(sessionSectionOf('s2', { pins: {}, projects })).toEqual({
      section: 'project',
      groupId: 'child'
    })
    expect(sessionSectionOf('s9', { pins: {}, projects })).toEqual({
      section: 'recent',
      groupId: null
    })
  })

  it('treats an assignment to a deleted group as recent', () => {
    const stale = { ...projects, groups: projects.groups.slice(0, 1) }
    expect(sessionSectionOf('s2', { pins: {}, projects: stale }).section).toBe('recent')
  })

  // 侧栏没有「定时任务」分区：挂着循环的会话留在原分区，只由行首时钟图标标识，
  // 所以归属只认手动放置（pins / projects）。
  it('leaves a session running a loop in its manual section', () => {
    expect(sessionSectionOf('s1', { pins: { s1: 1 }, projects }).section).toBe('pinned')
    expect(sessionSectionOf('s2', { pins: {}, projects })).toEqual({
      section: 'project',
      groupId: 'child'
    })
    expect(sessionSectionOf('s9', { pins: {}, projects }).section).toBe('recent')
  })
})

describe('sessionsByGroup', () => {
  it('buckets sessions per group and skips unknown groups', () => {
    const map = sessionsByGroup(projects)
    expect(map.get('root')).toEqual(['s1'])
    expect(map.get('child')).toEqual(['s2'])
    expect(map.get('other')).toBeUndefined()
  })
})

describe('groupSubtreeIds', () => {
  it('walks the whole subtree once', () => {
    expect(groupSubtreeIds(projects, 'root')).toEqual(new Set(['root', 'child']))
    expect(groupSubtreeIds(projects, 'other')).toEqual(new Set(['other']))
    expect(groupSubtreeIds(projects, 'missing')).toEqual(new Set())
  })
})

describe('collectGroupDigests', () => {
  const sessionsOf = new Map([
    ['root', [{ id: 's1', updatedAtMs: 10 }]],
    ['child', [{ id: 's2', updatedAtMs: 99 }]]
  ])
  const draftsOf = new Map([['child', [{ id: 'd1', text: '还没发出去的话' }]]])

  it('aggregates the whole subtree, most recent first', () => {
    const digests = collectGroupDigests({
      projects,
      sessionsByGroup: sessionsOf,
      draftsByGroup: draftsOf
    })
    expect(digests.get('root')).toEqual({
      count: 3,
      latestAt: 99,
      sessions: [
        { id: 's2', updatedAtMs: 99 },
        { id: 's1', updatedAtMs: 10 }
      ],
      drafts: [{ id: 'd1', text: '还没发出去的话' }]
    })
    // 叶子分组只算自己那一层
    expect(digests.get('child').count).toBe(2)
    // 空分组也在表里，只是什么都没有——分组头据此决定画不画摘要
    expect(digests.get('other').count).toBe(0)
  })

  it('reports an empty subtree as zero instead of a bogus timestamp', () => {
    const digests = collectGroupDigests({
      projects,
      sessionsByGroup: new Map(),
      draftsByGroup: new Map()
    })
    expect(digests.get('root')).toEqual({ count: 0, latestAt: 0, sessions: [], drafts: [] })
  })
})

describe('resolveGroupCwd', () => {
  const sessions = [
    { id: 's1', cwd: '/work/old', updatedAtMs: 10 },
    { id: 's2', cwd: '/work/new', updatedAtMs: 99 },
    { id: 's3', cwd: '/work/unassigned', updatedAtMs: 500 }
  ]

  it('uses the most recent session in the group subtree', () => {
    expect(resolveGroupCwd(projects, sessions, 'root')).toBe('/work/new')
    expect(resolveGroupCwd(projects, sessions, 'child')).toBe('/work/new')
    expect(resolveGroupCwd(projects, sessions, 'other')).toBeNull()
  })

  it('falls back to the parent group when the group itself is empty', () => {
    const nested = {
      groups: [
        { id: 'root', name: '根', parentId: null },
        { id: 'empty', name: '空', parentId: 'root' }
      ],
      assignments: { s1: 'root' }
    }
    expect(resolveGroupCwd(nested, sessions, 'empty')).toBe('/work/old')
  })

  it('ignores sessions without a usable cwd', () => {
    const nested = { groups: [{ id: 'root', parentId: null }], assignments: { s1: 'root' } }
    expect(resolveGroupCwd(nested, [{ id: 's1', cwd: '  ', updatedAtMs: 1 }], 'root')).toBeNull()
  })
})
