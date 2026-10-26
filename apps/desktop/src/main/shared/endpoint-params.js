/**
 * 路径参数（`/tabs/:id/...` 里的 `:id`）必须出现在端点声明的 `params` 里。
 *
 * 路由编译只认 `path`，所以漏声明不会影响 HTTP 服务本身；但 MCP 门面
 * （`control-mcp.js` 的 buildActionRequest）是按 `params` 摊到 path/query/body 的：
 * 路径参数没声明，agent 就永远填不上它，`evaluate` / `screenshot` / `waitFor`
 * 这些按窗口或会话操作的 action 全部退化成打到字面量 `:id` 上。
 *
 * 这里按 `path` 里的占位符补齐，缺省插到最前面；文档页与 MCP 清单因此自动一致，
 * 新增端点不必记得手写一遍。
 */
export function withPathParams(endpoints, describe = () => '资源 id') {
  return endpoints.map((endpoint) => {
    const names = String(endpoint.path || '')
      .split('/')
      .filter((segment) => segment.startsWith(':') && segment.length > 1)
      .map((segment) => segment.slice(1))
    if (names.length === 0) return endpoint
    const declared = new Set((endpoint.params || []).map((param) => param.name))
    const missing = names
      .filter((name) => !declared.has(name))
      .map((name) => ({
        name,
        in: 'path',
        required: true,
        description: describe(name, endpoint)
      }))
    if (missing.length === 0) return endpoint
    return { ...endpoint, params: [...missing, ...(endpoint.params || [])] }
  })
}
