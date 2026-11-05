import { describe, expect, it } from 'bun:test'
import { composerMirrorParts, resolveComposerSelection } from './chat-composer-caret'

describe('composer caret during IME composition', () => {
  it('collapses the composition range to its end while composing', () => {
    // Chromium 在组合期把整个组合串报成 selection（"TODO: ni" 上是 6..8），
    // 插入点其实在末尾，直接用 selectionStart 会让自绘光标跳回拼音左侧。
    expect(
      resolveComposerSelection({ selectionStart: 6, selectionEnd: 8, composing: true })
    ).toEqual({ start: 8, end: 8 })
    expect(
      resolveComposerSelection({ selectionStart: 6, selectionEnd: 11, composing: true })
    ).toEqual({ start: 11, end: 11 })
  })

  it('never reports a selection while composing', () => {
    const resolved = resolveComposerSelection({
      selectionStart: 0,
      selectionEnd: 5,
      composing: true
    })
    expect(resolved.end - resolved.start).toBe(0)
  })

  it('keeps a collapsed caret untouched while composing', () => {
    expect(
      resolveComposerSelection({ selectionStart: 6, selectionEnd: 6, composing: true })
    ).toEqual({ start: 6, end: 6 })
  })

  it('leaves real selections alone outside composition', () => {
    expect(
      resolveComposerSelection({ selectionStart: 3, selectionEnd: 5, composing: false })
    ).toEqual({ start: 3, end: 5 })
    expect(
      resolveComposerSelection({ selectionStart: 3, selectionEnd: 3, composing: false })
    ).toEqual({ start: 3, end: 3 })
  })
})

describe('composer caret mirror', () => {
  it('keeps the suffix in the mirror so a word wraps the same way before and after the caret', () => {
    const value = `${'pasted text '.repeat(1000)}narrow-column-word`
    const index = value.indexOf('column')
    const parts = composerMirrorParts(value, index)
    expect(parts.before + parts.marker + parts.after).toBe(value)
    expect(parts.after).toBe('olumn-word')
  })

  it('preserves a newline and measures the next grapheme as one character', () => {
    expect(composerMirrorParts('first\nsecond', 5)).toEqual({
      before: 'first',
      marker: '\u200b',
      after: '\nsecond'
    })
    expect(composerMirrorParts('a👩‍💻b', 1)).toEqual({ before: 'a', marker: '👩‍💻', after: 'b' })
    expect(composerMirrorParts('end', 3)).toEqual({ before: 'end', marker: '\u200b', after: '' })
  })
})
