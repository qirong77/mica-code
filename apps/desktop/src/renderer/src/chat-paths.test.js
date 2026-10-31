import { describe, expect, it } from 'bun:test'
import {
  findImageReferences,
  findPathCandidates,
  isImagePath,
  looksLikePath,
  parsePathHref,
  pathHref,
  remarkPathLinks,
  splitLocation,
  splitTextByCapabilityRefs,
  splitTextByImages,
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

  it('recognizes a path right after a colon, half or full width', () => {
    expect(findPathCandidates('目录：/Users/a/b').map((item) => item.path)).toEqual(['/Users/a/b'])
    expect(findPathCandidates('config:/Users/a/b.json').map((item) => item.path)).toEqual([
      '/Users/a/b.json'
    ])
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
      children: [{ type: 'paragraph', children: [{ type: 'text', value: '打开 /Users/a/b 看看' }] }]
    })
    const children = tree.children[0].children
    expect(children.map((child) => child.type)).toEqual(['text', 'link', 'text'])
    expect(parsePathHref(children[1].url).path).toBe('/Users/a/b')
    expect(children[1].children[0].value).toBe('/Users/a/b')
  })

  it('keeps fenced code literal and links inline code, leaving existing links alone', () => {
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
    // 行内代码换成「<code> 外观 + 可点孩子」：hName 让 mdast 渲染成 code 元素
    const inline = tree.children[1].children[0]
    expect(inline.data.hName).toBe('code')
    expect(inline.children[0].type).toBe('link')
    expect(parsePathHref(inline.children[0].url).path).toBe('/Users/a/b')
    expect(tree.children[2].children[0].url).toBe('https://example.com')
  })
})

describe('image references', () => {
  it('finds the markdown form a user attachment is stored as', () => {
    // 用户上传的图片在会话里就是这段文本，分享出去后接收方靠它看图
    const text = '识别这个谱 [Image](~/.mica/images/image-2b3b.jpg)'
    expect(findImageReferences(text)).toEqual([
      { alt: 'Image', source: '~/.mica/images/image-2b3b.jpg' }
    ])
    expect(findImageReferences('![谱](/tmp/a.png)')).toEqual([{ alt: '谱', source: '/tmp/a.png' }])
  })

  it('keeps one entry per source and ignores plain links', () => {
    const text = '[Image](a.png) [Image](a.png) [docs](https://example.com)'
    expect(findImageReferences(text).map((item) => item.source)).toEqual(['a.png'])
  })

  it('returns nothing for text without references', () => {
    expect(findImageReferences('')).toEqual([])
    expect(findImageReferences('看看 /Users/a/b.ts')).toEqual([])
    expect(findImageReferences(undefined)).toEqual([])
  })

  it('splits the message body around images, keeping the rest verbatim', () => {
    const segments = splitTextByImages('before [Image](~/.mica/images/a.png) after')
    expect(segments).toEqual([
      { type: 'text', text: 'before ' },
      { type: 'image', alt: 'Image', source: '~/.mica/images/a.png' },
      { type: 'text', text: ' after' }
    ])
  })

  it('handles images at the edges and repeated references', () => {
    expect(splitTextByImages('[Image](a.png)')).toEqual([
      { type: 'image', alt: 'Image', source: 'a.png' }
    ])
    const many = splitTextByImages('![x](a.png)![y](b.png)')
    expect(many.filter((s) => s.type === 'image').map((s) => s.source)).toEqual(['a.png', 'b.png'])
  })

  it('leaves a message without images as a single text run', () => {
    // 调用方据此保持原有渲染路径（path 识别等）不变
    expect(splitTextByImages('纯文本 /Users/a/b.ts')).toEqual([
      { type: 'text', text: '纯文本 /Users/a/b.ts' }
    ])
    expect(splitTextByImages('')).toEqual([])
  })

  it('is not confused by consecutive calls (shared regex state)', () => {
    const text = '[Image](a.png) [Image](b.png)'
    expect(findImageReferences(text)).toHaveLength(2)
    expect(findImageReferences(text)).toHaveLength(2)
    expect(splitTextByImages(text).filter((s) => s.type === 'image')).toHaveLength(2)
  })

  it('splits the composer capability references out of the written text', () => {
    // `/` 补全插进来的就是这一段；消息体把它收成 `skill:cooper` 一枚短标签
    expect(splitTextByCapabilityRefs('用 [skill:cooper](/h/skills/cooper/SKILL.md) 看下')).toEqual([
      { type: 'text', text: '用 ' },
      { type: 'capability', kind: 'skill', name: 'cooper', target: '/h/skills/cooper/SKILL.md' },
      { type: 'text', text: ' 看下' }
    ])
  })

  it('reads an angle-wrapped target and still decodes the encoded form', () => {
    expect(splitTextByCapabilityRefs('[skill:ask](</home/a b/SKILL.md>)')[0].target).toBe(
      '/home/a b/SKILL.md'
    )
    // 手写或旧会话里的百分号编码形式照旧认
    expect(splitTextByCapabilityRefs('[skill:ask](/home/a%20b/SKILL.md)')[0].target).toBe(
      '/home/a b/SKILL.md'
    )
    const [broken] = splitTextByCapabilityRefs('[mcp:x](http://h/%E0%A4%A)')
    expect(broken.target).toBe('http://h/%E0%A4%A')
  })

  it('leaves ordinary markdown links and plain text alone', () => {
    expect(splitTextByCapabilityRefs('看 [文档](https://example.com)')).toEqual([
      { type: 'text', text: '看 [文档](https://example.com)' }
    ])
    expect(splitTextByCapabilityRefs('')).toEqual([])
  })
})
