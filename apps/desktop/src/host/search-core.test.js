import { describe, expect, it } from 'bun:test'
import { compileQuery, matchesAnyGlob, parseGlobList, passesFileFilters } from './search-core'

describe('compileQuery', () => {
  it('默认忽略大小写', () => {
    const { match } = compileQuery({ query: 'foo' })
    expect(match('const foobar = 1')).toEqual({ column: 6, length: 3 })
    expect(match('const FOO = 1')).toEqual({ column: 6, length: 3 })
    expect(match('const bar = 1')).toBeNull()
  })

  it('matchCase 后严格区分大小写', () => {
    const { match } = compileQuery({ query: 'Foo', matchCase: true })
    expect(match('Foo bar')).toEqual({ column: 0, length: 3 })
    expect(match('foo bar')).toBeNull()
  })

  it('把查询里的正则元字符当字面量', () => {
    const { match } = compileQuery({ query: 'a.b' })
    expect(match('x a.b y')).toEqual({ column: 2, length: 3 })
    expect(match('x axb y')).toBeNull()
  })

  it('wholeWord 只认整体词', () => {
    const { match } = compileQuery({ query: 'foo', wholeWord: true })
    expect(match('a foo b')).toEqual({ column: 2, length: 3 })
    expect(match('a foobar b')).toBeNull()
    expect(match('a _foo b')).toBeNull()
    // 从非整体命中继续往后找整体命中
    expect(match('foobar foo')).toEqual({ column: 7, length: 3 })
  })

  it('wholeWord 对 CJK 不误伤', () => {
    const { match } = compileQuery({ query: '文件', wholeWord: true })
    expect(match('打开文件查看')).toEqual({ column: 2, length: 2 })
  })

  it('regex 走真正的正则并给出命中长度', () => {
    const { match } = compileQuery({ query: 'fo+', regex: true })
    expect(match('f fooo!')).toEqual({ column: 2, length: 4 })
  })

  it('正则无效时报错而不是抛出去', () => {
    const compiled = compileQuery({ query: '([', regex: true })
    expect(compiled.ok).toBe(false)
    expect(compiled.error).toBeTruthy()
    expect(compiled.match('anything')).toBeNull()
  })

  it('零宽正则不会死循环', () => {
    const { match } = compileQuery({ query: 'a*', regex: true })
    expect(match('bbb')).not.toBeUndefined()
  })

  it('空查询不匹配任何行', () => {
    expect(compileQuery({ query: '' }).match('anything')).toBeNull()
  })
})

describe('parseGlobList / matchesAnyGlob', () => {
  it('按逗号切分并去掉空项', () => {
    expect(parseGlobList(' *.ts , src/** ,, ')).toEqual(['*.ts', 'src/**'])
    expect(parseGlobList('')).toEqual([])
    expect(parseGlobList(null)).toEqual([])
  })

  it('没有斜杠的条目只比文件名', () => {
    expect(matchesAnyGlob('apps/desktop/src/a.ts', ['*.ts'])).toBe(true)
    expect(matchesAnyGlob('apps/desktop/src/a.js', ['*.ts'])).toBe(false)
  })

  it('带斜杠的条目比整条相对路径', () => {
    expect(matchesAnyGlob('apps/desktop/src/a.ts', ['apps/desktop/**'])).toBe(true)
    expect(matchesAnyGlob('apps/desktop/src/a.ts', ['apps/desktop/*'])).toBe(false)
    expect(matchesAnyGlob('apps/desktop/src/a.ts', ['packages/*'])).toBe(false)
    // `*` 不跨目录
    expect(matchesAnyGlob('src/a/b.ts', ['src/*.ts'])).toBe(false)
  })

  it('** 可以匹配零层或多层目录', () => {
    expect(matchesAnyGlob('src/a.ts', ['src/**/a.ts'])).toBe(true)
    expect(matchesAnyGlob('src/x/y/a.ts', ['src/**/a.ts'])).toBe(true)
    expect(matchesAnyGlob('packages/mica-tools/src/a.ts', ['**/src/*.ts'])).toBe(true)
  })

  it('? 匹配单个非斜杠字符', () => {
    expect(matchesAnyGlob('src/a.ts', ['src/?.ts'])).toBe(true)
    expect(matchesAnyGlob('src/ab.ts', ['src/?.ts'])).toBe(false)
  })
})

describe('passesFileFilters', () => {
  const filters = { include: parseGlobList('*.ts'), exclude: parseGlobList('*.test.ts') }

  it('排除优先于包含', () => {
    expect(passesFileFilters('src/a.test.ts', filters)).toBe(false)
    expect(passesFileFilters('src/a.ts', filters)).toBe(true)
    expect(passesFileFilters('src/a.js', filters)).toBe(false)
  })

  it('两侧都为空时全部放行', () => {
    expect(passesFileFilters('anything/goes.txt')).toBe(true)
  })

  it('只有排除时其余全部放行', () => {
    const only = { exclude: parseGlobList('node_modules/*') }
    expect(passesFileFilters('node_modules/a.js', only)).toBe(false)
    expect(passesFileFilters('src/a.js', only)).toBe(true)
  })
})
