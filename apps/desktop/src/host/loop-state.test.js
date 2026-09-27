import { describe, expect, it } from 'bun:test'
import {
  bindLoopSession,
  catchUpLoops,
  dueLoop,
  emptyLoops,
  findLoop,
  markLoopFired,
  markLoopSkipped,
  nextLoopDueAt,
  normalizeLoops,
  removeLoop,
  removeLoopsForSession,
  setLoopInterval,
  setLoopStatus,
  setLoopTask,
  startLoop
} from './loop-state'

const NOW = 1_700_000_000_000
const MINUTE = 60_000

function loop(overrides = {}) {
  const result = startLoop(emptyLoops(), {
    nodeId: 'node-1',
    intervalMs: 10 * MINUTE,
    task: '推送一条 AI 新闻',
    now: NOW,
    ...overrides
  })
  if (!result.ok) throw new Error(result.error)
  return result.loops
}

describe('normalizeLoops', () => {
  it('falls back to an empty list for missing or garbage input', () => {
    expect(normalizeLoops(null)).toEqual(emptyLoops())
    expect(normalizeLoops({ loops: 'nope' })).toEqual(emptyLoops())
    expect(normalizeLoops({ loops: [null, 42, {}] })).toEqual(emptyLoops())
  })

  it('drops entries without a node, task or a usable interval', () => {
    const normalized = normalizeLoops({
      loops: [
        { nodeId: 'a', task: 't', intervalMs: 5_000 },
        { nodeId: '', task: 't', intervalMs: 60_000 },
        { nodeId: 'c', task: '   ', intervalMs: 60_000 },
        { nodeId: 'd', task: 't', intervalMs: 60_000 }
      ]
    })
    expect(normalized.loops.map((item) => item.nodeId)).toEqual(['d'])
  })

  it('clamps the interval to the setTimeout-safe ceiling', () => {
    const normalized = normalizeLoops({
      loops: [{ nodeId: 'a', task: 't', intervalMs: 10 * 365 * 24 * 3_600_000 }]
    })
    expect(normalized.loops[0].intervalMs).toBe(7 * 24 * 3_600_000)
  })

  it('keeps only the first entry per node', () => {
    const normalized = normalizeLoops({
      loops: [
        { nodeId: 'a', task: 'first', intervalMs: 60_000 },
        { nodeId: 'a', task: 'second', intervalMs: 60_000 }
      ]
    })
    expect(normalized.loops).toHaveLength(1)
    expect(normalized.loops[0].task).toBe('first')
  })

  it('collapses a paused loop to no next fire time and re-derives it when active', () => {
    const paused = normalizeLoops({
      loops: [{ nodeId: 'a', task: 't', intervalMs: 60_000, status: 'paused', nextFireAt: 123 }]
    })
    expect(paused.loops[0].nextFireAt).toBeNull()
    expect(findLoop(paused, 'a').status).toBe('paused')

    const active = normalizeLoops({ loops: [{ nodeId: 'a', task: 't', intervalMs: 60_000 }] })
    expect(typeof active.loops[0].nextFireAt).toBe('number')
  })

  it('flattens a multi-line task so the sidebar row stays single-line', () => {
    const normalized = normalizeLoops({
      loops: [{ nodeId: 'a', task: '  第一行\n\n第二行  ', intervalMs: 60_000 }]
    })
    expect(normalized.loops[0].task).toBe('第一行 第二行')
  })
})

