import { expect, it } from 'bun:test'
import {
  COMPACT_BOUNDARY_PREFIX,
  COMPACT_SUMMARY_PREFIX,
  mergeCompactCheckpoints,
  parseCompactBoundary,
  parseCompactCheckpoint
} from './compact-checkpoint'

const boundary = (meta) => `${COMPACT_BOUNDARY_PREFIX}\n\n${JSON.stringify(meta)}`
const checkpoint = (body) =>
  `${COMPACT_SUMMARY_PREFIX}\n\nThis session is being continued from a previous conversation. The summary below covers the earlier portion of the conversation.\n\n${body}`

it('keeps the readable metadata and drops the raw boundary JSON', () => {
  const meta = parseCompactBoundary(
    boundary({
      mode: 'summarized',
      beforeTokenEstimate: 1185_000,
      keptTokenEstimate: 131_711,
      summarizedCount: 1176,
      keptCount: 9,
      createdAt: '2026-11-04T06:36:37.325Z',
      strategy: 'summary_with_recent'
    })
  )
  expect(meta).toEqual({
    createdAt: '2026-11-04T06:36:37.325Z',
    beforeTokens: 1185_000,
    keptTokens: 131_711,
    summarizedCount: 1176,
    keptCount: 9
  })
  expect(parseCompactBoundary(`${COMPACT_BOUNDARY_PREFIX}\n\n{broken`)).toEqual({})
})

it('strips the prefix and the English preamble from the summary body', () => {
  expect(parseCompactCheckpoint(checkpoint('## 当前工作\n- 改压缩块'))).toBe('## 当前工作\n- 改压缩块')
})

it('merges boundary and checkpoint into one compact row', () => {
  const rows = mergeCompactCheckpoints([
    { role: 'user', text: '继续改压缩' },
    {
      role: 'user',
      text: boundary({ beforeTokenEstimate: 900_000, keptTokenEstimate: 46_000, keptCount: 4 })
    },
    { role: 'user', text: checkpoint('## 当前工作\n- 改压缩块') },
    { role: 'assistant', text: '收到' }
  ])
  expect(rows.map((row) => row.kind ?? 'message')).toEqual(['message', 'compact', 'message'])
  expect(rows[1]).toMatchObject({ role: 'assistant', kind: 'compact', text: '## 当前工作\n- 改压缩块' })
  expect(rows[1].compact).toMatchObject({ beforeTokens: 900_000, keptTokens: 46_000, keptCount: 4 })
})

it('drops a boundary that never got a checkpoint', () => {
  const rows = mergeCompactCheckpoints([
    { role: 'user', text: '继续' },
    { role: 'user', text: boundary({ beforeTokenEstimate: 900_000 }) }
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0].text).toBe('继续')
})
