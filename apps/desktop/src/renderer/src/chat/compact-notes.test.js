import { expect, it } from 'bun:test'
import {
  collapseCompactToolNotes,
  parseCompactToolNote,
  splitTrailingCompactNotes,
  summarizeCompactToolNotes
} from './compact-notes'

const note = (...entries) => `[tool calls cleared during compact: ${entries.join(', ')}]`

it('parses a note into tool names and the omitted tail', () => {
  expect(parseCompactToolNote(note('read_file(a.ts)', 'run_shell(cd /x, ls)', '+2'))).toEqual({
    tools: ['read_file', 'run_shell'],
    omitted: 2,
    raw: note('read_file(a.ts)', 'run_shell(cd /x, ls)', '+2')
  })
  expect(parseCompactToolNote('普通助手回复')).toBeNull()
})

it('keeps assistant prose and strips only the trailing note', () => {
  expect(splitTrailingCompactNotes(`补一个折叠。\n\n${note('apply_patch(x.ts)')}`)).toEqual({
    body: '补一个折叠。',
    notes: [{ tools: ['apply_patch'], omitted: 0, raw: note('apply_patch(x.ts)') }]
  })
  expect(splitTrailingCompactNotes('没有说明')).toEqual({ body: '没有说明', notes: [] })
})

it('leaves a quoted note inside prose alone', () => {
  const quoted = `折叠出来的是这一行：\n\n\`\`\`\n${note('read_file(a.ts)')}\n\`\`\``
  expect(splitTrailingCompactNotes(quoted)).toEqual({ body: quoted, notes: [] })
})

it('summarizes rounds and repeated tools', () => {
  const notes = [
    parseCompactToolNote(note('read_file(a.ts)', 'read_file(b.ts)')),
    parseCompactToolNote(note('run_shell(cd /x)', 'read_file(c.ts)', '+1'))
  ]
  expect(summarizeCompactToolNotes(notes)).toBe('已清理 2 轮工具调用 · read_file ×3、run_shell、另 1 次')
})

it('folds consecutive notes into one line and keeps the original detail', () => {
  const rows = [
    { id: 'u1', kind: 'message', role: 'user', text: '看看 compact', done: true },
    { id: 'a1', kind: 'message', role: 'assistant', text: note('read_file(a.ts)'), done: true },
    { id: 'a2', kind: 'message', role: 'assistant', text: note('run_shell(cd /x)'), done: true },
    { id: 'a3', kind: 'message', role: 'assistant', text: note('read_file(a.ts)'), done: true }
  ]
  const next = collapseCompactToolNotes(rows, 's1')
  expect(next).toHaveLength(2)
  expect(next[1]).toMatchObject({
    kind: 'message',
    role: 'assistant',
    compactNote: true,
    text: '已清理 3 轮工具调用 · read_file ×2、run_shell'
  })
  expect(next[1].detail.split('\n')).toHaveLength(3)
  expect(next[0]).toBe(rows[0])
})

it('does not merge notes across a real message', () => {
  const rows = [
    { id: 'a1', kind: 'message', role: 'assistant', text: note('read_file(a.ts)'), done: true },
    { id: 'm1', kind: 'message', role: 'assistant', text: '这段是真正的回答', done: true },
    { id: 'a2', kind: 'message', role: 'assistant', text: note('run_shell(cd /x)'), done: true }
  ]
  const next = collapseCompactToolNotes(rows, 's2')
  expect(next.map((message) => message.text)).toEqual([
    '已清理 1 轮工具调用 · read_file',
    '这段是真正的回答',
    '已清理 1 轮工具调用 · run_shell'
  ])
})
