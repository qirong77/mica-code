import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildSystemChecks } from './system-core.js'
import { createSystemService } from './system-service.js'

/**
 * 服务的两条端点：读状态、打开面板。这里给假的探测器与假的 openExternal —— 真探测要
 * Electron 的 app 身份（system-host.js），真打开会弹系统设置。
 */
const opened = []
let service = null
let base = ''

beforeAll(async () => {
  service = createSystemService({
    probe: () =>
      buildSystemChecks({
        platform: 'darwin',
        accessibility: true,
        screenRecording: 'not-determined',
        commandLineTools: {
          xcodePath: '/Library/Developer/CommandLineTools',
          clangVersion: '16.0.0'
        }
      }),
    openSettings: async (pane) => {
      opened.push(pane)
    }
  })
  const port = await service.listen(0)
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await service.close()
})

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

describe('system service', () => {
  it('reports the checks the probe returned', async () => {
    const result = await call('/checks')
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.platform).toBe('darwin')
    expect(result.body.checks.map((check) => check.status)).toEqual([
      'granted',
      'denied',
      'granted'
    ])
  })

  it('opens a pane that the manifest declares', async () => {
    const pane = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    const result = await call('/open-settings', { method: 'POST', body: { pane } })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, pane })
    expect(opened).toEqual([pane])
  })

  it('refuses a pane outside the manifest instead of opening it', async () => {
    const before = opened.length
    const result = await call('/open-settings', {
      method: 'POST',
      body: { pane: 'https://example.com/phish' }
    })
    expect(result.status).toBe(400)
    expect(result.body.ok).toBe(false)
    expect(result.body.error).toContain('不认识的系统设置面板')
    expect(opened.length).toBe(before)
  })

  it('answers 404 for paths it does not serve', async () => {
    const result = await call('/docs')
    expect(result.status).toBe(404)
    expect(result.body.ok).toBe(false)
  })
})
