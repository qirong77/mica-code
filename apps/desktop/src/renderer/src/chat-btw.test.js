import { describe, expect, it } from 'vitest'

import { newlyAnsweredBtwEntries } from './ChatView.jsx'

const thread = (entries) => ({ id: 't1', entries })

describe('newlyAnsweredBtwEntries', () => {
  it('finds the entries that just stopped running', () => {
    const previous = thread([
      { id: 'e1', status: 'completed' },
      { id: 'e2', status: 'running' }
    ])
    const next = thread([
      { id: 'e1', status: 'completed' },
      { id: 'e2', status: 'completed', answer: '可以' }
    ])
    expect(newlyAnsweredBtwEntries(previous, next)).toMatchObject([
      { id: 'e2', status: 'completed' }
    ])
  })

  it('reports failures as well', () => {
    const previous = thread([{ id: 'e1', status: 'running' }])
    const next = thread([{ id: 'e1', status: 'error', error: '模型挂了' }])
    expect(newlyAnsweredBtwEntries(previous, next)).toMatchObject([{ id: 'e1', status: 'error' }])
  })

  it('stays quiet for the first snapshot (restore, new topic) and for answers already seen', () => {
    // 恢复会话时拿到的第一份快照：整条线程都是新的，但用户已经看过，不该再弹提示。
    expect(
      newlyAnsweredBtwEntries(thread([]), thread([{ id: 'e1', status: 'completed' }]))
    ).toEqual([])
    expect(
      newlyAnsweredBtwEntries(
        thread([{ id: 'e1', status: 'completed' }]),
        thread([
          { id: 'e1', status: 'completed' },
          { id: 'e2', status: 'running' }
        ])
      )
    ).toEqual([])
  })

  it('tolerates missing snapshots', () => {
    expect(newlyAnsweredBtwEntries(undefined, undefined)).toEqual([])
    expect(newlyAnsweredBtwEntries(thread([{ id: 'e1', status: 'running' }]), undefined)).toEqual(
      []
    )
  })
})
