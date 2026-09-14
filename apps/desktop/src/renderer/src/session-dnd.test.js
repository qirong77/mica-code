import { describe, expect, it } from 'bun:test'
import { byUpdatedDesc, orderSessions, resolveDrop } from './session-dnd'

const sessions = [
  { id: 'a', cwd: '/w/one', updatedAtMs: 3 },
  { id: 'b', cwd: '/w/one', updatedAtMs: 2 },
  { id: 'c', cwd: '/w/two', updatedAtMs: 1 }
]

describe('orderSessions', () => {
  it('keeps the manual order and appends unknown sessions by fallback', () => {
    expect(orderSessions(sessions, ['b'], byUpdatedDesc).map((s) => s.id)).toEqual(['b', 'a', 'c'])
    expect(orderSessions(sessions, ['c', 'a', 'b'], byUpdatedDesc).map((s) => s.id)).toEqual([
      'c',
      'a',
      'b'
    ])
  })
})

describe('resolveDrop', () => {
  const dragFrom = (section, id, groupId = null, kind = 'session') => ({
    kind,
    id,
    section,
    groupId
  })

  it('moves a session between sections instead of duplicating it', () => {
    expect(
      resolveDrop({
        drag: dragFrom('recent', 'a'),
        section: 'pinned',
        targetId: 'b',
        groupId: null
      })
    ).toEqual({ kind: 'move', target: { section: 'pinned', groupId: null } })
  })

  it('moves a session into a project group row', () => {
    expect(
      resolveDrop({
        drag: dragFrom('recent', 'a'),
        section: 'project',
        targetId: null,
        groupId: 'g1'
      })
    ).toEqual({ kind: 'move', target: { section: 'project', groupId: 'g1' } })
  })

  it('moves a session from a group back to recent', () => {
    expect(
      resolveDrop({ drag: dragFrom('project', 'a', 'g1'), section: 'recent', targetId: null })
    ).toEqual({ kind: 'move', target: { section: 'recent', groupId: null } })
  })

  it('reorders inside the same section when the working directory matches', () => {
    expect(
      resolveDrop({
        drag: dragFrom('pinned', 'a'),
        section: 'pinned',
        targetId: 'b',
        items: sessions,
        order: [],
        position: 'after'
      })
    ).toEqual({ kind: 'reorder', ids: ['b', 'a', 'c'] })
  })

  it('refuses to reorder across working directories or within recent', () => {
    expect(
      resolveDrop({
        drag: dragFrom('pinned', 'a'),
        section: 'pinned',
        targetId: 'c',
        items: sessions,
        position: 'before'
      })
    ).toBeNull()
    expect(
      resolveDrop({
        drag: dragFrom('recent', 'a'),
        section: 'recent',
        targetId: 'b',
        items: sessions
      })
    ).toBeNull()
  })

  it('ignores a drop onto itself and drops onto a draft row in the same group', () => {
    expect(
      resolveDrop({ drag: dragFrom('pinned', 'a'), section: 'pinned', targetId: 'a' })
    ).toBeNull()
    // 草稿行还没有 sessionId，同分组内不参与排序（但落到别的分区仍然是一次移动）
    expect(
      resolveDrop({
        drag: dragFrom('project', 'a', 'g1'),
        section: 'project',
        targetId: 'draft-1',
        groupId: 'g1',
        items: sessions
      })
    ).toBeNull()
  })

  it('drops nothing when there is no drag in flight', () => {
    expect(resolveDrop({ drag: null, section: 'pinned', targetId: 'a' })).toBeNull()
  })

  describe('dragging a group', () => {
    const groups = [
      { id: 'g1', parentId: null },
      { id: 'g2', parentId: 'g1' },
      { id: 'g3', parentId: 'g2' },
      { id: 'g4', parentId: null }
    ]
    const dragGroup = (id, parentId = null) => ({
      kind: 'group',
      id,
      section: 'project',
      groupId: parentId
    })

    it('nests a group under the group row it was dropped on', () => {
      expect(
        resolveDrop({ drag: dragGroup('g4'), section: 'project', groupId: 'g1', groups })
      ).toEqual({ kind: 'move-group', groupId: 'g4', parentId: 'g1' })
    })

    it('moves a group back to the root when dropped on the Projects header', () => {
      expect(resolveDrop({ drag: dragGroup('g3', 'g2'), section: 'project', groups })).toEqual({
        kind: 'move-group',
        groupId: 'g3',
        parentId: null
      })
    })

    it('refuses itself, its own subtree, its current parent and other sections', () => {
      // 自己
      expect(
        resolveDrop({ drag: dragGroup('g1'), section: 'project', groupId: 'g1', groups })
      ).toBeNull()
      // 自己的后代（会成环）
      expect(
        resolveDrop({ drag: dragGroup('g1'), section: 'project', groupId: 'g3', groups })
      ).toBeNull()
      // 已经在那个父级下
      expect(
        resolveDrop({ drag: dragGroup('g3', 'g2'), section: 'project', groupId: 'g2', groups })
      ).toBeNull()
      // 分区标题只接会话
      expect(resolveDrop({ drag: dragGroup('g1'), section: 'recent', groups })).toBeNull()
    })
  })
})
