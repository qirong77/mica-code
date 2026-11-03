import { describe, expect, it } from 'bun:test'
import {
  branchOptions,
  filterCommits,
  formatChangeCounts,
  layoutGraph,
  mergeHistory
} from './git-graph'

const commit = (hash, parents) => ({ hash, parents })

describe('mergeHistory', () => {
  it('保留已加载的 2000 条并追加下一页，切换历史时替换旧内容', () => {
    const first = Array.from({ length: 2000 }, (_, i) => commit(String(i), []))
    const previous = { commits: first, head: 'old', branch: 'old', more: true }
    const next = mergeHistory(
      previous,
      { commits: [commit('2000', [])], head: 'new', more: false },
      2000
    )
    expect(next.commits).toHaveLength(2001)
    expect(next.commits[2000].hash).toBe('2000')
    expect(next.more).toBe(false)
    expect(
      mergeHistory(next, { commits: [commit('other', [])] }, 0).commits.map((entry) => entry.hash)
    ).toEqual(['other'])
  })
})

function edgePairs(row) {
  return row.edges.map((edge) => `${edge.from.join(',')}→${edge.to.join(',')}`)
}

describe('layoutGraph', () => {
  it('线性历史只有一条泳道，段段相接', () => {
    const rows = layoutGraph([commit('c', ['b']), commit('b', ['a']), commit('a', [])])
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0])
    expect(rows.map((row) => row.laneCount)).toEqual([1, 1, 1])
    expect(edgePairs(rows[0])).toEqual(['0,0.5→0,1'])
    expect(edgePairs(rows[2])).toEqual(['0,0→0,0.5'])
    // 同一条泳道颜色不变
    expect(new Set(rows.map((row) => row.color)).size).toBe(1)
  })

  it('合并提交给第二个父提交开新泳道，汇合处画到原泳道', () => {
    const rows = layoutGraph([
      commit('m', ['x', 'y']),
      commit('x', ['z']),
      commit('y', ['z']),
      commit('z', [])
    ])
    expect(rows[0]).toMatchObject({ lane: 0, laneCount: 2 })
    expect(rows[0].color).not.toBe(rows[1].edges[0].color)
    // m 行：第二个父提交从自己那条新泳道下来（0.5 → 1）
    expect(edgePairs(rows[0]).sort()).toEqual(['0,0.5→0,1', '0,0.5→1,1', '1,0.5→1,1'])
    expect(rows[2]).toMatchObject({ hash: 'y', lane: 1 })
    // y 行：汇入 z 所在的第 0 条泳道
    expect(edgePairs(rows[2])).toContain('1,0.5→0,1')
    expect(edgePairs(rows[2])).toContain('0,0→0,1')
    // z 之后只剩一条
    expect(rows[3]).toMatchObject({ lane: 0, laneCount: 1 })
  })

  it('被过滤掉的提交另开泳道，不丢行', () => {
    const rows = layoutGraph([commit('c', ['a']), commit('a', [])])
    expect(rows.map((row) => row.lane)).toEqual([0, 0])
    expect(rows.map((row) => row.laneCount)).toEqual([1, 1])
  })

  it('没有提交时返回空数组', () => {
    expect(layoutGraph([])).toEqual([])
    expect(layoutGraph(null)).toEqual([])
  })

  it('多个分支并存时泳道数与颜色都稳定增长', () => {
    const rows = layoutGraph([
      commit('a', ['d']),
      commit('b', ['d']),
      commit('c', ['d']),
      commit('d', [])
    ])
    expect(rows[0].laneCount).toBe(1)
    expect(rows[1].laneCount).toBe(2)
    expect(rows[1].lane).toBe(1)
    // 同父的两个兄弟提交不在同一时刻存在，复用刚空出来的泳道即可
    expect(rows[2].laneCount).toBe(2)
    expect(rows[2].lane).toBe(1)
    expect(rows[3].lane).toBe(0)
    expect(new Set(rows.map((row) => row.color)).size).toBe(3)
  })
})

describe('filterCommits', () => {
  const commits = [
    { hash: 'aaaa1111', shortHash: 'aaaa111', subject: 'feat: 编辑器', author: 'Ann' },
    { hash: 'bbbb2222', shortHash: 'bbbb222', subject: 'fix: git graph', author: 'Bob' }
  ]

  it('空查询原样返回', () => {
    expect(filterCommits(commits, '  ')).toBe(commits)
  })

  it('按说明、作者、短哈希都能命中，且不区分大小写', () => {
    expect(filterCommits(commits, 'GRAPH')).toHaveLength(1)
    expect(filterCommits(commits, 'ann')).toHaveLength(1)
    expect(filterCommits(commits, 'bbbb')).toHaveLength(1)
    expect(filterCommits(commits, 'zzz')).toHaveLength(0)
  })
})

describe('formatChangeCounts', () => {
  it('给增删统计，二进制与无变化给破折号', () => {
    expect(formatChangeCounts({ additions: 12, deletions: 3 })).toBe('+12 −3')
    expect(formatChangeCounts({ additions: 0, deletions: 0 })).toBe('—')
    expect(formatChangeCounts({ binary: true })).toBe('—')
    expect(formatChangeCounts(null)).toBe('—')
  })
})

describe('branchOptions', () => {
  const refs = {
    branches: [
      { name: 'main', ref: 'refs/heads/main', kind: 'branch', current: true },
      { name: 'origin/main', ref: 'refs/remotes/origin/main', kind: 'remote' },
      {
        name: 'origin/feat/ai/a/multi-turn',
        ref: 'refs/remotes/origin/feat/ai/a/multi-turn',
        kind: 'remote'
      }
    ]
  }

  it('「全部分支」在最前，本地与远端分组排列', () => {
    expect(branchOptions(refs).map((item) => [item.value, item.group])).toEqual([
      ['', undefined],
      ['refs/heads/main', '本地分支'],
      ['refs/remotes/origin/main', '远端分支'],
      ['refs/remotes/origin/feat/ai/a/multi-turn', '远端分支']
    ])
  })

  it('当前分支在标签上标出来，值仍是 git 认得的全名', () => {
    expect(branchOptions(refs)[1]).toEqual({
      value: 'refs/heads/main',
      label: 'main（当前）',
      group: '本地分支'
    })
  })

  it('没有 refs 时只剩「全部分支」', () => {
    expect(branchOptions(null)).toEqual([{ value: '', label: '全部分支' }])
  })
})
