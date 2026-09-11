import { describe, expect, it } from 'bun:test'
import {
  assignmentOf,
  createGroup,
  deleteGroup,
  emptyProjects,
  groupSubtreeIds,
  normalizeProjects,
  renameGroup,
  setAssignment
} from './session-projects'

describe('normalizeProjects', () => {
  it('drops malformed groups and dangling assignments', () => {
    const projects = normalizeProjects({
      groups: [
        { id: 'a', name: ' A ', parentId: null, createdAt: 1 },
        { id: 'a', name: 'dupe' },
        { id: '', name: 'blank' },
        { id: 'b', parentId: 'missing' },
        { name: 'no id' }
      ],
      assignments: { s1: 'a', s2: 'ghost', s3: 42 }
    })

    expect(projects.groups.map((group) => group.id)).toEqual(['a', 'b'])
    expect(projects.groups[0].name).toBe('A')
    expect(projects.groups[1].name).toBe('未命名分组')
    expect(projects.groups[1].parentId).toBeNull()
    expect(projects.assignments).toEqual({ s1: 'a' })
  })

  it('breaks parent cycles instead of hanging', () => {
    const projects = normalizeProjects({
      groups: [
        { id: 'a', parentId: 'b' },
        { id: 'b', parentId: 'a' }
      ]
    })
    const roots = projects.groups.filter((group) => !group.parentId)
    expect(roots).toHaveLength(1)
    expect(groupSubtreeIds(projects, roots[0].id)).toEqual(new Set(['a', 'b']))
  })

  it('returns an empty store for garbage input', () => {
    expect(normalizeProjects(null)).toEqual(emptyProjects())
    expect(normalizeProjects({ groups: 'nope' }).groups).toEqual([])
  })
})

describe('group tree edits', () => {
  it('creates nested groups and reports the subtree', () => {
    let projects = createGroup(emptyProjects(), { id: 'root', name: '根' })
    projects = createGroup(projects, { id: 'child', name: '子', parentId: 'root' })
    projects = createGroup(projects, { id: 'grand', name: '孙', parentId: 'child' })

    expect(groupSubtreeIds(projects, 'root')).toEqual(new Set(['root', 'child', 'grand']))
    expect(groupSubtreeIds(projects, 'child')).toEqual(new Set(['child', 'grand']))
  })

  it('falls back to the root when the parent is unknown', () => {
    const projects = createGroup(emptyProjects(), { id: 'x', name: 'X', parentId: 'nope' })
    expect(projects.groups[0].parentId).toBeNull()
  })

  it('renames a group and ignores empty names', () => {
    const projects = createGroup(emptyProjects(), { id: 'a', name: '旧' })
    expect(renameGroup(projects, 'a', ' 新 ').groups[0].name).toBe('新')
    expect(renameGroup(projects, 'a', '   ').groups[0].name).toBe('旧')
  })

  it('deletes the whole subtree and releases its sessions', () => {
    let projects = createGroup(emptyProjects(), { id: 'root', name: '根' })
    projects = createGroup(projects, { id: 'child', name: '子', parentId: 'root' })
    projects = setAssignment(projects, 's1', 'root')
    projects = setAssignment(projects, 's2', 'child')
    projects = setAssignment(projects, 's3', null)

    const after = deleteGroup(projects, 'root')
    expect(after.groups).toEqual([])
    expect(after.assignments).toEqual({})
    expect(assignmentOf(after, 's1')).toBeNull()
  })

  it('assigns a session to one group at a time', () => {
    let projects = createGroup(emptyProjects(), { id: 'a', name: 'A' })
    projects = createGroup(projects, { id: 'b', name: 'B' })
    projects = setAssignment(projects, 's1', 'a')
    expect(assignmentOf(projects, 's1')).toBe('a')
    projects = setAssignment(projects, 's1', 'b')
    expect(assignmentOf(projects, 's1')).toBe('b')
    projects = setAssignment(projects, 's1', null)
    expect(assignmentOf(projects, 's1')).toBeNull()
    expect(setAssignment(projects, 's1', 'ghost').assignments).toEqual({})
  })
})
