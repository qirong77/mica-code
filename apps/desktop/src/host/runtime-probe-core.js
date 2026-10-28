/**
 * 「这个地址上是不是一台 Mica Code 运行时」的探活（纯逻辑，不依赖 electron，便于单测）。
 *
 * 页面自己判断不了：`fetch('http://other:8787/api/health')` 受 CORS 限制读不到结果，所以
 * 探活由运行时代劳。地址规范化不在本地重写一份，直接用 `@packages/mica-web-shared` 的
 * `normalizeRuntimeAddress`——插件、桌面端开新窗口与这里必须对「`192.168.1.5` 补哪个端口」
 * 给出同一个答案。
 */

import { normalizeRuntimeAddress } from '@packages/mica-web-shared/index.js'

export const PROBE_TIMEOUT_MS = 2000

function probeError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return '连接超时'
  return '无法连接该地址'
}

/** 探活：这个地址上是不是一台 Mica Code 运行时 */
export async function probeRuntime(input, timeoutMs = PROBE_TIMEOUT_MS) {
  const url = normalizeRuntimeAddress(input)
  if (!url) return { ok: false, error: '地址格式不正确' }
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { ok: false, error: `目标地址返回 HTTP ${response.status}` }
    const body = await response.json()
    if (body?.app !== 'mica-code-app') return { ok: false, error: '目标地址不是 Mica Code 运行时' }
    return { ok: true, url, port: Number.isInteger(body.port) ? body.port : null }
  } catch (error) {
    return { ok: false, error: probeError(error) }
  }
}
