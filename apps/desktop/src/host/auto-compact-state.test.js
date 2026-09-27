import { describe, expect, it } from 'bun:test'
import {
  applyAutoCompactStatus,
  AUTO_COMPACT_VERSION,
  DEFAULT_AUTO_COMPACT_SETTINGS,
  emptyAutoCompactState,
  emptyCounters,
  MAX_AUTO_COMPACT_COUNTERS,
  normalizeAutoCompactSettings,
  normalizeAutoCompactState,
  normalizeCounters,
  readAutoCompactTurnParams,
  resetAutoCompactCounters
} from './auto-compact-state'

const BASE = 1_700_000_000_000

function at(offsetMs) {
  return new Date(BASE + offsetMs).toISOString()
}

describe('normalizeAutoCompactSettings', () => {
  it('falls back to the defaults for garbage input', () => {
    expect(normalizeAutoCompactSettings(null)).toEqual(DEFAULT_AUTO_COMPACT_SETTINGS)
    expect(normalizeAutoCompactSettings({})).toEqual(DEFAULT_AUTO_COMPACT_SETTINGS)
    expect(
      normalizeAutoCompactSettings({
        enabled: 'yes',
        quickThresholdK: null,
        quickLimit: Number.NaN,
        modelThresholdK: 'abc',
        modelLimit: {}
      })
    ).toEqual(DEFAULT_AUTO_COMPACT_SETTINGS)
  })

  it('clamps out-of-range values to the bound instead of dropping the whole setting', () => {
    expect(
      normalizeAutoCompactSettings({
        enabled: false,
        quickThresholdK: 0,
        quickLimit: -5,
        modelThresholdK: 1_000_000,
        modelLimit: 10_000
      })
    ).toEqual({
      enabled: false,
      quickThresholdK: 1,
      quickLimit: 0,
      modelThresholdK: 10_000,
      modelLimit: 999
    })
  })

  it('accepts numeric strings and rounds fractions', () => {
    expect(normalizeAutoCompactSettings({ quickThresholdK: '180' }).quickThresholdK).toBe(180)
    expect(normalizeAutoCompactSettings({ quickLimit: 2.4 }).quickLimit).toBe(2)
  })
})

describe('normalizeCounters', () => {
  it('zeros anything that is not a non-negative integer', () => {
    expect(normalizeCounters(null)).toEqual(emptyCounters())
    expect(normalizeCounters({ quickRuns: -3, modelRuns: 'x', lastSavedTokens: -1 })).toEqual(
      emptyCounters()
    )
  })

  it('keeps a valid tally and rejects an unknown compression kind', () => {
    expect(
      normalizeCounters({
        quickRuns: 2,
        modelRuns: 1,
        lastRunAt: at(0),
        lastKind: 'model',
        lastSavedTokens: 12_345,
        lastNote: '压缩了 3 条工具结果'
      })
    ).toEqual({
      quickRuns: 2,
      modelRuns: 1,
      lastRunAt: at(0),
      lastKind: 'model',
      lastSavedTokens: 12_345,
      lastNote: '压缩了 3 条工具结果'
    })
    expect(normalizeCounters({ lastKind: 'weird' }).lastKind).toBeNull()
    expect(normalizeCounters({ lastNote: '' }).lastNote).toBeNull()
  })
})

describe('normalizeAutoCompactState', () => {
  it('converges any parsed JSON to the stored shape', () => {
    expect(normalizeAutoCompactState(null)).toEqual(emptyAutoCompactState())
    expect(normalizeAutoCompactState(emptyAutoCompactState()).version).toBe(AUTO_COMPACT_VERSION)

    const normalized = normalizeAutoCompactState({
      version: 99,
      unknown: 'dropped',
      settings: { quickLimit: 5, unknown: 1 },
      counters: {
        s1: { quickRuns: 1 },
        broken: 'nope',
        nested: [1, 2],
        '': { quickRuns: 3 }
      }
    })
    expect(normalized.version).toBe(AUTO_COMPACT_VERSION)
    expect(normalized).not.toHaveProperty('unknown')
    expect(normalized.settings).toEqual({ ...DEFAULT_AUTO_COMPACT_SETTINGS, quickLimit: 5 })
    expect(normalized.settings).not.toHaveProperty('unknown')
    expect(Object.keys(normalized.counters)).toEqual(['s1'])
    expect(normalized.counters.s1).toEqual({ ...emptyCounters(), quickRuns: 1 })
  })
})

