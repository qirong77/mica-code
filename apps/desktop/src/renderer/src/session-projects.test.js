import { describe, expect, it } from 'bun:test'
import {
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
