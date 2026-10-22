import { describe, expect, it } from 'bun:test'
import {
  editorOptionsForTab,
  documentKey,
  isDocumentKey,
  planDocumentOpen,
  uniqueDocumentTitle
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