describe('readAutoCompactTurnParams', () => {
  it('merges the settings with the counters of that session', () => {
    const state = applyAutoCompactStatus(
      {
        ...emptyAutoCompactState(),
        settings: {
          enabled: false,
          quickThresholdK: 100,
          quickLimit: 1,
          modelThresholdK: 80,
          modelLimit: 2
        }
      },
      's1',
      { quickRuns: 3, modelRuns: 2 }
    )
    expect(readAutoCompactTurnParams(state, 's1')).toEqual({
      enabled: false,
      quickThresholdK: 100,
      quickLimit: 1,
      quickRuns: 3,
      modelThresholdK: 80,
      modelLimit: 2,
      modelRuns: 2
    })
  })

  it('reports zero counters for an unknown or missing session', () => {
    const state = applyAutoCompactStatus(emptyAutoCompactState(), 's1', {
      quickRuns: 3,
      modelRuns: 2
    })
    const zeros = { quickRuns: 0, modelRuns: 0 }
    expect(readAutoCompactTurnParams(state, 'other')).toEqual({
      ...DEFAULT_AUTO_COMPACT_SETTINGS,
      ...zeros
    })
    expect(readAutoCompactTurnParams(state, null)).toEqual({
      ...DEFAULT_AUTO_COMPACT_SETTINGS,
      ...zeros
    })
    expect(readAutoCompactTurnParams(emptyAutoCompactState(), undefined)).toEqual({
      ...DEFAULT_AUTO_COMPACT_SETTINGS,
      ...zeros
    })
  })

  it('still hands the settings over when the state was never normalized', () => {
    expect(readAutoCompactTurnParams(null, 's1')).toEqual({
      ...DEFAULT_AUTO_COMPACT_SETTINGS,
      quickRuns: 0,
      modelRuns: 0
    })
  })
})

describe('applyAutoCompactStatus', () => {
  it('stores the tally the host reported for that session', () => {
    const state = applyAutoCompactStatus(emptyAutoCompactState(), 's1', {
      quickRuns: 1,
      modelRuns: 0,
      lastRunAt: at(1_000),
      lastKind: 'quick',
      lastSavedTokens: 4_096,
      lastNote: null
    })
    expect(state.counters.s1).toEqual({
      quickRuns: 1,
      modelRuns: 0,
      lastRunAt: at(1_000),
      lastKind: 'quick',
      lastSavedTokens: 4_096,
      lastNote: null
    })
  })

  it('returns the same state when nothing changed', () => {
    const status = { quickRuns: 2, modelRuns: 1, lastRunAt: at(0), lastKind: 'model' }
    const state = applyAutoCompactStatus(emptyAutoCompactState(), 's1', status)
    expect(applyAutoCompactStatus(state, 's1', { ...status })).toBe(state)
  })

  it('ignores a missing session id instead of writing an unnamed entry', () => {
    const state = emptyAutoCompactState()
    expect(applyAutoCompactStatus(state, '', { quickRuns: 1 })).toBe(state)
    expect(applyAutoCompactStatus(state, null, { quickRuns: 1 })).toBe(state)
    expect(applyAutoCompactStatus(state, undefined, { quickRuns: 1 })).toBe(state)
  })

  it('caps the entries at the limit, dropping the least recently used first', () => {
    let state = emptyAutoCompactState()
    for (let index = 0; index < MAX_AUTO_COMPACT_COUNTERS; index += 1) {
      state = applyAutoCompactStatus(state, `s${index}`, {
        quickRuns: 1,
        lastRunAt: at(index * 1_000)
      })
    }
    expect(Object.keys(state.counters)).toHaveLength(MAX_AUTO_COMPACT_COUNTERS)

    state = applyAutoCompactStatus(state, 'fresh', { quickRuns: 1, lastRunAt: at(10_000_000) })
    expect(Object.keys(state.counters)).toHaveLength(MAX_AUTO_COMPACT_COUNTERS)
    expect(state.counters.s0).toBeUndefined()
    expect(state.counters.fresh).toBeDefined()
  })

  it('drops a session that never compacted before the ones that did', () => {
    let state = applyAutoCompactStatus(emptyAutoCompactState(), 'never', { quickRuns: 0 })
    for (let index = 0; index < MAX_AUTO_COMPACT_COUNTERS; index += 1) {
      state = applyAutoCompactStatus(state, `s${index}`, { quickRuns: 1, lastRunAt: at(index) })
    }
    expect(state.counters.never).toBeUndefined()
    expect(state.counters.s0).toBeDefined()
    expect(Object.keys(state.counters)).toHaveLength(MAX_AUTO_COMPACT_COUNTERS)
  })
})

describe('resetAutoCompactCounters', () => {
  it('removes exactly one session', () => {
    const state = applyAutoCompactStatus(
      applyAutoCompactStatus(emptyAutoCompactState(), 's1', { quickRuns: 1 }),
      's2',
      { quickRuns: 2 }
    )
    const reset = resetAutoCompactCounters(state, 's1')
    expect(reset).not.toBe(state)
    expect(reset.counters.s1).toBeUndefined()
    expect(reset.counters.s2).toEqual({ ...emptyCounters(), quickRuns: 2 })
    expect(resetAutoCompactCounters(reset, 's1')).toBe(reset)
    expect(resetAutoCompactCounters(state, 'other')).toBe(state)
    expect(resetAutoCompactCounters(state, '')).toBe(state)
    expect(resetAutoCompactCounters(emptyAutoCompactState(), 's1')).toEqual(emptyAutoCompactState())
  })
})
