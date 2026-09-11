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
})
