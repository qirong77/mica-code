/**
 * 提交图的泳道布局（纯计算，渲染层只负责画）。
 *
 * 输入是 `git:log` 给出的提交（新到旧、拓扑序），输出每一行占哪条泳道、颜色，以及
 * 这一行上下之间要画的线段。坐标用「泳道单位」：x 是泳道序号，y 用 0（行上沿）、
 * 0.5（提交点所在的中线）、1（行下沿），渲染层乘上泳道宽与行高即可。
 */

export const GRAPH_COLORS = [
  '#4f8ff7',
  '#e0873f',
  '#5fb37a',
  '#c96dd8',
  '#d9a13b',
  '#4bb8c4',
  '#e06c75',
  '#8a7ff0',
  '#7fa650',
  '#c07a5a'
]

export function layoutGraph(commits) {
  const lanes = []
  let colorSeq = 0
  const nextColor = () => GRAPH_COLORS[colorSeq++ % GRAPH_COLORS.length]
  const rows = []

  for (const commit of commits || []) {
    const hash = String(commit?.hash || '')
    const parents = (commit?.parents || []).map(String)
    const before = lanes.map((entry) => (entry ? { ...entry } : null))

    // 这条提交本来就在某条泳道上（大多数情况）；它不在，是因为视图按条件裁掉了它的
    // 子提交（搜索、单分支过滤），那就新开一条，别丢弃它。
    let lane = before.findIndex((entry) => entry && entry.hash === hash)
    if (lane < 0) {
      lane = before.indexOf(null)
      if (lane < 0) {
        lane = before.length
        before.push(null)
      }
    }

    const color = before[lane]?.color || nextColor()
    const after = before.map((entry) => (entry ? { ...entry } : null))
    after[lane] = null

    const parentLanes = []
    for (let index = 0; index < parents.length; index += 1) {
      const parent = parents[index]
      const existing = after.findIndex((entry) => entry && entry.hash === parent)
      if (existing >= 0) {
        parentLanes.push({ lane: existing, color: after[existing].color, created: false })
        continue
      }
      let target = lane
      if (index > 0) {
        target = after.indexOf(null)
        if (target < 0) {
          target = after.length
          after.push(null)
        }
      }
      const laneColor = index === 0 ? color : nextColor()
      after[target] = { hash: parent, color: laneColor }
      parentLanes.push({ lane: target, color: laneColor, created: true })
    }

    const laneCount = Math.max(before.length, after.length)
    const edges = []
    for (let index = 0; index < laneCount; index += 1) {
      if (index === lane) continue
      const from = before[index]
      const to = after[index]
      if (from && to) edges.push({ from: [index, 0], to: [index, 1], color: to.color })
      else if (from) edges.push({ from: [index, 0], to: [index, 0.5], color: from.color })
      else if (to) edges.push({ from: [index, 0.5], to: [index, 1], color: to.color })
    }
    if (before[lane]) edges.push({ from: [lane, 0], to: [lane, 0.5], color })
    for (const parent of parentLanes) {
      if (parent.lane === lane) edges.push({ from: [lane, 0.5], to: [lane, 1], color })
      else edges.push({ from: [lane, 0.5], to: [parent.lane, 1], color: parent.color })
    }

    rows.push({ hash, lane, color, laneCount, edges, commit })

    lanes.length = 0
    lanes.push(...after)
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop()
  }

  return rows
}

/** 搜索框：提交说明、作者、短哈希都认。 */
export function filterCommits(commits, query) {
  const needle = String(query || '')
    .trim()
    .toLowerCase()
  if (!needle) return commits || []
  return (commits || []).filter((commit) => {
    const fields = [commit?.subject, commit?.author, commit?.email, commit?.shortHash, commit?.hash]
    return fields.some((field) =>
      String(field || '')
        .toLowerCase()
        .includes(needle)
    )
  })
}

/** 文件行右侧的增删统计：`+12 −3`，二进制给 `—`。 */
export function formatChangeCounts(file) {
  if (!file || file.binary) return '—'
  const additions = Number(file.additions) || 0
  const deletions = Number(file.deletions) || 0
  if (!additions && !deletions) return '—'
  return `+${additions} −${deletions}`
}
/** 合并一页历史；首页替换旧结果，后续页保留已加载的提交。 */
export function mergeHistory(previous, page, skip) {
  return {
    commits: skip ? [...previous.commits, ...(page.commits || [])] : page.commits || [],
    head: page.head || '',
    branch: page.branch || '',
    more: Boolean(page.more)
  }
}

/**
 * 分支下拉的选项：本地与远端分组，当前分支带标记。
 *
 * 大仓库里远端分支动辄几百条（`origin/feat/ai/<人名>/<特性>`），平铺一列既找不到，
 * 原生弹层还会铺满整屏；分组 + 可筛选是这块界面能用的前提。
 */
export function branchOptions(refs) {
  const branches = Array.isArray(refs?.branches) ? refs.branches : []
  const option = (item, group) => ({
    value: item.ref || item.name,
    label: item.current ? `${item.name}（当前）` : item.name,
    group
  })
  return [
    { value: '', label: '全部分支' },
    ...branches.filter((item) => item.kind !== 'remote').map((item) => option(item, '本地分支')),
    ...branches.filter((item) => item.kind === 'remote').map((item) => option(item, '远端分支'))
  ]
}
