import { describe, expect, it } from 'bun:test'
import {
  AUTO_COMPACT_LIMIT_MAX,
  AUTO_COMPACT_THRESHOLD_MAX_K,
  DEFAULT_AUTO_COMPACT_SETTINGS,
  autoCompactDraftFromSettings,
  autoCompactRunLabel,
  autoCompactSettingsFromDraft,
  autoCompactTooltip,
  countersForSession,
  emptyAutoCompactCounters
} from './auto-compact'

const SESSION = 'sess-1'

function counters(overrides = {}) {
  return {
    quickRuns: 2,
    modelRuns: 1,
    lastRunAt: 1_700_000_000_000,
    lastKind: 'quick',
    lastSavedTokens: 12_345,
    lastNote: '',
    ...overrides
  }
}

describe('defaults', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_AUTO_COMPACT_SETTINGS).toEqual({
      enabled: true,
      quickThresholdK: 200,
      quickLimit: 3,
      modelThresholdK: 120,
      modelLimit: 3
    })
  })

  it('zeroes a session that has not run yet', () => {
    expect(emptyAutoCompactCounters()).toEqual({
      quickRuns: 0,
      modelRuns: 0,
      lastRunAt: null,
      lastKind: null,
      lastSavedTokens: null,
      lastNote: ''
    })
  })
})

describe('countersForSession', () => {
  it('picks the entry for the session', () => {
    const entry = countersForSession({ [SESSION]: counters() }, SESSION)
    expect(entry.quickRuns).toBe(2)
    expect(entry.modelRuns).toBe(1)
    expect(entry.lastSavedTokens).toBe(12_345)
  })

  it('returns a zeroed shape for a draft session, an unknown session or a broken table', () => {
    expect(countersForSession({ [SESSION]: counters() }, null)).toEqual(emptyAutoCompactCounters())
    expect(countersForSession({ [SESSION]: counters() }, undefined)).toEqual(
      emptyAutoCompactCounters()
    )
    expect(countersForSession({ [SESSION]: counters() }, 'other')).toEqual(
      emptyAutoCompactCounters()
    )
    expect(countersForSession(null, SESSION)).toEqual(emptyAutoCompactCounters())
    expect(countersForSession({ [SESSION]: 'nope' }, SESSION)).toEqual(emptyAutoCompactCounters())
  })

  it('normalises broken counts instead of trusting the payload', () => {
    const entry = countersForSession(
      { [SESSION]: { quickRuns: -3, modelRuns: 'x', lastNote: 'hi' } },
      SESSION
    )
    expect(entry.quickRuns).toBe(0)
    expect(entry.modelRuns).toBe(0)
    expect(entry.lastNote).toBe('hi')
  })
})

describe('form round trip', () => {
  const settings = {
    enabled: false,
    quickThresholdK: 250,
    quickLimit: 2,
    modelThresholdK: 90,
    modelLimit: 1
  }

  it('turns settings into editable strings and back', () => {
    const draft = autoCompactDraftFromSettings(settings)
    expect(draft).toEqual({
      enabled: false,
      quickThresholdK: '250',
      quickLimit: '2',
      modelThresholdK: '90',
      modelLimit: '1'
    })
    expect(autoCompactSettingsFromDraft(draft)).toEqual({ ok: true, settings })
  })

  it('falls back to the defaults for a missing or broken settings object', () => {
    expect(autoCompactDraftFromSettings(null)).toEqual(
      autoCompactDraftFromSettings(DEFAULT_AUTO_COMPACT_SETTINGS)
    )
    expect(autoCompactDraftFromSettings({ quickLimit: null }).quickLimit).toBe('3')
  })

  it('accepts the documented bounds', () => {
    const min = autoCompactSettingsFromDraft({
      quickThresholdK: '1',
      quickLimit: '0',
      modelThresholdK: String(AUTO_COMPACT_THRESHOLD_MAX_K),
      modelLimit: String(AUTO_COMPACT_LIMIT_MAX)
    })
    expect(min.ok).toBe(true)
    expect(min.settings.quickLimit).toBe(0)
  })

  it('reports empty, non-numeric and out-of-range values instead of coercing them', () => {
    const base = autoCompactDraftFromSettings(DEFAULT_AUTO_COMPACT_SETTINGS)

    expect(autoCompactSettingsFromDraft({ ...base, quickThresholdK: '' })).toEqual({
      ok: false,
      error: '快速压缩阈值需为 1–10000 之间的整数（单位 k）'
    })
    expect(autoCompactSettingsFromDraft({ ...base, quickThresholdK: '  ' }).ok).toBe(false)
    expect(autoCompactSettingsFromDraft({ ...base, quickThresholdK: 'abc' }).ok).toBe(false)
    expect(autoCompactSettingsFromDraft({ ...base, quickThresholdK: '-1' }).ok).toBe(false)
    expect(autoCompactSettingsFromDraft({ ...base, quickThresholdK: '200.5' }).ok).toBe(false)
    expect(autoCompactSettingsFromDraft({ ...base, quickThresholdK: '0' }).ok).toBe(false)
    expect(autoCompactSettingsFromDraft({ ...base, quickThresholdK: '10001' }).ok).toBe(false)

    expect(autoCompactSettingsFromDraft({ ...base, quickLimit: '' }).ok).toBe(false)
    expect(autoCompactSettingsFromDraft({ ...base, quickLimit: '1000' }).error).toContain(
      '快速压缩上限'
    )
    expect(autoCompactSettingsFromDraft({ ...base, modelThresholdK: '0' }).error).toContain(
      '模型压缩阈值'
    )
    expect(autoCompactSettingsFromDraft({ ...base, modelLimit: '1000' }).error).toContain(
      '模型压缩上限'
    )
    expect(autoCompactSettingsFromDraft(undefined).ok).toBe(false)
  })
})

describe('labels', () => {
  it('prints the run progress against the limits', () => {
    expect(autoCompactRunLabel(counters(), DEFAULT_AUTO_COMPACT_SETTINGS)).toBe(
      '快速 2/3 · 模型 1/3'
    )
    expect(autoCompactRunLabel(counters({ quickRuns: 5, modelRuns: 0 }), { quickLimit: 10 })).toBe(
      '快速 5/10 · 模型 0/3'
    )
  })

  it('zeroes a missing counter or a broken limit', () => {
    expect(autoCompactRunLabel(null, null)).toBe('快速 0/3 · 模型 0/3')
    expect(autoCompactRunLabel(counters(), { quickLimit: -1, modelLimit: 'x' })).toBe(
      '快速 2/3 · 模型 1/3'
    )
  })

  it('describes the gear button', () => {
    expect(
      autoCompactTooltip({ settings: DEFAULT_AUTO_COMPACT_SETTINGS, counters: counters() })
    ).toBe('自动压缩：已运行 快速 2/3 · 模型 1/3（点击设置）')
    expect(autoCompactTooltip({ settings: { enabled: false } })).toBe('自动压缩已关闭（点击设置）')
    expect(autoCompactTooltip()).toBe('自动压缩：已运行 快速 0/3 · 模型 0/3（点击设置）')
  })
})
