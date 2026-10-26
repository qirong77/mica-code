import { describe, expect, it } from 'bun:test'

import {
  THINKING_BODY_LINES,
  joinThinkingText,
  mergeThinkingRuns,
  thinkingElapsedMs
} from './chat-thinking.js'

const reasoning = (id, text, extra = {}) => ({
  id,
  kind: 'reasoning',
  text,
  done: true,
  startedAt: 1000,
  updatedAt: 2000,
  ...extra
})

describe('joinThinkingText', () => {
  it('前一段以句末标点收尾时另起一段', () => {
    expect(joinThinkingText('先看目标。', '接着看代码')).toBe('先看目标。\n\n接着看代码')
  })

  it('同一句话被切开时直接接上，不插空行', () => {
    expect(joinThinkingText('先看用', '户的目标')).toBe('先看用户的目标')
  })

  it('空片段不留下多余空行', () => {
    expect(joinThinkingText('', '正文')).toBe('正文')
    expect(joinThinkingText('正文', '  ')).toBe('正文')
  })
})

describe('mergeThinkingRuns', () => {
  it('相邻的思考合并成一段', () => {
    const merged = mergeThinkingRuns([
      reasoning('a', '先看目标。', { startedAt: 1000, updatedAt: 1500 }),
      reasoning('b', '再看代码', { startedAt: 1500, updatedAt: 2200 })
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      kind: 'thinking',
      text: '先看目标。\n\n再看代码',
      startedAt: 1000,
      updatedAt: 2200,
      done: true
    })
  })

  it('中间隔着工具调用就断开：那是两段思考', () => {
    const tool = { id: 't', kind: 'tool', tool: { tool: 'read_file' } }
    const merged = mergeThinkingRuns([reasoning('a', '先看'), tool, reasoning('b', '再看')])

    expect(merged.map((item) => item.kind)).toEqual(['thinking', 'tool', 'thinking'])
  })

  it('只要还有一段没结束，合并结果就算进行中', () => {
    const merged = mergeThinkingRuns([
      reasoning('a', '想了一半。'),
      reasoning('b', '还在想', { done: false })
    ])

    expect(merged[0].done).toBe(false)
  })

  it('非思考消息原样透传，引用不变（memo 靠引用比较）', () => {
    const tool = { id: 't', kind: 'tool' }
    const merged = mergeThinkingRuns([tool])

    expect(merged[0]).toBe(tool)
  })

  it('空输入得到空结果', () => {
    expect(mergeThinkingRuns()).toEqual([])
  })
})

describe('thinkingElapsedMs', () => {
  const item = { startedAt: 1000, updatedAt: 2600, done: true }

  it('结束后按 updatedAt 计算', () => {
    expect(thinkingElapsedMs(item, 99999)).toBe(1600)
  })

  it('还在想时按当前时刻计算', () => {
    expect(thinkingElapsedMs({ ...item, done: false }, 3000)).toBe(2000)
  })

  it('没有起始时间时不显示耗时', () => {
    expect(thinkingElapsedMs({ done: true }, 3000)).toBe(0)
  })

  it('折叠行数是 4：思考是过程，不该把工具行挤出日志区', () => {
    expect(THINKING_BODY_LINES).toBe(4)
  })
})
