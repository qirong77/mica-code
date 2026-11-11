import { describe, expect, it } from 'bun:test'
import {
  documentKey,
  editorOptionsForTab,
  editorSurface,
  isDocumentKey,
  isMarkdownFile,
  planDocumentOpen,
  planTextReplacement,
  uniqueDocumentTitle,
  writeModelText
} from './files-document'

function tabFor(id, content = '') {
  return { path: documentKey(id), model: { getValue: () => content, setValue: () => {} } }
}

describe('documentKey', () => {
  it('keeps ids that contain path characters inside one segment', () => {
    // 不编码的话 monaco 会把 `a/b:c` 解析成 host `a` + path `/b:c`
    expect(documentKey('tool-1:output')).toBe('mica-document://tool-1%3Aoutput')
    expect(documentKey('a/b')).toBe('mica-document://a%2Fb')
    expect(documentKey('#x')).toBe('mica-document://%23x')
  })

  it('falls back to a stable default for empty ids', () => {
    expect(documentKey('')).toBe('mica-document://document')
    expect(documentKey(null)).toBe('mica-document://document')
    expect(documentKey('   ')).toBe('mica-document://document')
  })

  it('tags virtual documents distinctly from workspace paths', () => {
    expect(isDocumentKey(documentKey('x'))).toBe(true)
    expect(isDocumentKey('/Users/me/a.ts')).toBe(false)
    expect(isDocumentKey(null)).toBe(false)
  })
})

describe('planDocumentOpen', () => {
  it('creates when nothing is open', () => {
    const plan = planDocumentOpen([], 'tool-1:output')
    expect(plan.reuse).toBeNull()
    expect(plan.key).toBe('mica-document://tool-1%3Aoutput')
  })

  it('reuses the tab of the same tool call instead of creating a second model', () => {
    const existing = tabFor('tool-1:output', 'old')
    const plan = planDocumentOpen([tabFor('tool-1:input'), existing], 'tool-1:output')
    expect(plan.reuse).toBe(existing)
  })

  it('ignores tabs that have no model yet', () => {
    const loading = { path: documentKey('tool-1:output'), model: null }
    expect(planDocumentOpen([loading], 'tool-1:output').reuse).toBeNull()
  })

  it('keeps workspace files and documents apart', () => {
    const file = { path: '/tmp/a.json', model: {} }
    expect(planDocumentOpen([file], 'a.json').reuse).toBeNull()
  })
})

describe('uniqueDocumentTitle', () => {
  it('keeps the first title as is', () => {
    expect(uniqueDocumentTitle([], 'Shell 参数', documentKey('a'))).toBe('Shell 参数')
  })

  it('numbers later documents that share a title', () => {
    const tabs = [
      { path: documentKey('a'), name: 'Shell 参数' },
      { path: documentKey('b'), name: 'Shell 参数 (2)' }
    ]
    expect(uniqueDocumentTitle(tabs, 'Shell 参数', documentKey('c'))).toBe('Shell 参数 (3)')
  })

  it('ignores the tab being reopened', () => {
    const tabs = [{ path: documentKey('a'), name: 'Shell 参数' }]
    expect(uniqueDocumentTitle(tabs, 'Shell 参数', documentKey('a'))).toBe('Shell 参数')
  })

  it('falls back to a default title', () => {
    expect(uniqueDocumentTitle([], '', documentKey('a'))).toBe('预览')
  })
})

describe('editorOptionsForTab', () => {
  it('locks documents and unlocks workspace files', () => {
    // editor 是唯一实例，切页签必须把它带回可写，否则磁盘文件也编辑不了
    expect(editorOptionsForTab({ path: documentKey('a'), readOnly: true })).toEqual({
      readOnly: true
    })
    expect(editorOptionsForTab({ path: '/tmp/a.json' })).toEqual({ readOnly: false })
    expect(editorOptionsForTab(null)).toEqual({ readOnly: false })
  })
})

