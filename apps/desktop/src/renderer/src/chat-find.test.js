import { describe, expect, it } from 'bun:test'

import {
  FIND_MATCH_LIMIT,
  compileFindMatcher,
  escapeFindText,
  findCountLabel,
  findTextMatches,
  stepMatchIndex
} from './chat-find.js'

const matchAll = (text, query, options) =>
  findTextMatches(text, compileFindMatcher(query, options)).matches

describe('compileFindMatcher', () => {
  it('空查询没有匹配器', () => {
    expect(compileFindMatcher('')).toBeNull()
    expect(compileFindMatcher(null)).toBeNull()
  })

  it('默认不区分大小写', () => {
    const matcher = compileFindMatcher('hello')

    expect(findTextMatches('Hello HELLO hello', matcher).matches).toHaveLength(3)
  })

  it('区分大小写时只认原样', () => {
    const matcher = compileFindMatcher('hello', { caseSensitive: true })

    expect(findTextMatches('Hello HELLO hello', matcher).matches).toEqual([{ start: 12, end: 17 }])
  })

  it('字面量里的正则元字符按原样匹配', () => {
    expect(matchAll('axb a.b', 'a.b')).toEqual([{ start: 4, end: 7 }])
  })

  it('全字匹配不把词中间算进来', () => {
    expect(matchAll('cat category cat', 'cat', { wholeWord: true })).toEqual([
      { start: 0, end: 3 },
      { start: 13, end: 16 }
    ])
  })

  it('全字匹配对中文不受影响（边界只看 ASCII 词字符）', () => {
    expect(matchAll('模型的模型', '模型', { wholeWord: true })).toHaveLength(2)
  })

  it('正则模式按正则解释，并且仍然不区分大小写', () => {
    expect(matchAll('foo FOO f(o)o', 'f(o+)', { regex: true })).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 }
    ])
  })

  it('正则写坏时给出错误文案，而不是抛异常', () => {
    const matcher = compileFindMatcher('(', { regex: true })

    expect(matcher.pattern).toBeNull()
    expect(matcher.error).toBe('正则无效')
  })
})

describe('findTextMatches', () => {
  it('零宽命中不参与，也不会原地打转', () => {
    expect(matchAll('bbb', 'a*', { regex: true })).toEqual([])
    expect(matchAll('axa', 'a*', { regex: true })).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 }
    ])
  })

  it('同一段文本里多次出现全部找出，位置是 UTF-16 下标', () => {
    expect(matchAll('ab ab', 'ab')).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 }
    ])
  })

  it('超过上限时截断并标记', () => {
    const result = findTextMatches('aaaa', compileFindMatcher('a'), 2)

    expect(result.matches).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('正好等于上限不算截断', () => {
    const result = findTextMatches('aa', compileFindMatcher('a'), 2)

    expect(result.matches).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })

  it('默认上限就是常量，空文本直接返回空', () => {
    expect(findTextMatches('', compileFindMatcher('a')).matches).toEqual([])
    expect(FIND_MATCH_LIMIT).toBeGreaterThan(0)
  })

  it('不污染匹配器的 lastIndex', () => {
    const matcher = compileFindMatcher('a')
    findTextMatches('aaa', matcher)
    findTextMatches('aaa', matcher)

    expect(matcher.pattern.lastIndex).toBe(0)
  })
})

describe('stepMatchIndex', () => {
  it('首尾循环', () => {
    expect(stepMatchIndex(0, 1, 3)).toBe(1)
    expect(stepMatchIndex(2, 1, 3)).toBe(0)
    expect(stepMatchIndex(0, -1, 3)).toBe(2)
  })

  it('还没选中过时按方向落到首/尾', () => {
    expect(stepMatchIndex(-1, 1, 3)).toBe(0)
    expect(stepMatchIndex(-1, -1, 3)).toBe(2)
  })

  it('没有命中时是 -1', () => {
    expect(stepMatchIndex(0, 1, 0)).toBe(-1)
  })
})

describe('findCountLabel', () => {
  it('空查询不显示', () => {
    expect(findCountLabel({ query: '' })).toBe('')
  })

  it('无命中和有命中', () => {
    expect(findCountLabel({ query: 'x', index: -1, count: 0 })).toBe('无结果')
    expect(findCountLabel({ query: 'x', index: 2, count: 7 })).toBe('3/7')
  })

  it('截断时加号提示', () => {
    expect(findCountLabel({ query: 'x', index: 0, count: 5, truncated: true })).toBe('1/5+')
  })

  it('正则错误优先展示错误', () => {
    expect(findCountLabel({ query: '(', count: 0, error: '正则无效' })).toBe('正则无效')
  })
})

describe('escapeFindText', () => {
  it('转义全部元字符', () => {
    expect(escapeFindText('.*+?^${}()|[]\\')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\')
  })
})
