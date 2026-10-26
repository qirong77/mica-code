import { describe, expect, it } from 'bun:test'

import { BROWSER_ENDPOINTS } from '../browser/browser-docs.js'
import { TERMINAL_ENDPOINTS } from '../terminal/terminal-docs.js'
import { withPathParams } from './endpoint-params.js'

describe('withPathParams', () => {
  it('把路径里的 :id 补成必填 path 参数', () => {
    const [endpoint] = withPathParams(
      [{ id: 'click', path: '/browser/tabs/:id/click', params: [{ name: 'selector', in: 'body' }] }],
      () => '标签页 id'
    )

    expect(endpoint.params[0]).toEqual({
      name: 'id',
      in: 'path',
      required: true,
      description: '标签页 id'
    })
    // 已有参数原样保留在后面
    expect(endpoint.params[1]).toEqual({ name: 'selector', in: 'body' })
  })

  it('没有占位符的端点不动', () => {
    const input = [{ id: 'list', path: '/browser/tabs', params: [] }]
    expect(withPathParams(input)).toEqual(input)
  })

  it('已经声明过的不重复补', () => {
    const declared = { name: 'id', in: 'path', required: true, description: '手写' }
    const [endpoint] = withPathParams([
      { id: 'close', path: '/browser/browsers/:id/close', params: [declared] }
    ])

    expect(endpoint.params).toEqual([declared])
  })
})

/**
 * 真实目录的回归：路径占位符必须都声明成 path 参数，否则 MCP 门面填不上它，
 * 按标签页 / 会话操作的 action 会打到字面量 `:id` 上（agent 侧表现为
 * 「标签页不存在：:id」）。
 */
describe('endpoint catalogs declare every path parameter', () => {
  for (const [name, endpoints] of [
    ['browser', BROWSER_ENDPOINTS],
    ['terminal', TERMINAL_ENDPOINTS]
  ]) {
    it(name, () => {
      for (const endpoint of endpoints) {
        const placeholders = String(endpoint.path)
          .split('/')
          .filter((segment) => segment.startsWith(':'))
          .map((segment) => segment.slice(1))
        const declared = new Set((endpoint.params || []).map((param) => param.name))
        for (const placeholder of placeholders) {
          expect({ id: endpoint.id, missing: placeholder, ok: declared.has(placeholder) }).toEqual({
            id: endpoint.id,
            missing: placeholder,
            ok: true
          })
        }
      }
    })
  }
})
