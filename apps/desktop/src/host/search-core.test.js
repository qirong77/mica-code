import { describe, expect, it } from 'bun:test'
import {
  asciiNeedle,
  buildPreview,
  collectSearchMatches,
  compileQuery,
  indexOfAscii,
  matchesAnyGlob,
  parseGlobList,
  passesFileFilters
} from './search-core'

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

describe('asciiNeedle / indexOfAscii', () => {
  it('纯 ASCII 查询给出字节 needle，含中文或为空时返回 null', () => {
    expect(asciiNeedle('Foo')).toEqual(Buffer.from('Foo'))
    expect(asciiNeedle('文件')).toBeNull()
    expect(asciiNeedle('a文')).toBeNull()
    expect(asciiNeedle('')).toBeNull()
  })

  it('在 UTF-8 字节上忽略 ASCII 大小写', () => {
    const buffer = Buffer.from('const Needle = 1\n', 'utf8')
    expect(indexOfAscii(buffer, asciiNeedle('needle'))).toBe(6)
    expect(indexOfAscii(buffer, asciiNeedle('NEEDLE'))).toBe(6)
    expect(indexOfAscii(buffer, asciiNeedle('never'))).toBe(-1)
  })

  it('matchCase 时严格匹配', () => {
    const buffer = Buffer.from('Needle needle', 'utf8')
    expect(indexOfAscii(buffer, asciiNeedle('needle'), { matchCase: true })).toBe(7)
    expect(indexOfAscii(buffer, asciiNeedle('NEEDLE'), { matchCase: true })).toBe(-1)
  })

  it('中文文件里查找 ASCII 仍然命中', () => {
    const buffer = Buffer.from('中文前缀 foo 后缀', 'utf8')
    expect(indexOfAscii(buffer, asciiNeedle('foo'))).toBe(buffer.indexOf(Buffer.from('foo')))
  })

  it('不把非 ASCII 字节折叠成 ASCII（预筛不会给出假命中）', () => {
    // 0xC1 0x81 之类的续字节不能被当成 'a'
    const buffer = Buffer.from([0xc1, 0x81, 0xc1, 0x81])
    expect(indexOfAscii(buffer, asciiNeedle('a'))).toBe(-1)
  })
})

describe('buildPreview', () => {
  it('短行原样返回，高亮区间用命中位置', () => {
    expect(buildPreview('const foo = 1', 6, 3)).toEqual({
      preview: 'const foo = 1',
      highlight: [6, 9]
    })
  })

  it('长行截断后高亮偏移跟着前缀走', () => {
    const line = `${'a'.repeat(400)}NEEDLE${'b'.repeat(400)}`
    const { preview, highlight } = buildPreview(line, 400, 6)
    // 300 字符窗口 + 两侧的省略号
    expect(preview.length).toBe(302)
    expect(preview.startsWith('…') && preview.endsWith('…')).toBe(true)
    expect(preview.slice(highlight[0], highlight[1])).toBe('NEEDLE')
  })
})

/** 内存文件系统：collectSearchMatches 的 IO 全部注入，不必碰磁盘。 */
function memoryFiles(entries, { delay = 0 } = {}) {
  const files = Object.keys(entries).map((relativePath) => ({
    path: `/root/${relativePath}`,
    relativePath
  }))
  return {
    files: (async function* () {
      for (const file of files) yield file
    })(),
    readFile: async (file) => {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      const text = entries[file.relativePath]
      if (text == null) return null
      const buffer = Buffer.from(text, 'utf8')
      return { buffer, bytes: buffer.length }
    }
  }
}

