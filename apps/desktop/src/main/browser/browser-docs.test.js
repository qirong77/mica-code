import { describe, expect, it } from 'bun:test'
import {
  BROWSER_ENDPOINTS,
  buildDocsMarkdown,
  buildSkillMarkdown,
  capabilityCatalog
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
})

describe('buildSkillMarkdown', () => {
  const markdown = buildSkillMarkdown()

  it('is a valid skill document with front matter', () => {
    expect(markdown.startsWith('---\n')).toBe(true)
    expect(markdown).toContain('name: mica-browser')
    expect(markdown).toContain('description:')
  })

  it('tells the agent how to reach the service and claim ownership', () => {
    expect(markdown).toContain('$MICA_BROWSER_URL')
    expect(markdown).toContain('$MICA_BROWSER_OWNER')
    expect(markdown).toContain('x-mica-owner')
  })

  it('lists the endpoints so the agent can pick one without guessing', () => {
    for (const endpoint of BROWSER_ENDPOINTS) {
      expect(markdown).toContain(endpoint.path)
    }
  })
})
