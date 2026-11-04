import { describe, expect, it } from 'bun:test'
import { groupChain, planSessionReveal, sessionParentChain } from './session-reveal'

const session = (id, extra = {}) => ({ id, updatedAtMs: 0, ...extra })

const projects = (groups, assignments = {}) => ({ groups, assignments })

describe('groupChain', () => {
  it('returns ancestors from the outermost group inwards', () => {
    const tree = projects([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B', parentId: 'a' },
      { id: 'c', name: 'C', parentId: 'b' }
    ])
    expect(groupChain(tree, 'c')).toEqual(['a', 'b', 'c'])
  })

  it('survives a group loop without repeating ids', () => {
    const tree = projects([
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' }
    ])
    expect(groupChain(tree, 'a')).toEqual(['b', 'a'])
  })

  it('returns nothing for a missing group', () => {
    expect(groupChain(projects([]), 'nope')).toEqual([])
  })
})

describe('sessionParentChain', () => {
  it('walks up the fork chain', () => {
    const sessions = [
      session('root'),
      session('mid', { parentSessionId: 'root' }),
      session('leaf', { parentSessionId: 'mid' })
    ]
    expect(sessionParentChain(sessions, 'leaf')).toEqual(['root', 'mid'])
  })

  it('stops at a parent that is not in the list', () => {
    expect(sessionParentChain([session('child', { parentSessionId: 'gone' })], 'child')).toEqual([])
  })
})

describe('planSessionReveal', () => {
  it('expands the section, group chain and collapsed fork ancestors', () => {
    const sessions = [
      session('root', { parentSessionId: null }),
      session('mid', { parentSessionId: 'root' }),
      session('leaf', { parentSessionId: 'mid' })
    ]
    const tree = projects(
      [
        { id: 'outer', name: 'Outer' },
        { id: 'inner', name: 'Inner', parentId: 'outer' }
      ],
      // 归属记在可见的根会话上：派生会话跟着它的根（侧栏里也只有根会落进分组）。
      { root: 'inner' }
    )
    const plan = planSessionReveal({
      sessionId: 'leaf',
      sessions,
      projects: tree,
      pins: {},
      collapsedSections: { project: true },
      collapsedGroups: { outer: true, inner: true },
      collapsedChildren: ['root'],
      recentCandidates: [],
      recentLimit: 6
    })
    expect(plan).toEqual({
      key: 's:leaf',
      section: 'project',
      expandSection: true,
      expandGroups: ['outer', 'inner'],
      expandParents: ['root'],
      recentLimit: null
    })
  })

  it('only reports what is actually collapsed', () => {
    const plan = planSessionReveal({
      sessionId: 'a',
      sessions: [session('a')],
      collapsedSections: { recent: false },
      collapsedGroups: {},
      recentCandidates: [session('a')],
      recentLimit: 6
    })
    expect(plan.expandSection).toBe(false)
    expect(plan.expandGroups).toEqual([])
    expect(plan.expandParents).toEqual([])
    expect(plan.recentLimit).toBeNull()
  })

  it('raises the Recent page limit so the target tree is rendered', () => {
    const recent = ['r1', 'r2', 'c2', 'r3', 'r4'].map((id) =>
      id === 'c2' ? session(id, { parentSessionId: 'r2' }) : session(id)
    )
    const plan = planSessionReveal({
      sessionId: 'c2',
      sessions: recent,
      recentCandidates: recent,
      recentLimit: 1
    })
    // 第 2 棵树（r2 + c2）要露出来，所以上限至少是 2。
    expect(plan.section).toBe('recent')
    expect(plan.recentLimit).toBe(2)
  })

  it('follows the section of the tree root for derived sessions', () => {
    const sessions = [session('root'), session('child', { parentSessionId: 'root' })]
    const plan = planSessionReveal({
      sessionId: 'child',
      sessions,
      pins: { root: 1 },
      recentCandidates: [],
      recentLimit: 6
    })
    expect(plan.section).toBe('pinned')
  })

  it('reveals a draft inside its group', () => {
    const tree = projects([{ id: 'g', name: 'G' }], {})
    const plan = planSessionReveal({
      nodeId: 'node-1',
      draftGroupId: 'g',
      projects: tree,
      collapsedSections: { project: true },
      collapsedGroups: { g: true }
    })
    expect(plan).toEqual({
      key: 'd:node-1',
      section: 'project',
      expandSection: true,
      expandGroups: ['g'],
      expandParents: [],
      recentLimit: null
    })
  })

  it('returns null without a target', () => {
    expect(planSessionReveal({})).toBeNull()
  })
})
