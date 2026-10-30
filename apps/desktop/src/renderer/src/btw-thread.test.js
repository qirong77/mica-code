import { describe, expect, it } from 'vitest'

import {
  btwContextMenuItems,
  btwContextLabel,
  btwContextTitle,
  btwEntryElapsedMs,
  btwEntryPhase,
  btwEntryRetryable,
  btwHistoryStep,
  btwPhaseText,
  btwRunningEntry,
  btwRunningTool,
  btwTabMark,
  btwTabTitle,
  btwThreadMarkdown
} from './btw-thread'

const entry = (extra) => ({
  id: 'e1',
  status: 'running',
  startedAt: '2026-10-16T10:00:00.000Z',
  ...extra
})

describe('btwContextLabel', () => {
  it('reads model + last request context with the window share', () => {
    expect(btwContextLabel({ model: 'gpt-5', tokens: 12_400, contextWindowSize: 200_000 })).toBe(
      'gpt-5 · 12.4k / 200k (6%)'
    )
  })

  it('marks a post-compaction estimate and hides the share without a window', () => {
    expect(btwContextLabel({ model: 'gpt-5', tokens: 1200, estimated: true })).toBe('gpt-5 · ≈1.2k')
    // 还没请求过：不显示一个 0 的假数字
    expect(btwContextLabel({ model: 'gpt-5' })).toBe('gpt-5')
    expect(btwContextLabel(undefined)).toBe('')
  })
})

describe('btwContextTitle', () => {
  it('explains the estimate and reports cumulative usage', () => {
    const title = btwContextTitle({
      tokens: 1200,
      estimated: true,
      cachedTokens: 800,
      totalInputTokens: 30_000,
      totalOutputTokens: 4000,
      requests: 3
    })
    expect(title).toContain('估算值')
    expect(title).toContain('累计 30k in / 4k out')
    expect(title).toContain('命中缓存 800')
    expect(title).toContain('共 3 次请求')
    expect(btwContextTitle(undefined)).toBe('')
  })
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

describe('btwContextMenuItems', () => {
  const byId = (items, id) => items.find((item) => item.id === id)
  const answer = { id: 'e1', question: '问一句', answer: '答一句', status: 'completed' }

  it('offers clipboard actions for the entry under the cursor', () => {
    const items = btwContextMenuItems({ entry: answer, hasEntries: true })
    expect(byId(items, 'copy')).toMatchObject({ label: '复制回答', disabled: false })
    expect(byId(items, 'quote')).toMatchObject({ disabled: false })
  })

  it('copies the question while the answer is still streaming', () => {
    const items = btwContextMenuItems({
      entry: { id: 'e2', question: '问一句', status: 'running' },
      running: true,
      hasEntries: true
    })
    expect(byId(items, 'copy').label).toBe('复制问题')
  })

  it('prefers the selection, and disables the copy block when there is no text', () => {
    const withSelection = btwContextMenuItems({
      entry: answer,
      hasEntries: true,
      hasSelection: true
    })
    expect(byId(withSelection, 'copy').label).toBe('复制选中内容')
    const empty = btwContextMenuItems({ hasEntries: true })
    expect(byId(empty, 'copy').disabled).toBe(true)
    expect(byId(empty, 'quote').disabled).toBe(true)
  })

  it('never exposes main-conversation actions', () => {
    // 在 btw 的正文上点「Clear」会把主会话清掉，所以那份会话菜单一项都不能进来
    const ids = btwContextMenuItems({ entry: answer, hasEntries: true })
      .filter((item) => !item.separator)
      .map((item) => item.id)
    expect(ids).toEqual(['copy', 'copy-thread', 'quote', 'new-thread', 'compact', 'close-thread'])
  })

  it('only offers a whole-thread copy once there is something to copy', () => {
    expect(
      btwContextMenuItems({ entry: answer, hasEntries: true }).find(
        (item) => item.id === 'copy-thread'
      )
    ).toMatchObject({ disabled: false })
    expect(btwContextMenuItems({ hasEntries: false })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'copy-thread', disabled: true })])
    )
  })

  it('disables destructive actions while an answer is streaming', () => {
    const items = btwContextMenuItems({
      entry: answer,
      running: true,
      hasEntries: true,
      canClose: true
    })
    expect(byId(items, 'compact').disabled).toBe(true)
    expect(byId(items, 'close-thread')).toMatchObject({ disabled: true, danger: true })
  })

  it('needs a thread with content before compacting, and a target before quoting', () => {
    const empty = btwContextMenuItems({ hasEntries: false, canQuote: false, canClose: false })
    expect(byId(empty, 'compact').disabled).toBe(true)
    expect(byId(empty, 'quote').disabled).toBe(true)
    expect(byId(empty, 'close-thread').disabled).toBe(true)
  })
})

