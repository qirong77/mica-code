import { describe, expect, it } from 'bun:test'
import { remarkAutolinkPunctuation } from './chat-autolink'

function tree(children) {
  return { type: 'root', children }
}

function text(value) {
  return { type: 'text', value }
}

function link(url, value = url) {
  return { type: 'link', url, children: [text(value)] }
}

function run(node) {
  remarkAutolinkPunctuation()(node)
  return node
}

describe('remarkAutolinkPunctuation', () => {
  it('moves the full-width full stop out of the link', () => {
    const result = run(tree([link('http://10.190.46.109:9200。')]))

    expect(result.children).toHaveLength(2)
    expect(result.children[0].type).toBe('link')
    expect(result.children[0].url).toBe('http://10.190.46.109:9200')
    expect(result.children[0].children[0].value).toBe('http://10.190.46.109:9200')
    expect(result.children[1]).toEqual({ type: 'text', value: '。' })
  })

  it('keeps the link when the punctuation is not trailing in the text', () => {
    const result = run(tree([link('https://example.com/a。', '看这里')]))

    expect(result.children).toHaveLength(1)
    expect(result.children[0].url).toBe('https://example.com/a。')
  })

  it('leaves ASCII trailing punctuation untouched', () => {
    const result = run(tree([link('https://example.com/a.')]))

    expect(result.children).toHaveLength(1)
    expect(result.children[0].url).toBe('https://example.com/a.')
  })

  it('handles links nested in list items and blockquotes', () => {
    const result = run(
      tree([
        {
          type: 'blockquote',
          children: [
            { type: 'paragraph', children: [text('部署在 '), link('http://10.190.46.109:9200，')] }
          ]
        }
      ])
    )
    const paragraph = result.children[0].children[0]

    expect(paragraph.children.map((child) => child.type)).toEqual(['text', 'link', 'text'])
    expect(paragraph.children[1].url).toBe('http://10.190.46.109:9200')
    expect(paragraph.children[2].value).toBe('，')
  })

  it('ignores links whose text is not a single text node', () => {
    const node = {
      type: 'link',
      url: 'http://x。',
      children: [text('a'), text('。')]
    }
    const result = run(tree([node]))

    expect(result.children).toHaveLength(1)
    expect(result.children[0].url).toBe('http://x。')
  })
})
