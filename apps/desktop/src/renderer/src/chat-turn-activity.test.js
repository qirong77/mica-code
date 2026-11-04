import { describe, expect, it } from 'bun:test'
import {
  groupActivityRounds,
  mergeTurnThinking,
  roundLabel,
  turnActivitySettledAt
} from './chat-turn-activity'

const user = (id, turnId) => ({ id, role: 'user', kind: 'message', text: id, turnId })
const answer = (id, turnId) => ({ id, role: 'assistant', kind: 'message', text: id, turnId })
const thinking = (id, turnId, text = id) => ({ id, kind: 'reasoning', text, turnId, updatedAt: 10 })
const tool = (id, turnId, status = 'completed', finishedAt = 20) => ({
  id,
  kind: 'tool',
  turnId,
  tool: { tool: 'read_file', status, startedAt: 5, finishedAt }
})

const shape = (rounds) => rounds.map((round) => `${round.label}:${round.messages.length}`)

describe('turn log rounds', () => {
  it('groups activity rows by turn and keeps dialogue rows out', () => {
    const rounds = groupActivityRounds([
      user('u1', 't1'),
      thinking('r1', 't1'),
      tool('c1', 't1'),
      answer('a1', 't1'),
      user('u2', 't2'),
      thinking('r2', 't2'),
      tool('c2', 't2')
    ])
    expect(shape(rounds)).toEqual(['轮次一:2', '轮次二:2'])
    expect(rounds.map((round) => round.key)).toEqual(['t1', 't2'])
  })

  it('keeps rows without a turn key as their own round', () => {
    // 重放缓冲被挤掉时拿不到 step_start：这些行单独成组，不会挤进别的轮次。
    const rounds = groupActivityRounds([thinking('r1', null), thinking('r2', 't2')])
    expect(rounds.map((round) => round.key)).toEqual(['', 't2'])
  })

  it('keeps only the newest rounds so the dock does not grow forever', () => {
    const messages = []
    for (let index = 1; index <= 9; index += 1) messages.push(thinking(`r${index}`, `t${index}`))
    const rounds = groupActivityRounds(messages, { limit: 3 })
    expect(rounds.map((round) => round.key)).toEqual(['t7', 't8', 't9'])
    expect(shape(rounds)).toEqual(['轮次一:1', '轮次二:1', '轮次三:1'])
  })

  it('labels rounds by their position in the dock', () => {
    expect(roundLabel(1)).toBe('轮次一')
    expect(roundLabel(12)).toBe('轮次12')
  })

  it('reports when a round settled so elapsed time stops growing', () => {
    expect(turnActivitySettledAt([thinking('r1', 't1'), tool('c1', 't1', 'completed', 42)])).toBe(
      42
    )
    expect(turnActivitySettledAt([thinking('r1', 't1')])).toBe(10)
    expect(turnActivitySettledAt([])).toBeNull()
  })
})

describe('merged thinking blocks', () => {
  it('appends every thinking of one turn into the first block', () => {
    const messages = [
      thinking('r1', 't1', '先看现状'),
      tool('c1', 't1'),
      thinking('r2', 't1', '再看调用点'),
      tool('c2', 't1'),
      thinking('r3', 't1', '结论')
    ]
    const rows = mergeTurnThinking(messages)
    expect(rows.map((row) => row.id)).toEqual(['r1', 'c1', 'c2'])
    expect(rows.find((row) => row.id === 'r1').text).toBe('先看现状\n\n再看调用点\n\n结论')
  })

  it('keeps turns apart and drops empty segments', () => {
    const messages = [
      thinking('r1', 't1', 'A'),
      thinking('r2', 't2', 'B'),
      thinking('r3', 't1', ''),
      thinking('r4', 't1', 'C')
    ]
    expect(mergeTurnThinking(messages).map((row) => `${row.id}:${row.text}`)).toEqual([
      'r1:A\n\nC',
      'r2:B'
    ])
  })

  it('keeps the growing segment in the merged text while it streams', () => {
    const messages = [thinking('r1', 't1', '第一段'), thinking('r2', 't1', '第二段在长')]
    const grown = [messages[0], { ...messages[1], text: '第二段在长，还在长' }]
    expect(mergeTurnThinking(grown)[0].text).toBe('第一段\n\n第二段在长，还在长')
  })
})