describe('collectSearchMatches', () => {
  const query = (value, options = {}) => compileQuery({ query: value, ...options })

  it('按文件清单顺序给结果，并发完成次序不影响分组顺序', async () => {
    const entries = {}
    for (let index = 0; index < 24; index += 1) {
      entries[`f${String(index).padStart(2, '0')}.txt`] = `hit ${index}\n`
    }
    const { files, readFile } = memoryFiles(entries, { delay: 1 })
    const result = await collectSearchMatches({
      files,
      compiled: query('hit'),
      readFile,
      concurrency: 8
    })
    expect(result.items.map((item) => item.relativePath)).toEqual(Object.keys(entries))
    expect(result.items.every((item) => item.line === 1)).toBe(true)
  })

  it('ASCII 预筛不改变结果，且跳过解码（含大小写与无命中两种）', async () => {
    const entries = {
      'a.txt': 'const value = NEEDLE\n',
      'b.txt': 'nothing here\n',
      'c.txt': '中文里也有 needle\n'
    }
    const { files, readFile } = memoryFiles(entries)
    const matched = await collectSearchMatches({
      files,
      compiled: query('needle'),
      readFile,
      prefilter: { needle: asciiNeedle('needle'), matchCase: false }
    })
    expect(matched.items.map((item) => item.relativePath)).toEqual(['a.txt', 'c.txt'])
  })

  it('中文查询没有预筛也照样命中', async () => {
    const entries = { 'a.txt': '打开文件查看\n', 'b.txt': '无关\n' }
    const { files, readFile } = memoryFiles(entries)
    const result = await collectSearchMatches({
      files,
      compiled: query('文件'),
      readFile,
      prefilter: asciiNeedle('文件') ? { needle: asciiNeedle('文件') } : null
    })
    expect(result.items).toHaveLength(1)
    expect(result.items[0].column).toBe(3)
  })

  it('shouldScan 过滤掉不匹配 include / exclude 的文件', async () => {
    const entries = { 'a.ts': 'hit\n', 'a.test.ts': 'hit\n', 'b.js': 'hit\n' }
    const { files, readFile } = memoryFiles(entries)
    const filters = { include: parseGlobList('*.ts'), exclude: parseGlobList('*.test.ts') }
    const result = await collectSearchMatches({
      files,
      compiled: query('hit'),
      readFile,
      shouldScan: (file) => passesFileFilters(file.relativePath, filters)
    })
    expect(result.items.map((item) => item.relativePath)).toEqual(['a.ts'])
  })

  it('结果达到 maxResults 就停下并标记 truncated', async () => {
    const entries = { 'a.txt': 'hit\nhit\nhit\nhit\n', 'b.txt': 'hit\n' }
    const { files, readFile } = memoryFiles(entries)
    const result = await collectSearchMatches({
      files,
      compiled: query('hit'),
      readFile,
      limits: { maxResults: 3, maxBytes: 1024 * 1024 }
    })
    expect(result.items).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('字节预算用尽后停止，最多多读一个并发批', async () => {
    const read = []
    const files = (async function* () {
      for (let index = 0; index < 40; index += 1) {
        const name = `f${index}.txt`
        yield { path: name, relativePath: name }
      }
    })()
    const result = await collectSearchMatches({
      files,
      compiled: query('hit'),
      concurrency: 2,
      readFile: async (file) => {
        read.push(file.relativePath)
        const buffer = Buffer.from('hit\n', 'utf8')
        return { buffer, bytes: buffer.length }
      },
      limits: { maxResults: 200, maxBytes: 8 }
    })
    // 预算是「至少不再扩大」的界：并发 worker 手里的那一份可能刚好把额度用完
    expect(read.length).toBeLessThanOrEqual(3)
    expect(result.truncated).toBe(true)
  })

  it('signal 中止后返回已扫到的结果并标记 cancelled', async () => {
    const entries = {}
    for (let index = 0; index < 64; index += 1) entries[`f${index}.txt`] = `hit ${index}\n`
    const { files, readFile } = memoryFiles(entries, { delay: 1 })
    const controller = new AbortController()
    const pending = collectSearchMatches({
      files,
      compiled: query('hit'),
      readFile,
      concurrency: 2,
      signal: controller.signal
    })
    // 让第一批跑起来再中止，覆盖「批内中止」与「批间中止」两条路径
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    const result = await pending
    expect(result.cancelled).toBe(true)
    expect(result.items.length).toBeLessThan(64)
  })

  it('读不出的文件（二进制 / 过大）直接跳过', async () => {
    const files = (async function* () {
      yield { path: 'bin', relativePath: 'bin' }
      yield { path: 'ok.txt', relativePath: 'ok.txt' }
    })()
    const result = await collectSearchMatches({
      files,
      compiled: query('hit'),
      readFile: async (file) =>
        file.relativePath === 'bin' ? null : { buffer: Buffer.from('hit\n'), bytes: 4 }
    })
    expect(result.items.map((item) => item.relativePath)).toEqual(['ok.txt'])
  })
})
