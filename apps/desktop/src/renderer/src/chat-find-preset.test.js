import { describe, expect, it } from 'bun:test'

import { compileFindMatcher, findTextMatches } from './chat-find.js'
import { findPresetForSearch } from './chat-find-preset.js'

const matchAll = (text, preset) =>
  findTextMatches(text, compileFindMatcher(preset.query, { regex: preset.regex })).matches

describe('findPresetForSearch', () => {
  it('没有关键词就不带条件', () => {
    expect(findPresetForSearch([])).toBeNull()
    expect(findPresetForSearch(null)).toBeNull()
    expect(findPresetForSearch(['', '   '])).toBeNull()
  })

  it('单个关键词按字面量查找', () => {
    const preset = findPresetForSearch(['a.b'])

    expect(preset).toEqual({ query: 'a.b', regex: false })
    expect(matchAll('axb a.b', preset)).toEqual([{ start: 4, end: 7 }])
  })

  it('多个关键词串成任一命中的正则，元字符都被转义', () => {
    const preset = findPresetForSearch(['a.b', 'c+d'])

    expect(preset).toEqual({ query: 'a\\.b|c\\+d', regex: true })
    expect(matchAll('axb a.b c+d cc', preset)).toEqual([
      { start: 4, end: 7 },
      { start: 8, end: 11 }
    ])
  })

  it('空白词不参与拼装', () => {
    expect(findPresetForSearch(['  ', ' x '])).toEqual({ query: 'x', regex: false })
  })
})
