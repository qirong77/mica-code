import { describe, expect, test } from 'bun:test'
import { compileRoutes, resolveRoute } from '../shared/endpoint-http.js'
import { TERMINAL_CONTROL_PREFIX } from '../../host/terminal-control-core.js'
import { terminalControlTargetPath } from '../../host/terminal-control-proxy.js'
import { TERMINAL_ENDPOINTS, TERMINAL_GUIDE, buildDocsMarkdown } from './terminal-docs.js'

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

  test('documents logical matching separately from the unchanged visual screen', () => {
    const wait = TERMINAL_ENDPOINTS.find((endpoint) => endpoint.id === 'waitFor')
    const params = Object.fromEntries(wait.params.map((param) => [param.name, param.description]))
    expect(params.text).toContain('只拼接 xterm 软换行')
    expect(params.text).toContain('保留真实换行')
    expect(params.regex).toContain('真实换行仍为 \\n')
    expect(params.skipEcho).toContain('false 可匹配回显')
    expect(params.skipEcho).toContain('返回 screen 始终不变')
    expect(wait.returns).toContain('不附加逻辑文本')
    expect(TERMINAL_GUIDE).toContain('xterm isWrapped')
    expect(TERMINAL_GUIDE).toContain('原始回显及光标坐标')
  })

  test('distinguishes shell exit and idle from command success with safe exit-code examples', () => {
    const wait = TERMINAL_ENDPOINTS.find((endpoint) => endpoint.id === 'waitFor')
    const params = Object.fromEntries(wait.params.map((param) => [param.name, param.description]))
    expect(params.expectExitCode).toContain('PTY/shell 进程退出')
    expect(params.expectExitCode).toContain('不是 shell 内任意命令的退出码')
    expect(params.idleMs).toContain('不代表命令结束或成功')
    expect(TERMINAL_GUIDE).not.toContain('判断命令成败优先用 expectExitCode 或 idleMs')
    expect(TERMINAL_GUIDE).toContain('pwd; mica_rc=$?; printf "\\nMICA_RC_%s_END\\n" "$mica_rc"')
    expect(TERMINAL_GUIDE).toContain('waitFor({regex:"MICA_RC_[0-9]+_END"})')
    expect(TERMINAL_GUIDE).toContain('每次使用唯一标记避免命中旧输出')
    expect(TERMINAL_GUIDE).toContain('仅在专用、允许结束的 POSIX shell 终端里')
    expect(TERMINAL_GUIDE).toContain('pwd; mica_rc=$?; exit "$mica_rc"')
    expect(buildDocsMarkdown()).toContain(TERMINAL_GUIDE)
  })
})
