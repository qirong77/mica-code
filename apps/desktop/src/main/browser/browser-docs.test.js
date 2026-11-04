import { describe, expect, it } from 'bun:test'
import {
  BROWSER_GUIDE,
  BROWSER_ENDPOINTS,
  buildDocsMarkdown,
  capabilityCatalog,
  suggestActionIds
} from './browser-docs.js'

describe('BROWSER_ENDPOINTS', () => {
  it('has unique ids and unique method+path pairs', () => {
    const ids = BROWSER_ENDPOINTS.map((endpoint) => endpoint.id)
    // GET 与 POST 共用一条路径是允许的（列表/新建），同方法同路径才是路由冲突
    const routes = BROWSER_ENDPOINTS.map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(routes).size).toBe(routes.length)
  })

  it('describes every endpoint well enough to render a docs page', () => {
    for (const endpoint of BROWSER_ENDPOINTS) {
      expect(endpoint.summary.length).toBeGreaterThan(0)
      expect(['GET', 'POST', 'SSE']).toContain(endpoint.method)
      expect(endpoint.path.startsWith('/browser/')).toBe(true)
      expect(Array.isArray(endpoint.params)).toBe(true)
      for (const param of endpoint.params) {
        expect(param.name.length).toBeGreaterThan(0)
        expect(['path', 'query', 'body', 'header']).toContain(param.in)
        expect(typeof param.required).toBe('boolean')
        expect(param.description.length).toBeGreaterThan(0)
      }
      // 手写示例是「值得展开写一段」的那几个端点；设置页会按 method/params 生成其余示例
      if (endpoint.example) {
        expect(endpoint.example.includes('curl')).toBe(true)
        expect(endpoint.example).toContain('$MICA_BROWSER_URL')
      }
    }
  })

  it('keeps the capabilities catalog aligned with the endpoint list', () => {
    const catalog = capabilityCatalog()
    expect(catalog).toHaveLength(BROWSER_ENDPOINTS.length)
    expect(catalog.map((item) => item.path)).toEqual(BROWSER_ENDPOINTS.map((item) => item.path))
  })
})

describe('buildDocsMarkdown', () => {
  const markdown = buildDocsMarkdown({ serviceUrl: 'http://127.0.0.1:18767' })

  it('documents every endpoint and the service url', () => {
    expect(markdown).toContain('http://127.0.0.1:18767')
    for (const endpoint of BROWSER_ENDPOINTS) {
      expect(markdown).toContain(endpoint.path)
    }
  })

  it('states the lifecycle rules a human needs first', () => {
    expect(markdown).toContain('受控浏览器')
    expect(markdown).toContain('只是隐藏')
  })

  // 文档要「一次说清」：每个动作的必填参数、以及 control 工具里怎么传
  it('names the required params of each action and the control call shape', () => {
    expect(markdown).toContain('必填参数：id、expression')
    expect(markdown).toContain('control({ action: "evaluate"')
    expect(markdown).toContain('不带 `action` 调用')
  })
})

describe('BROWSER_GUIDE', () => {
  // MCP 的 doc 列表里会带这段短提示：它得是可执行的建议，而不是又一份端点清单。
  it('carries actionable hints without a stale endpoint list', () => {
    expect(BROWSER_GUIDE.length).toBeGreaterThan(0)
    expect(BROWSER_GUIDE).toContain('waitFor')
    for (const endpoint of BROWSER_ENDPOINTS) {
      expect(BROWSER_GUIDE).not.toContain(endpoint.path)
    }
  })

  // 高频误用：action 名靠猜（`press`）、按键写键盘码（`Meta+Shift+KeyB`）、漏必填参数。
  // 文档侧只能提前说清，所以这几件事必须在 guide 里。
  it('spells out the action-name, key-syntax and required-param rules', () => {
    expect(BROWSER_GUIDE).toContain('不带 action')
    expect(BROWSER_GUIDE).toContain('按键是 keys')
    expect(BROWSER_GUIDE).toContain('KeyB')
    expect(BROWSER_GUIDE).toContain('evaluate 要 expression')
    expect(BROWSER_GUIDE).toContain('scroll 要 deltaY')
  })

  // 窗口只在演示时显示：模型以前会把「先 show 一下」当成让操作生效的前置步骤，
  // 结果用户眼前反复弹窗。这条规则必须写在 guide 里，端点摘要也跟着这么写。
  it('tells the model to keep the window hidden unless demoing', () => {
    expect(BROWSER_GUIDE).toContain('不需要先 showBrowser')
    const show = BROWSER_ENDPOINTS.find((endpoint) => endpoint.id === 'showBrowser')
    expect(show.summary).toContain('明确要给用户演示')
  })
})

describe('suggestActionIds', () => {
  const ids = BROWSER_ENDPOINTS.map((endpoint) => endpoint.id)

  it('maps the synonyms models actually type onto the legal action', () => {
    expect(suggestActionIds('press', ids)).toEqual(['keys'])
    expect(suggestActionIds('keyboard', ids)).toEqual(['keys'])
    expect(suggestActionIds('goto', ids)).toEqual(['navigate'])
    expect(suggestActionIds('readContent', ids)).toEqual(['content'])
    expect(suggestActionIds('eval', ids)).toEqual(['evaluate'])
  })

  it('repairs case and separator drift, and suggests by edit distance', () => {
    expect(suggestActionIds('listbrowsers', ids)).toEqual(['listBrowsers'])
    expect(suggestActionIds('list-tabs', ids)).toEqual(['listTabs'])
    expect(suggestActionIds('evaluat', ids)).toEqual(['evaluate'])
  })

  it('stays quiet when nothing is close instead of dumping the whole catalog', () => {
    expect(suggestActionIds('nope', ids)).toEqual([])
    expect(suggestActionIds('', ids)).toEqual([])
  })
})
