/**
 * 「这个地址上是不是一台 Mica Code 运行时」的探活（纯逻辑，不依赖 electron，便于单测）。
 *
 * 页面自己判断不了：`fetch('http://other:8787/api/health')` 受 CORS 限制读不到结果，所以
 * 探活由运行时代劳。地址规范化不在本地重写一份，直接用 `@packages/mica-web-shared` 的
 * `normalizeRuntimeAddress`——插件、桌面端开新窗口与这里必须对「`192.168.1.5` 补哪个端口」
 * 给出同一个答案。
 */

import {
  normalizeEntryAddress,
  normalizeRuntimeAddress,
  relayTokenOf
} from '@packages/mica-web-shared/index.js'

export const PROBE_TIMEOUT_MS = 2000

function probeError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return '连接超时：确认那台机器开着 Mica、地址和网络都可达，端口没被防火墙拦住'
  }
  return '无法连接该地址：可能不在同一网络，或对方没在运行'
}

/** 探活：这个地址上是不是一台 Mica Code 运行时 */
export async function probeRuntime(input, timeoutMs = PROBE_TIMEOUT_MS) {
  // 带 `?t=` 的是一条中转机链接（mobile-relay 借出去的入口）：它连的不是「那个 origin
  // 上的运行时」，而是「中转机转给某一台机器的界面」，判定方式完全不同。
  const token = relayTokenOf(input)
  if (token) return probeRelay(input, token, timeoutMs)

  const url = normalizeRuntimeAddress(input)
  if (!url) return { ok: false, error: '地址格式不正确' }
  // 探不通时先别急着报网络错误：用户很可能粘的是中转机的裸域名，
  // 而那条链接必须带 `?t=`。问一句能把「连不上」变成「该怎么做」。
  const miss = async (reason) =>
    (await relayHintFor(input, timeoutMs)) ?? { ok: false, error: reason }
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return await miss(`目标地址返回 HTTP ${response.status}`)
    const body = await response.json()
    if (body?.app !== 'mica-code-app') return await miss('目标地址不是 Mica Code 运行时')
    return {
      ok: true,
      kind: 'runtime',
      url,
      port: Number.isInteger(body.port) ? body.port : null,
      // 'off' 表示对方没开「局域网/公网可访问」：连过去只会拿到 404，
      // 所以由调用方决定先提示，而不是替用户打开一个打不开的窗口。
      access: body.access === 'password' ? 'password' : body.access === 'off' ? 'off' : null
    }
  } catch (error) {
    return await miss(probeError(error))
  }
}

/**
 * 这个 origin 上是不是一台中转机？
 *
 * 判据：中转机对**不带令牌**的 `/api/health` 只回 `{ ok, agents: <机器数> }`——没有
 * `app` 字段，也不该有。追到就说明地址本身是通的，缺的只是链接里的 `?t=`。
 * 追不到（超时、不是中转机）返回 null，调用方沿用原来的错误。
 */
async function relayHintFor(input, timeoutMs) {
  const entry = normalizeEntryAddress(input)
  if (!entry) return null
  let origin
  try {
    origin = new URL(entry).origin
  } catch {
    return null
  }
  try {
    const response = await fetch(`${origin}/api/health`, {
      // 这只是一次补充说明，不该让等待时间翻倍
      signal: AbortSignal.timeout(Math.min(timeoutMs, 1500))
    })
    if (!response.ok) return null
    const body = await response.json()
    if (!Number.isInteger(body?.agents) || typeof body.label === 'string') return null
    return {
      ok: false,
      error:
        '这是一台中转机：要连它后面那台机器，请粘贴完整链接（带 ?t=…，在那台机器的 Mobile Relay 面板里可以复制）'
    }
  } catch {
    return null
  }
}

/**
 * 探一台中转机后面那台机器。
 *
 * 判据是中转机的 `/api/health?t=<token>` 会回 `label`（那台机器的名字）；`t` 不认时它
 * 只回 `{ ok, agents }`——两种情况都是 200，所以必须看字段，不能看状态码。
 *
 * 返回的 `url` 是**完整入口**（原样保留 `t` 与 `session`）：打开它才是那个界面。
 */
async function probeRelay(input, token, timeoutMs) {
  const url = normalizeEntryAddress(input)
  if (!url) return { ok: false, error: '地址格式不正确' }
  const origin = new URL(url).origin
  try {
    const response = await fetch(`${origin}/api/health?t=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) return { ok: false, error: `中转机返回 HTTP ${response.status}` }
    const body = await response.json()
    if (typeof body?.label !== 'string') {
      return {
        ok: false,
        error:
          '这个中转机不认识链接里的访问口令：确认链接里的 t=… 是最新那条（那台机器重新注册后旧口令会失效）'
      }
    }
    return {
      ok: true,
      kind: 'relay',
      url,
      port: null,
      // 口令是「这台机器怎么被借出去」，和中转机后面那台机器自己的远程访问口令无关
      access: null,
      label: body.label,
      // 桥没连上时页面会是自动重试那一页：能打开，但此刻没有内容
      online: body.agentOnline !== false
    }
  } catch (error) {
    return { ok: false, error: probeError(error) }
  }
}
