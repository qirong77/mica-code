import { describe, expect, test } from 'bun:test'
import { unwrapHostResult } from './chat-capabilities'

/**
 * 回归：面板读的是 app-server 的载荷，而 `hostTaskRequest` 回的是
 * `{ ok, result }` 信封。直接把信封当载荷读，字段全 undefined，界面就变成
 * 三页签 0/0（看起来像「默认全关」）。
 */
describe('unwrapHostResult', () => {
  test('returns the app-server payload, not the envelope', () => {
    const payload = {
      ok: true,
      selection: { version: 1, disabledSkills: [], disabledTools: [], disabledMcpServers: [] },
      skills: [{ name: 'pdf', description: 'read pdf' }],
      tools: [{ name: 'read_file', description: 'read', source: 'builtin' }],
      mcpServers: [{ name: 'docs', status: 'connected', toolCount: 3 }]
    }
    expect(unwrapHostResult({ ok: true, result: payload })).toEqual(payload)
    // 信封本身没有这些字段——这正是不能直接透传的原因。
    expect(unwrapHostResult({ ok: true, result: payload }).skills).toHaveLength(1)
  })

  test('keeps a failure response as-is', () => {
    expect(unwrapHostResult({ ok: false, error: '会话正在别处运行' })).toEqual({
      ok: false,
      error: '会话正在别处运行'
    })
  })

  test('reports a missing or non-object result instead of returning undefined fields', () => {
    expect(unwrapHostResult(null)).toEqual({ ok: false, error: 'chat host 无响应' })
    expect(unwrapHostResult({ ok: true })).toEqual({ ok: false, error: 'chat host 返回为空' })
    expect(unwrapHostResult({ ok: true, result: 'nope' })).toEqual({
      ok: false,
      error: 'chat host 返回为空'
    })
  })
})
