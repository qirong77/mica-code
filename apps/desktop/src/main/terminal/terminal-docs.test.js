import { describe, expect, test } from 'bun:test'
import { compileRoutes, resolveRoute } from '../shared/endpoint-http.js'
import { TERMINAL_CONTROL_PREFIX } from '../../host/terminal-control-core.js'
import { terminalControlTargetPath } from '../../host/terminal-control-proxy.js'
import { TERMINAL_ENDPOINTS, buildDocsMarkdown } from './terminal-docs.js'

/**
 * agent 拿到的地址契约：`MICA_TERMINAL_URL` 是服务根（`/remote/terminal`），
 * 端点路径相对它，示例里的 `$MICA_TERMINAL_URL/sessions` 必须真的能落到一条路由上。
 *
 * 这条测试就是为「文档写了一套路径、代理剥前缀按另一套」准备的：两边一旦分叉，
 * agent 第一次调用就 404。
 */
describe('terminal address contract', () => {
  const routes = compileRoutes(TERMINAL_ENDPOINTS)

  function targetFor(path) {
    const target = terminalControlTargetPath(`${TERMINAL_CONTROL_PREFIX}${path}`)
    expect(target).not.toBeNull()
    return target
  }

  test('every endpoint is reachable through the runtime proxy', () => {
    for (const endpoint of TERMINAL_ENDPOINTS) {
      const path = endpoint.path.replace(':id', 'term-1')
      const target = targetFor(path)
      const [pathname] = target.split('?')
      const method = endpoint.method === 'SSE' ? 'GET' : endpoint.method
      const matched = resolveRoute(routes, method, pathname)
      expect(matched).not.toBeNull()
      expect(matched.endpoint.id).toBe(endpoint.id)
    }
  })

  test('the proxy strips the whole service prefix, not just /remote', () => {
    expect(targetFor('/sessions')).toBe('/sessions')
    expect(targetFor('/sessions/term-1/input')).toBe('/sessions/term-1/input')
    expect(terminalControlTargetPath(`${TERMINAL_CONTROL_PREFIX}/events`, '?since=3')).toBe(
      '/events?since=3'
    )
  })

  test('documented examples use the same base as MICA_TERMINAL_URL', () => {
    const markdown = buildDocsMarkdown({ serviceUrl: 'http://127.0.0.1:9000/remote/terminal' })
    // 服务地址就是 MICA_TERMINAL_URL，示例在它后面直接拼端点路径
    expect(markdown).toContain('服务地址：`http://127.0.0.1:9000/remote/terminal`')
    expect(markdown).toContain('$MICA_TERMINAL_URL/sessions')
    expect(markdown).not.toContain('MICA_TERMINAL_URL/terminal')
    expect(markdown).not.toContain('/remote/terminal/terminal')
    for (const endpoint of TERMINAL_ENDPOINTS) expect(markdown).toContain(endpoint.path)
  })
})
