/**
 * 拆掉 `hostTaskRequest` 的 `{ ok, result }` 信封。
 *
 * app-server 的载荷在 `result` 里，而 `hostTaskRequest` 统一包了一层信封（为了让
 * 渲染层区分「请求本身成功」和「业务结果」）。把信封当成载荷读，字段全是 undefined，
 * 能力面板就会显示成三页签都是 0/0——看起来像「默认全关」。
 */
export function unwrapHostResult(response) {
  if (!response) return { ok: false, error: 'chat host 无响应' }
  if (response.ok === false) return response
  const payload = response.result
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'chat host 返回为空' }
  return payload
}