describe('isMarkdownFile', () => {
  it('只认 .md / .markdown', () => {
    expect(isMarkdownFile('/tmp/notes.md')).toBe(true)
    expect(isMarkdownFile('/tmp/notes.MARKDOWN')).toBe(true)
    expect(isMarkdownFile('C:\\work\\需求.md')).toBe(true)
  })

  it('mdx、没有后缀和虚拟文档都不算', () => {
    // .mdx 里是 JSX，Markdown 往返表达不了，按普通文本开更安全
    expect(isMarkdownFile('/tmp/page.mdx')).toBe(false)
    expect(isMarkdownFile('/tmp/Makefile')).toBe(false)
    expect(isMarkdownFile('')).toBe(false)
    expect(isMarkdownFile(documentKey('tool-1'))).toBe(false)
  })
})

describe('editorSurface', () => {
  it('markdown 页签用 Markdown 编辑器，其他一律 monaco', () => {
    expect(editorSurface({ path: '/tmp/a.md', markdown: true })).toBe('markdown')
    expect(editorSurface({ path: '/tmp/a.js' })).toBe('source')
    expect(editorSurface(null)).toBe('source')
  })
})

describe('planTextReplacement', () => {
  it('相同文本不需要替换', () => {
    expect(planTextReplacement('abc', 'abc')).toBeNull()
  })

  it('只圈出真正变化的那一段', () => {
    // 每敲一个字都整篇 setValue 会丢掉 monaco 的撤销栈，并对整篇重新分词
    expect(planTextReplacement('hello world', 'hello there')).toEqual({
      start: 6,
      end: 11,
      text: 'there'
    })
  })

  it('纯插入与纯删除', () => {
    expect(planTextReplacement('ab', 'axb')).toEqual({ start: 1, end: 1, text: 'x' })
    expect(planTextReplacement('axb', 'ab')).toEqual({ start: 1, end: 2, text: '' })
    expect(planTextReplacement('', 'a')).toEqual({ start: 0, end: 0, text: 'a' })
  })

  it('整段替换与重复字符不会错位', () => {
    expect(planTextReplacement('aaa', 'aaaa')).toEqual({ start: 3, end: 3, text: 'a' })
    expect(planTextReplacement('x', 'y')).toEqual({ start: 0, end: 1, text: 'y' })
  })
})

describe('writeModelText', () => {
  /** 只实现 writeModelText 用到的那几个方法：偏移量与行列互转按真实文本算。 */
  function fakeModel(text) {
    let value = text
    const lineStarts = () => {
      const starts = [0]
      for (let index = 0; index < value.length; index += 1)
        if (value[index] === '\n') starts.push(index + 1)
      return starts
    }
    const offsetOf = (line, column) => lineStarts()[line - 1] + column - 1
    const positionOf = (offset) => {
      const starts = lineStarts()
      let line = 0
      while (line + 1 < starts.length && starts[line + 1] <= offset) line += 1
      return { lineNumber: line + 1, column: offset - starts[line] + 1 }
    }
    return {
      edits: [],
      getValue: () => value,
      getPositionAt: positionOf,
      applyEdits(edits) {
        for (const edit of edits) {
          const range = edit.range
          const from = offsetOf(range.startLineNumber, range.startColumn)
          const to = offsetOf(range.endLineNumber, range.endColumn)
          value = value.slice(0, from) + edit.text + value.slice(to)
          this.edits.push({ start: from, end: to, text: edit.text })
        }
      }
    }
  }

  it('把整篇新正文写回模型，且只动变化的一段', () => {
    const model = fakeModel('第一行\n第二行\n')
    expect(writeModelText(model, '第一行\n第二行改了\n')).toBe(true)
    expect(model.getValue()).toBe('第一行\n第二行改了\n')
    expect(model.edits).toHaveLength(1)
    expect(model.edits[0]).toMatchObject({ start: 7, end: 7, text: '改了' })
  })

  it('跨行修改也能落到正确的位置', () => {
    const model = fakeModel('a\nb\nc')
    expect(writeModelText(model, 'a\nc')).toBe(true)
    expect(model.getValue()).toBe('a\nc')
    expect(model.edits[0]).toMatchObject({ start: 2, end: 4, text: '' })
  })

  it('没有变化时不碰模型', () => {
    const model = fakeModel('same')
    expect(writeModelText(model, 'same')).toBe(false)
    expect(model.edits).toHaveLength(0)
  })
})
