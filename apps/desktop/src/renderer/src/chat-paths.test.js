import { describe, expect, it } from 'bun:test'
import {
  findPathCandidates,
  isImagePath,
  looksLikePath,
  parsePathHref,
  pathHref,
  remarkPathLinks,
  splitLocation,
  splitTextByPaths
} from './chat-paths'

describe('looksLikePath', () => {
  it('accepts anchored paths', () => {
    for (const value of ['/Users/a/b', '~/a/b', './src/a.ts', '../b/c', 'C:\\a\\b']) {
      expect(looksLikePath(value)).toBe(true)
    }
  })

  it('accepts relative paths with a directory or an extension', () => {
    expect(looksLikePath('src/app.ts')).toBe(true)
    expect(looksLikePath('packages/mica-tools/utils/display.ts')).toBe(true)
  })

  it('rejects slashed words in prose', () => {
    expect(looksLikePath('and/or')).toBe(false)
    expect(looksLikePath('TCP/IP')).toBe(false)
    expect(looksLikePath('docs/readme')).toBe(false)
    expect(looksLikePath('')).toBe(false)
  })
})

describe('findPathCandidates', () => {
  it('finds an absolute path inside a Chinese sentence', () => {
    const candidates = findPathCandidates('在 /Users/qironglin/Desktop/qirong-application 里找一下')
    expect(candidates).toHaveLength(1)
    expect(candidates[0].path).toBe('/Users/qironglin/Desktop/qirong-application')
  })

  it('keeps the position of the candidate in the source text', () => {
    const text = 'cd /Users/a/b && ls'
    const [candidate] = findPathCandidates(text)
    expect(text.slice(candidate.start, candidate.end)).toBe('/Users/a/b')
  })

  it('strips trailing punctuation', () => {
    const candidates = findPathCandidates('看 /Users/a/b，然后 /Users/c/d.ts。')
    expect(candidates.map((item) => item.path)).toEqual(['/Users/a/b', '/Users/c/d.ts'])
  })

  it('does not cut paths out of URLs or slashed words', () => {
    expect(findPathCandidates('见 https://example.com/a/b 页')).toEqual([])
    expect(findPathCandidates('and/or 都行')).toEqual([])
  })

  it('reads the :line:column suffix', () => {
    const [candidate] = findPathCandidates('at src/app.ts:12:5')
    expect(candidate).toMatchObject({ path: 'src/app.ts', line: 12, column: 5 })
    expect(candidate.text).toBe('src/app.ts:12:5')
  })
})

describe('splitLocation', () => {
  it('understands both suffix shapes', () => {
    expect(splitLocation('/a/b.ts:12')).toEqual({ path: '/a/b.ts', line: 12, column: null })
    expect(splitLocation('/a/b.ts:12:5')).toEqual({ path: '/a/b.ts', line: 12, column: 5 })
    expect(splitLocation('/a/b.ts(12,5)')).toEqual({ path: '/a/b.ts', line: 12, column: 5 })
    expect(splitLocation('/a/b.ts')).toEqual({ path: '/a/b.ts', line: null, column: null })
  })
})

describe('isImagePath', () => {
  it('classifies by extension', () => {
    expect(isImagePath('/a/b.png')).toBe(true)
    expect(isImagePath('/a/b.JPEG')).toBe(true)
    expect(isImagePath('/a/b.ts')).toBe(false)
    expect(isImagePath('/a/b')).toBe(false)
  })
})

describe('splitTextByPaths', () => {
  it('returns text/path segments covering the whole string', () => {
    const segments = splitTextByPaths('先看 /Users/a/b 再看 src/app.ts')
    expect(segments.map((segment) => segment.type)).toEqual(['text', 'path', 'text', 'path'])
    expect(segments.map((segment) => segment.text).join('')).toBe('先看 /Users/a/b 再看 src/app.ts')
  })

  it('returns a single text segment when there is no path', () => {
    expect(splitTextByPaths('没有路径')).toEqual([{ type: 'text', text: '没有路径' }])
    expect(splitTextByPaths('')).toEqual([])
  })
})

describe('path href round-trip', () => {
  it('encodes and decodes the location', () => {
    const href = pathHref({ path: '/a/b.ts', line: 3, column: 7 })
    expect(parsePathHref(href)).toEqual({ path: '/a/b.ts', line: 3, column: 7 })
  })

  it('ignores other hrefs and malformed payloads', () => {
    expect(parsePathHref('https://example.com')).toBeNull()
    expect(parsePathHref('#mica-path=%%%')).toBeNull()
    expect(parsePathHref(undefined)).toBeNull()
  })
})

describe('remarkPathLinks', () => {
  const run = (tree) => {
    remarkPathLinks()(tree)
    return tree
  }

  it('turns paths in text nodes into links', () => {
    const tree = run({
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: '打开 /Users/a/b 看看' }] }
      ]
    })
    const children = tree.children[0].children
    expect(children.map((child) => child.type)).toEqual(['text', 'link', 'text'])
    expect(parsePathHref(children[1].url).path).toBe('/Users/a/b')
    expect(children[1].children[0].value).toBe('/Users/a/b')
  })

  it('leaves code blocks and existing links alone', () => {
    const tree = run({
      type: 'root',
      children: [
        { type: 'code', value: 'cat /Users/a/b' },
        { type: 'paragraph', children: [{ type: 'inlineCode', value: '/Users/a/b' }] },
        {
          type: 'paragraph',
          children: [
            { type: 'link', url: 'https://example.com', children: [{ type: 'text', value: '/x' }] }
          ]
        }
      ]
    })
    expect(tree.children[0].type).toBe('code')
    expect(tree.children[1].children[0].type).toBe('inlineCode')
    expect(tree.children[2].children[0].url).toBe('https://example.com')
  })
})
