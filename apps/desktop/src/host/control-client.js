/**
 * 运行时访问「主进程受控服务」的客户端：受控浏览器与终端控制都只监听 Unix socket，
 * 而 `fetch` 不支持 socket，这里统一用 node:http 的 request + `socketPath`。
 *
 * 抽出来是为了两个门面（browser-control.js / terminal-control.js）不会各写一套超时、
 * 错误文案和 JSON 校验。
 */

import { request as httpRequest } from 'node:http'

export const DEFAULT_REQUEST_TIMEOUT_MS = 4000

export function openSocketRequest(
  socketPath,
  path,
  { method = 'GET', body, headers, signal, timeoutMs, label = '本机服务' } = {}
) {
  if (!socketPath) {
    return Promise.reject(new Error(`当前没有${label}（不在 Mica Code 应用里运行）`))
  }
  const payload = body === undefined ? null : JSON.stringify(body)

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path,
        method,
        headers: {
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
          ...headers
        }
      },
      resolve
    )
    request.on('error', reject)
    if (timeoutMs) {
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`${label}请求超时`)))
    }
    if (signal) {
      if (signal.aborted) {
        request.destroy(new Error('已取消'))
        return
      }
      signal.addEventListener('abort', () => request.destroy(new Error('已取消')), { once: true })
    }
    if (payload) request.write(payload)
    request.end()
  })
}

export async function readAllText(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** 发一个 JSON 请求；HTTP 错误码或 `{ ok: false }` 都转成可读错误 */
export async function requestJson(
  socketPath,
  path,
  { method = 'GET', body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, label = '本机服务' } = {}
) {
  const response = await openSocketRequest(socketPath, path, {
    method,
    body,
    timeoutMs,
    label
  })
  const text = await readAllText(response)
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${label}返回了非 JSON 响应（HTTP ${response.statusCode}）`)
  }
  if (response.statusCode >= 400 || payload?.ok === false) {
    throw new Error(payload?.error || `${label}返回 HTTP ${response.statusCode}`)
  }
  return payload
}
