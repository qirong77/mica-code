import { describe, expect, it } from 'vitest'
import { forkSessionSnapshot } from './chat-session-actions'

describe('forkSessionSnapshot', () => {
  it('creates an independent completed session with copied context', () => {
    const source = {
      version: 1,
      revision: 7,
      id: 'source',
      title: 'Investigate issue',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      cwd: '/tmp/project',
      turnState: 'completed',
      snapshot: {
        messages: [{ role: 'user', content: 'hello' }],
        usageHistory: [{ usageId: 'u1', inputTokens: 100, outputTokens: 10 }],
        subagentUsageHistory: [{ taskId: 't1', requests: [{ usageId: 's1' }] }],
        lastUsage: { usageId: 'u1', inputTokens: 100, outputTokens: 10 }
      }
    }
    const fork = forkSessionSnapshot(source, 'fork-id', '2026-02-01T00:00:00.000Z')

    expect(fork).toMatchObject({
      id: 'fork-id',
      title: 'Investigate issue (fork)',
      titleSource: 'manual',
      revision: 1,
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
      cwd: '/tmp/project',
      turnState: 'completed'
    })
    expect(fork.snapshot.messages).toEqual(source.snapshot.messages)
    // 用量记账不继承（新会话的 token 统计从空开始），上下文占用照常继承。
    expect(fork.snapshot.usageHistory).toEqual([])
    expect(fork.snapshot.subagentUsageHistory).toEqual([])
    expect(fork.snapshot.lastUsage).toEqual(source.snapshot.lastUsage)
    expect(source.snapshot.usageHistory).toHaveLength(1)
    expect(fork.snapshot).not.toBe(source.snapshot)
  })
})
