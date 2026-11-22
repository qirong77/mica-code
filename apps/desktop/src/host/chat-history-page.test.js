import { describe, expect, test } from 'bun:test'
import { historyPage } from './chat-history-page'

const turns = (count) =>
  Array.from({ length: count }, (_, i) => [
    { role: 'user', text: `question ${i}` },
    { role: 'assistant', text: `answer ${i}` }
  ]).flat()

describe('history wire pages', () => {
  test('sends only the latest 80 rows, with a cursor to older history', () => {
    const rows = turns(150)
    const page = historyPage(rows)
    expect(page.rows).toEqual(rows.slice(220))
    expect(page).toMatchObject({ start: 220, end: 300, total: 300, noticeOffset: 0, reset: false })
    expect(page.nextBefore).toEqual(page.startCursor)
    expect(JSON.stringify(page)).not.toContain('question 0"')
  })

  test('walks all pages without duplicate or missing rows while new replies append', () => {
    const original = turns(150)
    let page = historyPage(original)
    let loaded = page.rows
    const appended = [...original, ...turns(2)]
    while (page.nextBefore) {
      const previousStart = page.start
      page = historyPage(appended, { before: page.nextBefore })
      expect(page.reset).toBe(false)
      expect(page.end).toBe(previousStart)
      loaded = [...page.rows, ...loaded]
    }
    expect(loaded).toEqual(original)
    expect(page.start).toBe(0)
  })

  test('retains the entire most recent turn even when it exceeds the page target', () => {
    const old = turns(100)
    const active = [
      { role: 'user', text: 'current prompt' },
      ...Array.from({ length: 100 }, (_, i) => ({ role: 'assistant', text: `iteration ${i}` }))
    ]
    expect(historyPage([...old, ...active]).rows).toEqual(active)
  })

  test('refreshes exactly the loaded range after new turns append', () => {
    const rows = turns(150)
    const first = historyPage(rows)
    const older = historyPage(rows, { before: first.nextBefore })
    const appended = [...rows, ...turns(1)]
    const refreshed = historyPage(appended, { from: older.startCursor })
    expect(refreshed.reset).toBe(false)
    expect(refreshed.start).toBe(older.start)
    expect(refreshed.rows).toEqual(appended.slice(older.start))
  })

  test('includes the original replay prompt when many later user messages were steered into its turn', () => {
    const old = turns(100)
    const active = [{ role: 'user', text: 'original [图片] prompt' }, ...turns(100)]
    const page = historyPage([...old, ...active], {
      replayPrompt: 'original [Image](/image.png) prompt'
    })
    expect(page.start).toBe(old.length)
    expect(page.rows).toEqual(active)
    const older = historyPage([...old, ...active], {
      before: page.nextBefore,
      replayPrompt: 'question 0'
    })
    expect(older.end).toBe(page.start)
    expect(older.rows).toHaveLength(80)
  })

  test('detects edits anywhere in the prefix even if the boundary row is unchanged', () => {
    const rows = turns(150)
    const first = historyPage(rows)
    const edited = rows.map((row, i) => (i === 0 ? { ...row, text: 'edited' } : row))
    for (const key of ['before', 'from']) {
      const reset = historyPage(edited, { [key]: first.startCursor })
      expect(reset.reset).toBe(true)
      expect(reset.rows).toEqual(edited.slice(220))
    }
  })

  test('resets stale cursors after compaction, truncation or same-length replacement', () => {
    const rows = turns(150)
    const cursor = historyPage(rows).nextBefore
    for (const edited of [
      rows.slice(50),
      rows.slice(0, 30),
      turns(150).map((row) => ({ ...row, text: `new ${row.text}` }))
    ]) {
      const page = historyPage(edited, { before: cursor, all: true })
      expect(page.reset).toBe(true)
      expect(page.end).toBe(edited.length)
      expect(page.rows).toEqual(historyPage(edited).rows)
    }
  })

  test('full-text expansion explicitly reads only the missing prefix', () => {
    const rows = turns(150)
    const first = historyPage(rows)
    const all = historyPage(rows, { before: first.nextBefore, all: true })
    expect(all.rows).toEqual(rows.slice(0, first.start))
    expect(all.nextBefore).toBeNull()
    expect([...all.rows, ...first.rows]).toEqual(rows)
    expect(historyPage(rows, { all: true }).rows).toHaveLength(80)
  })

  test('returns global notice offsets and preserves compact boundary/checkpoint pairs', () => {
    const rows = [
      { role: 'notice', text: 'old notice' },
      { role: 'user', text: '[Mica compact boundary] {}' },
      { role: 'user', text: '[Mica compact checkpoint] summary' },
      { role: 'notice', text: 'recent notice' },
      { role: 'assistant', text: 'reply' }
    ]
    const page = historyPage(rows, { limit: 3 })
    expect(page.start).toBe(1)
    expect(page.noticeOffset).toBe(1)
    expect(page.rows).toEqual(rows.slice(1))
  })

  test('empty, short and invalid cursor requests are bounded and safe', () => {
    expect(historyPage([])).toMatchObject({
      rows: [],
      start: 0,
      total: 0,
      nextBefore: null,
      startCursor: null
    })
    expect(historyPage(turns(2)).nextBefore).toBeNull()
    for (const before of [{ index: -1 }, { index: 100000 }, { index: 2, anchor: 'wrong' }]) {
      expect(historyPage(turns(150), { before }).rows).toHaveLength(80)
    }
  })
})
