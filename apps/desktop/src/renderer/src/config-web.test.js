import { afterEach, describe, expect, it } from 'bun:test'
import { createDesktopConfigWebClient } from './config-web.js'

const originalWindow = globalThis.window
afterEach(() => {
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
})

describe('plugin action workspace transport', () => {
  it('forwards the supplied workspace, and does not invent one without context', async () => {
    const calls = []
    globalThis.window = {
      mica: {
        configWeb: {
          invoke: async (...args) => {
            calls.push(args)
            return { message: 'ok' }
          }
        }
      }
    }
    const client = createDesktopConfigWebClient()
    await client.runPluginAction('harness-review', 'open-review', {}, '/workspace/current')
    await client.runPluginAction('video', 'check')
    expect(calls).toEqual([
      [
        'runPluginAction',
        { id: 'harness-review', action: 'open-review', values: {}, cwd: '/workspace/current' }
      ],
      ['runPluginAction', { id: 'video', action: 'check', values: undefined, cwd: undefined }]
    ])
  })
})