describe('startLoop', () => {
  it('creates a loop that is due immediately so the first run does not wait an interval', () => {
    const loops = loop()
    expect(loops.loops).toHaveLength(1)
    const created = findLoop(loops, 'node-1')
    expect(created).toMatchObject({ fireCount: 0, status: 'active', nextFireAt: NOW })
    expect(dueLoop(loops, NOW)?.nodeId).toBe('node-1')
  })

  it('works on a draft node that has no session yet', () => {
    const created = findLoop(loop(), 'node-1')
    expect(created.sessionId).toBeNull()
    expect(created.cwd).toBeNull()
  })

  it('replaces an existing loop for the same node instead of stacking two', () => {
    const first = loop()
    const second = startLoop(first, { nodeId: 'node-1', intervalMs: 60 * MINUTE, task: '新任务', now: NOW })
    expect(second.ok).toBe(true)
    expect(second.replaced).toBe(true)
    expect(second.loops.loops).toHaveLength(1)
    expect(findLoop(second.loops, 'node-1')).toMatchObject({ task: '新任务', intervalMs: 60 * MINUTE, fireCount: 0 })
  })

  it('rejects an interval below the floor or an empty task', () => {
    expect(startLoop(emptyLoops(), { nodeId: 'a', intervalMs: 1_000, task: 't', now: NOW }).ok).toBe(false)
    expect(startLoop(emptyLoops(), { nodeId: 'a', intervalMs: MINUTE, task: '  ', now: NOW }).ok).toBe(false)
  })
})

describe('bindLoopSession', () => {
  it('attaches the session id once the draft produces one', () => {
    const bound = bindLoopSession(loop(), 'node-1', 'sess-9')
    expect(findLoop(bound, 'node-1').sessionId).toBe('sess-9')
  })

  it('is a no-op when nothing changes', () => {
    const original = loop()
    const bound = bindLoopSession(original, 'node-1', 'sess-9')
    expect(bindLoopSession(bound, 'node-1', 'sess-9')).toBe(bound)
    expect(bindLoopSession(original, 'unknown', 'sess-9')).toBe(original)
    expect(bindLoopSession(original, 'node-1', '')).toBe(original)
  })
})

describe('status transitions', () => {
  it('pausing clears the timer and resuming re-times from now', () => {
    const paused = setLoopStatus(loop(), 'node-1', 'paused', NOW + 5 * MINUTE)
    expect(findLoop(paused.loops, 'node-1')).toMatchObject({ status: 'paused', nextFireAt: null })
    expect(nextLoopDueAt(paused.loops)).toBeNull()

    const resumed = setLoopStatus(paused.loops, 'node-1', 'active', NOW + 9 * MINUTE)
    expect(findLoop(resumed.loops, 'node-1').nextFireAt).toBe(NOW + 19 * MINUTE)
  })

  it('rejects an unknown status or node', () => {
    expect(setLoopStatus(loop(), 'node-1', 'weird').ok).toBe(false)
    expect(setLoopStatus(loop(), 'nope', 'active').ok).toBe(false)
  })
})

describe('setLoopInterval', () => {
  it('re-times from now so changing the interval does not fire instantly', () => {
    const result = setLoopInterval(loop(), 'node-1', 30 * MINUTE, NOW + MINUTE)
    expect(result.ok).toBe(true)
    expect(findLoop(result.loops, 'node-1')).toMatchObject({
      intervalMs: 30 * MINUTE,
      nextFireAt: NOW + MINUTE + 30 * MINUTE
    })
  })

  it('keeps a paused loop paused', () => {
    const paused = setLoopStatus(loop(), 'node-1', 'paused', NOW).loops
    const result = setLoopInterval(paused, 'node-1', 30 * MINUTE, NOW)
    expect(findLoop(result.loops, 'node-1').nextFireAt).toBeNull()
  })

  it('rejects an out-of-range interval', () => {
    expect(setLoopInterval(loop(), 'node-1', 1_000).ok).toBe(false)
    expect(setLoopInterval(loop(), 'node-1', 30 * 24 * 3_600_000).ok).toBe(false)
  })
})

describe('setLoopTask', () => {
  it('updates the task and rejects an empty one', () => {
    const result = setLoopTask(loop(), 'node-1', '  换成新任务  ')
    expect(findLoop(result.loops, 'node-1').task).toBe('换成新任务')
    expect(setLoopTask(loop(), 'node-1', '   ').ok).toBe(false)
  })
})

