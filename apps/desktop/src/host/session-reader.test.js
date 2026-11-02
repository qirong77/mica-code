import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createSessionReader } from './session-reader'

describe('session reader', () => {
  it('projects history and metadata in a worker and reads fresh data on later requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-reader-'))
    const file = join(dir, 'session.json')
    try {
      writeFileSync(
        file,
        JSON.stringify({
          cwd: ' /tmp ',
          snapshot: {
            providerId: 'p',
            conversationMessages: [
              { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image' }] }
            ],
            usageHistory: [{ inputTokens: 100, cachedInputTokens: 25 }],
            displayUsage: { totalTokens: 42 }
          }
        })
      )
      const read = createSessionReader()
      const first = read(file)
      expect(read(file)).toBe(first)
      const result = await first
      expect(result.history).toEqual([
        {
          role: 'user',
          text: 'hello[图片]',
          variant: null,
          command: null,
          status: null,
          usage: null,
          stop_reason: null
        }
      ])
      expect(result.meta).toMatchObject({
        providerId: 'p',
        cwd: '/tmp',
        cachedRate: 0.25,
        lastUsage: { totalTokens: 42 },
        role: 'default'
      })
      writeFileSync(file, '{bad')
      expect(await read(file)).toEqual({ history: [], meta: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('shares concurrent work and recovers from worker failures', async () => {
    let calls = 0
    const read = createSessionReader({
      startWorker: () => {
        calls++
        const worker = new EventEmitter()
        queueMicrotask(() => worker.emit('error', new Error('failed')))
        return worker
      }
    })
    await Promise.all([read('a'), read('a')])
    expect(calls).toBe(1)
    expect(await read('a')).toEqual({ history: [], meta: null })
    expect(calls).toBe(2)
  })
})
