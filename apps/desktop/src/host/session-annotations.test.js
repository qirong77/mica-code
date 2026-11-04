import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireProcessLock } from '@packages/mica-common/processLock.js'
import { sessionAnnotationsPath } from '@packages/mica-plugin/sessionAnnotations.js'
import {
  listSessionAnnotations,
  readAnnotationOptions,
  replaceAnnotationOptions,
  setAnnotationBroadcaster,
  setSessionAnnotation
} from './session-annotations'
import { readSessionAnnotations } from '@packages/mica-plugin/sessionAnnotations.js'

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

describe('session annotation options', () => {
  afterEach(() => {
    setAnnotationBroadcaster(null)
  })

  it('reads the plugin options with per-option usage counts', () => {
    setSessionAnnotation({ pluginId: 'session-tags', sessionId: 'session-1', optionId: 'red', on: true })
    const result = readAnnotationOptions({ pluginId: 'session-tags' })
    expect(result.ok).toBe(true)
    expect(result.options).toHaveLength(2)
    expect(result.counts).toEqual({ red: 1, blue: 0 })
  })

  it('replaces the whole option list and reports the normalized result', () => {
    const result = replaceAnnotationOptions({
      pluginId: 'session-tags',
      options: [
        { id: 'tag-1', label: '待办', color: '#FF3B30' },
        // 非法颜色由宿主归一化退成灰色，插件那边拿到的是落盘的真实值
        { id: 'tag-2', label: '进行中', color: 'nope' }
      ]
    })
    expect(result.ok).toBe(true)
    expect(result.options.map((option) => option.label)).toEqual(['待办', '进行中'])
    expect(result.options[1].color).toBe('#8E8E93')
    expect(readSessionAnnotations(directory, 'session-tags').options).toHaveLength(2)
  })

  it('drops assignments of deleted options instead of leaving dead ids', () => {
    setSessionAnnotation({ pluginId: 'session-tags', sessionId: 'session-1', optionId: 'red', on: true })
    const result = replaceAnnotationOptions({
      pluginId: 'session-tags',
      options: [{ id: 'blue', label: 'Blue', color: '#007AFF' }]
    })
    expect(result.ok).toBe(true)
    const stored = readSessionAnnotations(directory, 'session-tags')
    expect(stored.options.map((option) => option.id)).toEqual(['blue'])
    expect(stored.assignments).toEqual({})
  })

  it('broadcasts after a successful write so every window redraws the dots', () => {
    const seen = []
    setAnnotationBroadcaster((channel, payload) => seen.push({ channel, payload }))
    replaceAnnotationOptions({ pluginId: 'session-tags', options: [] })
    expect(seen).toEqual([{ channel: 'annotations:changed', payload: { pluginId: 'session-tags' } }])
  })

  it('refuses unknown plugins and non-array payloads', () => {
    expect(readAnnotationOptions({ pluginId: 'nope' })).toEqual({ ok: false, error: '插件还没有标记数据' })
    expect(readAnnotationOptions({ pluginId: '../evil' }).ok).toBe(false)
    expect(replaceAnnotationOptions({ pluginId: 'session-tags', options: null }).ok).toBe(false)
  })

  it('refuses to read-modify-write while a plugin command holds the same lock', () => {
    const release = acquireProcessLock(`${sessionAnnotationsPath(directory, 'session-tags')}.lock`)
    try {
      expect(replaceAnnotationOptions({ pluginId: 'session-tags', options: [] })).toEqual({
        ok: false,
        error: '其他会话正在更新标记，稍后重试'
      })
    } finally {
      release()
    }
  })
})
