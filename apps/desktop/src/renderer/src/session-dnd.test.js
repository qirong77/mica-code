import { describe, expect, it } from 'bun:test'
import {
  byUpdatedDesc,
  groupRowDrop,
  orderSessions,
  resolveDrop,
  rowDropPosition,
  sessionRowDropPosition
} from './session-dnd'

describe('sessionRowDropPosition', () => {
  const drag = { kind: 'session', id: 'a', parentSessionId: 'parent' }
  const position = (ratio, extra = {}) =>
    sessionRowDropPosition({ ratio, drag, targetId: 'b', descendantIds: new Set(), ...extra })

  it('uses the current pointer position for nesting and ordering', () => {
    expect(position(0.1)).toBe('before')
    expect(position(0.5)).toBe('into')
    expect(position(0.9)).toBe('after')
  })

  it('uses the entire row for ordering when nesting is not allowed', () => {
    expect(position(0.4, { targetId: 'parent' })).toBe('before')
    expect(position(0.6, { descendantIds: new Set(['b']) })).toBe('after')
    expect(position(0.4, { canNestInto: false })).toBe('before')
    expect(position(0.6, { drag: { kind: 'draft', id: 'a' } })).toBe('after')
  })
})

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

  it('reorders inside the same section', () => {
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

  it('reorders across working directories but never inside recent', () => {
    // 侧栏是用户自己的清单：不同工作目录的会话照样能前后挪
    expect(
      resolveDrop({
        drag: dragFrom('pinned', 'a'),
        section: 'pinned',
        targetId: 'c',
        items: sessions,
        position: 'before'
      })
    ).toEqual({ kind: 'reorder', ids: ['b', 'a', 'c'] })
    // Recent 按时间排，不参与手动排序
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

  describe('dragging a session into another session', () => {
    const childDrag = (section, id, groupId, parentSessionId) => ({
      ...dragFrom(section, id, groupId),
      parentSessionId
    })

    it('nests under the row dropped on the middle', () => {
      expect(
        resolveDrop({
          drag: dragFrom('recent', 'a'),
          section: 'recent',
          targetId: 'b',
          position: 'into'
        })
      ).toEqual({ kind: 'nest', parentId: 'b' })
      // 跨分区也是同一个意思：挂到那个会话下面，位置随父会话
      expect(
        resolveDrop({
          drag: dragFrom('recent', 'a'),
          section: 'pinned',
          targetId: 'b',
          position: 'into'
        })
      ).toEqual({ kind: 'nest', parentId: 'b' })
    })

    it('refuses its own subtree and the parent it already has', () => {
      expect(
        resolveDrop({
          drag: dragFrom('recent', 'a'),
          section: 'recent',
          targetId: 'grandchild',
          position: 'into',
          descendantIds: new Set(['child', 'grandchild'])
        })
      ).toBeNull()
      expect(
        resolveDrop({
          drag: childDrag('recent', 'child', null, 'a'),
          section: 'recent',
          targetId: 'a',
          position: 'into'
        })
      ).toBeNull()
    })

    it('never nests a draft, which has no session file yet', () => {
      expect(
        resolveDrop({
          drag: dragFrom('recent', 'draft-1', null, 'draft'),
          section: 'recent',
          targetId: 'a',
          position: 'into'
        })
      ).toBeNull()
    })

    it('lifts a child out of its parent when dropped on a sibling or another section', () => {
      // 同分区：只解除父子关系，不参与手动排序
      expect(
        resolveDrop({
          drag: childDrag('pinned', 'child', null, 'a'),
          section: 'pinned',
          targetId: 'b',
          items: sessions
        })
      ).toEqual({ kind: 'unnest' })
      // 换分区：移动同时也解除父子关系
      expect(
        resolveDrop({
          drag: childDrag('recent', 'child', null, 'a'),
          section: 'pinned',
          targetId: null
        })
      ).toEqual({ kind: 'move', target: { section: 'pinned', groupId: null }, clearParent: true })
    })
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

    it('places groups before or after another group, including across parents', () => {
      for (const position of ['before', 'after']) {
        expect(
          resolveDrop({
            drag: dragGroup('g4'),
            section: 'project',
            groupId: 'g2',
            groups,
            position
          })
        ).toEqual({
          kind: 'move-group',
          groupId: 'g4',
          parentId: 'g1',
          placement: { targetId: 'g2', position }
        })
        expect(
          resolveDrop({
            drag: dragGroup('g1'),
            section: 'project',
            groupId: 'g4',
            groups,
            position
          })
        ).toEqual({
          kind: 'move-group',
          groupId: 'g1',
          parentId: null,
          placement: { targetId: 'g4', position }
        })
        for (const groupId of ['g1', 'g2', 'g3', 'missing']) {
          expect(
            resolveDrop({ drag: dragGroup('g1'), section: 'project', groupId, groups, position })
          ).toBeNull()
        }
      }
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

describe('rowDropPosition', () => {
  it('中间一半是嵌套，上下两头是排到前后', () => {
    expect(rowDropPosition({ ratio: 0.1 })).toBe('before')
    expect(rowDropPosition({ ratio: 0.3 })).toBe('into')
    expect(rowDropPosition({ ratio: 0.5 })).toBe('into')
    expect(rowDropPosition({ ratio: 0.7 })).toBe('into')
    expect(rowDropPosition({ ratio: 0.9 })).toBe('after')
  })

  it('canNest 为 false 时中间也退回排序', () => {
    expect(rowDropPosition({ ratio: 0.5, canNest: false })).toBe('after')
    expect(rowDropPosition({ ratio: 0.2, canNest: false })).toBe('before')
  })

  it('拿不到行高时按中间处理', () => {
    expect(rowDropPosition({ ratio: Number.NaN })).toBe('into')
    expect(rowDropPosition({ ratio: Number.NaN, canNest: false })).toBe('after')
  })
})

describe('groupRowDrop', () => {
  const groups = [
    { id: 'g1', parentId: null },
    { id: 'g2', parentId: null },
    { id: 'g3', parentId: 'g1' }
  ]
  const dragGroup = (id, parentId = null) => ({
    kind: 'group',
    id,
    section: 'project',
    groupId: parentId
  })

  it('兄弟分组整行都能落：上面排序、中间嵌套、下面排序，没有无反应的死区', () => {
    for (const [ratio, expected] of [
      [0.1, 'before'],
      [0.4, 'into'],
      [0.6, 'into'],
      [0.9, 'after']
    ]) {
      expect(groupRowDrop({ ratio, drag: dragGroup('g2'), groupId: 'g1', groups })).toBe(expected)
    }
  })

  it('嵌套不成立时中间那一半退回排序，不会再什么都不发生', () => {
    // g4 与 g3 同级（都在 g1 下）：拖到 g4 上时 into 仍成立，所以换一个 into 被拒的落点——拖到
    // 自己的父分组 g1 上：中间是「已经在内」，上下两头这时才走排序分支，但整行不接（见下一条用例）。
    const nested = [...groups, { id: 'g4', name: 'g4', parentId: 'g1' }]
    expect(rowDropPosition({ ratio: 0.5, canNest: false })).toBe('after')
    expect(rowDropPosition({ ratio: 0.4, canNest: false })).toBe('before')
    expect(
      groupRowDrop({ ratio: 0.5, drag: dragGroup('g4', 'g1'), groupId: 'g1', groups: nested })
    ).toBeNull()
  })

  it('能嵌套时中间一半是「成为子分组」，两头仍是排序', () => {
    expect(groupRowDrop({ ratio: 0.5, drag: dragGroup('g2'), groupId: 'g1', groups })).toBe('into')
    expect(groupRowDrop({ ratio: 0.1, drag: dragGroup('g2'), groupId: 'g1', groups })).toBe(
      'before'
    )
  })

  it('不成立的落点整行都不亮：自己、自己的子树、已经在内、不是分组拖拽', () => {
    for (const ratio of [0.1, 0.5, 0.9]) {
      expect(groupRowDrop({ ratio, drag: dragGroup('g1'), groupId: 'g1', groups })).toBeNull()
      expect(groupRowDrop({ ratio, drag: dragGroup('g1'), groupId: 'g3', groups })).toBeNull()
      expect(groupRowDrop({ ratio, drag: dragGroup('g3', 'g1'), groupId: 'g1', groups })).toBeNull()
      expect(
        groupRowDrop({
          ratio,
          drag: { ...dragGroup('g2'), kind: 'session' },
          groupId: 'g1',
          groups
        })
      ).toBeNull()
    }
  })
})