describe('btwEntryRetryable', () => {
  it('offers a retry for failures and interruptions only', () => {
    expect(btwEntryRetryable({ status: 'error', question: '问题' })).toBe(true)
    expect(btwEntryRetryable({ status: 'aborted', question: '问题' })).toBe(true)
    expect(btwEntryRetryable({ status: 'completed', question: '问题' })).toBe(false)
    expect(btwEntryRetryable({ status: 'running', question: '问题' })).toBe(false)
    expect(btwEntryRetryable({ status: 'error', question: '   ' })).toBe(false)
    expect(btwEntryRetryable(null)).toBe(false)
  })
})

describe('btwHistoryStep', () => {
  it('walks from the draft into older questions and back', () => {
    expect(btwHistoryStep({ index: -1, count: 2, direction: 1 })).toEqual({ index: 0 })
    expect(btwHistoryStep({ index: 0, count: 2, direction: 1 })).toEqual({ index: 1 })
    // 已到最早一条
    expect(btwHistoryStep({ index: 1, count: 2, direction: 1 })).toBeNull()
    expect(btwHistoryStep({ index: 0, count: 2, direction: -1 })).toEqual({ index: -1 })
    // 已经在草稿上，再往下没有变化
    expect(btwHistoryStep({ index: -1, count: 2, direction: -1 })).toBeNull()
  })

  it('does nothing without history', () => {
    expect(btwHistoryStep({ index: -1, count: 0, direction: 1 })).toBeNull()
    expect(btwHistoryStep({})).toBeNull()
  })
})

describe('btwTabMark', () => {
  it('reports the state of the last entry, with running winning over an older failure', () => {
    expect(btwTabMark({ entries: [{ status: 'completed' }] })).toBe('')
    expect(btwTabMark({ entries: [{ status: 'error' }] })).toBe('error')
    expect(btwTabMark({ entries: [{ status: 'aborted' }] })).toBe('aborted')
    // 重新问过一遍、现在正在跑：不该继续挂着上一轮的红点
    expect(btwTabMark({ entries: [{ status: 'error' }, { status: 'running' }] })).toBe('running')
    expect(btwTabMark({ entries: [] })).toBe('')
    expect(btwTabMark(null)).toBe('')
  })
})

describe('btwTabTitle', () => {
  it('explains the count and why the last answer failed', () => {
    const tab = {
      entries: [
        { question: '第一问', status: 'completed' },
        { question: '第二问', status: 'error', error: '模型挂了' }
      ]
    }
    expect(btwTabTitle(tab)).toBe('第一问\n2 条问答\n上一次失败：模型挂了')
  })

  it('falls back to a plain label for an empty tab', () => {
    expect(btwTabTitle({ entries: [] })).toBe('新线程')
  })
})

describe('btwThreadMarkdown', () => {
  it('keeps the questions and answers, and drops thinking and tool rows', () => {
    const markdown = btwThreadMarkdown({
      entries: [
        {
          question: '乐观锁怎么用？',
          answer: '用版本号。',
          thinking: '想一想',
          tools: [{ id: 't1', tool: 'grep' }],
          status: 'completed'
        },
        { question: '那并发写呢？', status: 'error', error: '模型挂了' }
      ]
    })
    expect(markdown).toContain('> 乐观锁怎么用？')
    expect(markdown).toContain('用版本号。')
    expect(markdown).toContain('> 那并发写呢？')
    expect(markdown).toContain('_失败：模型挂了_')
    expect(markdown).not.toContain('grep')
    expect(markdown).not.toContain('想一想')
  })

  it('returns an empty string without questions', () => {
    expect(btwThreadMarkdown({ entries: [] })).toBe('')
    expect(btwThreadMarkdown(null)).toBe('')
  })
})
