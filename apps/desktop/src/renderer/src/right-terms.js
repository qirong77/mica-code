/**
 * 右侧面板终端按会话归属：切换会话时整组切走，因此「当前显示哪个终端」要从
 * 所属会话的列表里推导——用户上次点的那个还在就用它，否则用第一个。
 */
export function activeRightTermId(terms = [], savedId) {
  if (savedId && terms.some((term) => term.id === savedId)) return savedId
  return terms[0]?.id ?? null
}

/** 右侧终端的保留时长与回收扫描间隔 */
export const RIGHT_PANEL_RETAIN_MS = 8 * 60 * 60 * 1000
export const RIGHT_PANEL_SWEEP_MS = 10 * 60 * 1000

/**
 * 会话路径（底部状态栏切换 cwd / 恢复会话）变化后需要重开的终端 id。
 *
 * 只挑记录路径与目标不一致的：路径一致的重开等于白白打断一次 shell。有前台
 * 进程在跑的（notify 的 processRunning）保持不动——用户正在上面做事，重开既
 * 会杀掉进程也会吞掉刚跑完的输出，等他自己 cd 或下次切换会话再说。
 */
export function staleRightTermIds(terms = [], cwd, states = {}) {
  if (!cwd) return []
  return terms
    .filter((term) => term.cwd !== cwd && !states?.[term.id]?.processRunning)
    .map((term) => term.id)
}

/**
 * 定时回收右侧面板终端的候选：会话本身 8h 没被用过，或者终端 8h 没有任何活动
 * （输出、输入、点选都算），对应的 PTY 就该释放——面板按会话分组后，它会随着
 * 点过的会话越积越多。
 *
 * 有前台进程在跑的留着：它还在做事，重开等于把用户跑了一半的命令杀掉。
 */
export function reclaimableRightTermIds({
  terms = [],
  lastUsedAt = 0,
  activityAt = {},
  states = {},
  now = Date.now(),
  retainMs = RIGHT_PANEL_RETAIN_MS
}) {
  const idle = (term) => !states?.[term.id]?.running
  // 会话本身已经放着没用了，它名下的终端整组回收
  if (now - (Number(lastUsedAt) || 0) >= retainMs) {
    return terms.filter(idle).map((term) => term.id)
  }
  // 会话还在用：只回收确实很久没动过的那个终端。查不到活动记录时不动它——
  // 宁可多留一个 PTY，也不要把刚开的终端当成闲置的关掉。
  return terms
    .filter((term) => {
      if (!idle(term)) return false
      const seen = Math.max(
        Number(activityAt[term.id]) || 0,
        Number(states?.[term.id]?.lastEventAt) || 0
      )
      return seen > 0 && now - seen >= retainMs
    })
    .map((term) => term.id)
}
