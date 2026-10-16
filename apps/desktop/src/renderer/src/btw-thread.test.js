import { describe, expect, it } from 'vitest'

import {
  btwEntryElapsedMs,
  btwEntryPhase,
  btwPhaseText,
  btwRunningEntry,
  btwRunningTool
} from './btw-thread'

const entry = (extra) => ({
  id: 'e1',
  status: 'running',
  startedAt: '2026-10-16T10:00:00.000Z',
  ...extra
})

describe('btwRunningEntry', () => {
  it('finds the entry that is still running', () => {
    expect(
      btwRunningEntry([
        { id: 'e1', status: 'completed' },
        { id: 'e2', status: 'running' }
      ])?.id
    ).toBe('e2')
    expect(btwRunningEntry([{ id: 'e1', status: 'completed' }])).toBeNull()
    expect(btwRunningEntry(undefined)).toBeNull()
  })
})

describe('btwRunningTool', () => {
  it('takes the latest running call', () => {
    const tools = [
      { id: 'a', tool: 'read_file', status: 'completed' },
      { id: 'b', tool: 'grep_search', status: 'running' },
      { id: 'c', tool: 'read_file', status: 'running' }
    ]
    expect(btwRunningTool(entry({ tools }))?.id).toBe('c')
    expect(btwRunningTool(entry({ tools: [] }))).toBeNull()
  })
})

describe('btwEntryPhase', () => {
  it('is null once the entry is no longer running', () => {
    expect(btwEntryPhase(entry({ status: 'completed', answer: '可以' }))).toBeNull()
    expect(btwEntryPhase(null)).toBeNull()
  })

  it('follows connecting -> thinking -> tool -> answering', () => {
    expect(btwEntryPhase(entry({}))).toBe('connecting')
    expect(btwEntryPhase(entry({ thinking: '嗯' }))).toBe('thinking')
    expect(
      btwEntryPhase(entry({ thinking: '嗯', tools: [{ tool: 'read_file', status: 'running' }] }))
    ).toBe('tool')
    expect(btwEntryPhase(entry({ answer: '可以先' }))).toBe('answering')
    // 工具还在跑时优先显示工具：那是「正在发生的事」，正文只是它前面已经写好的部分
    expect(
      btwEntryPhase(entry({ answer: '可以先', tools: [{ tool: 'read_file', status: 'running' }] }))
    ).toBe('tool')
  })
})

describe('btwPhaseText', () => {
  it('names the phase, including the tool in flight', () => {
    expect(btwPhaseText(entry({}))).toBe('正在连接模型…')
    expect(btwPhaseText(entry({ thinking: '嗯' }))).toBe('正在思考…')
    expect(btwPhaseText(entry({ tools: [{ tool: 'grep_search', status: 'running' }] }))).toBe(
      '正在调用 grep_search…'
    )
    expect(btwPhaseText(entry({ answer: '可以先' }))).toBe('正在回答…')
    expect(btwPhaseText(entry({ status: 'completed' }))).toBe('')
  })
})

describe('btwEntryElapsedMs', () => {
  const startedAt = '2026-10-16T10:00:00.000Z'

  it('counts up while running and freezes at finishedAt afterwards', () => {
    expect(btwEntryElapsedMs(entry({ startedAt }), Date.parse('2026-10-16T10:00:03.500Z'))).toBe(
      3500
    )
    expect(
      btwEntryElapsedMs(
        entry({ startedAt, status: 'completed', finishedAt: '2026-10-16T10:00:02.000Z' }),
        Date.parse('2026-10-16T10:10:00.000Z')
      )
    ).toBe(2000)
  })

  it('returns 0 without a usable start time', () => {
    expect(btwEntryElapsedMs(undefined, Date.now())).toBe(0)
    expect(btwEntryElapsedMs({ startedAt: 'not a date' }, Date.now())).toBe(0)
  })
})