describe('markLoopFired / markLoopSkipped', () => {
  it('counts a fire and schedules from the fire time', () => {
    const fired = markLoopFired(loop(), 'node-1', { at: NOW + 1_000 })
    expect(findLoop(fired, 'node-1')).toMatchObject({
      fireCount: 1,
      lastFireAt: NOW + 1_000,
      nextFireAt: NOW + 1_000 + 10 * MINUTE,
      lastError: null
    })
  })

  it('records the failure reason of a fired round', () => {
    const failed = markLoopFired(loop(), 'node-1', { at: NOW, error: '模型不可用' })
    expect(findLoop(failed, 'node-1').lastError).toBe('模型不可用')
  })

  it('a skip does not consume a round and only pushes the next fire', () => {
    const skipped = markLoopSkipped(loop(), 'node-1', { at: NOW + 2_000, error: '会话正在运行，本次已跳过' })
    expect(findLoop(skipped, 'node-1')).toMatchObject({
      fireCount: 0,
      lastFireAt: null,
      nextFireAt: NOW + 2_000 + 10 * MINUTE,
      lastError: '会话正在运行，本次已跳过'
    })
  })

  it('does not reschedule a paused loop', () => {
    const paused = setLoopStatus(loop(), 'node-1', 'paused', NOW).loops
    expect(findLoop(markLoopFired(paused, 'node-1', { at: NOW }), 'node-1').nextFireAt).toBeNull()
  })

  it('ignores an unknown node', () => {
    const loops = loop()
    expect(markLoopFired(loops, 'nope')).toBe(loops)
    expect(markLoopSkipped(loops, 'nope')).toBe(loops)
  })
})

describe('dueLoop / nextLoopDueAt', () => {
  it('picks the earliest due loop only', () => {
    let loops = loop()
    loops = startLoop(loops, { nodeId: 'node-2', intervalMs: 60 * MINUTE, task: 'b', now: NOW + 5 * MINUTE }).loops
    expect(dueLoop(loops, NOW)?.nodeId).toBe('node-1')
    // 两个都已到期时仍取最早的那个，保证 tick 逐轮串行推进
    expect(dueLoop(loops, NOW + 10 * MINUTE)?.nodeId).toBe('node-1')
    expect(dueLoop({ version: 1, loops: loops.loops.slice(1) }, NOW + 10 * MINUTE)?.nodeId).toBe('node-2')
    expect(dueLoop(loops, NOW - 1)).toBeNull()
  })

  it('reports the earliest next fire across loops', () => {
    let loops = loop()
    loops = startLoop(loops, { nodeId: 'node-2', intervalMs: 60 * MINUTE, task: 'b', now: NOW + 5 * MINUTE }).loops
    expect(nextLoopDueAt(loops)).toBe(NOW)
    expect(nextLoopDueAt(emptyLoops())).toBeNull()
  })
})

describe('removal', () => {
  it('removes a single loop by node', () => {
    expect(removeLoop(loop(), 'node-1').loops).toHaveLength(0)
    expect(removeLoop(loop(), 'other').loops).toHaveLength(1)
  })

  it('removes the loop bound to a deleted session', () => {
    const original = loop()
    const bound = bindLoopSession(original, 'node-1', 'sess-9')
    expect(removeLoopsForSession(bound, 'sess-9').loops).toHaveLength(0)
    // 尚未绑定会话的草稿循环不按 sessionId 命中，保留原对象以免触发无意义的重渲染
    expect(removeLoopsForSession(original, 'sess-9')).toBe(original)
  })
})

describe('catchUpLoops', () => {
  it('brings overdue loops to fire once instead of replaying every missed round', () => {
    const loops = markLoopFired(loop(), 'node-1', { at: NOW })
    const caught = catchUpLoops(loops, NOW + 10 * 24 * 3_600_000)
    expect(findLoop(caught, 'node-1').nextFireAt).toBe(NOW + 10 * 24 * 3_600_000)
    expect(findLoop(caught, 'node-1').fireCount).toBe(1)
  })

  it('leaves a future loop untouched and reports no change', () => {
    const loops = markLoopFired(loop(), 'node-1', { at: NOW })
    expect(catchUpLoops(loops, NOW + MINUTE)).toBe(loops)
  })

  it('ignores paused loops', () => {
    const paused = setLoopStatus(loop(), 'node-1', 'paused', NOW).loops
    expect(catchUpLoops(paused, NOW + 10 * 24 * 3_600_000)).toBe(paused)
  })
})
