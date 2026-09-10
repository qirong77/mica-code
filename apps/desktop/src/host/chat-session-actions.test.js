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
      snapshot: { messages: [{ role: 'user', content: 'hello' }] }
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
    expect(fork.snapshot).toEqual(source.snapshot)
    expect(fork.snapshot).not.toBe(source.snapshot)
  })
})
