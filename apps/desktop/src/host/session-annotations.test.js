import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireProcessLock } from '@packages/mica-common/processLock.js'
import { sessionAnnotationsPath } from '@packages/mica-plugin/sessionAnnotations.js'
import { listSessionAnnotations, setSessionAnnotation } from './session-annotations'

let directory
let previousHome

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mica-session-annotations-'))
  previousHome = process.env.MICA_HOME
  process.env.MICA_HOME = directory
  const target = sessionAnnotationsPath(directory, 'session-tags')
  mkdirSync(join(directory, 'plugin-data', 'session-tags'), { recursive: true })
  writeFileSync(
    target,
    JSON.stringify({
      version: 1,
      name: 'Session Tags',
      options: [
        { id: 'red', label: 'Red', color: '#FF3B30' },
        { id: 'blue', label: 'Blue', color: '#007AFF' }
      ],
      assignments: {}
    })
  )
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.MICA_HOME
  else process.env.MICA_HOME = previousHome
  rmSync(directory, { recursive: true, force: true })
})

describe('session annotation host writes', () => {
  it('applies an explicit state without toggling it back', () => {
    const result = setSessionAnnotation({
      pluginId: 'session-tags',
      sessionId: 'session-1',
      optionId: 'red',
      on: true
    })
    expect(result.ok).toBe(true)
    expect(result.providers[0].assignments['session-1']).toEqual(['red'])
    expect(listSessionAnnotations().providers[0].assignments['session-1']).toEqual(['red'])
  })

  it('refuses to read-modify-write while a plugin command holds the same lock', () => {
    const release = acquireProcessLock(`${sessionAnnotationsPath(directory, 'session-tags')}.lock`)
    try {
      const result = setSessionAnnotation({
        pluginId: 'session-tags',
        sessionId: 'session-1',
        optionId: 'blue'
      })
      expect(result).toEqual({ ok: false, error: '其他会话正在更新标记，稍后重试' })
    } finally {
      release()
    }
  })
})
