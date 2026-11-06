import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from './PluginContext.js';
import { createPluginExperience } from './PluginExperience.js';
import { summarizePluginExperience } from './PluginExperienceReport.js';

function fixture() {
  const info = vi.fn();
  let telemetry = 'true';
  const ctx = {
    settings: { get: () => ({ telemetry }) },
    session: { describe: () => ({ id: 'private-session-id' }) },
    logger: { info },
  } as unknown as PluginContext;
  return {
    info,
    tracker: createPluginExperience(ctx),
    disable: () => {
      telemetry = 'false';
    },
  };
}

describe('plugin experience metadata', () => {
  it('writes a stable anonymous session and only allowlisted fields', () => {
    const { tracker, info } = fixture();
    tracker.track('click', {
      surface: 'card',
      action: 'details',
      revision: 'abc-123',
      count: 2,
      url: 'https://secret.test',
      text: 'private prompt',
    } as any);
    tracker.track('dismiss', { action: 'https://private.test', revision: '/private/path' });
    const first = info.mock.calls[0]![1];
    const second = info.mock.calls[1]![1];
    expect(first).toMatchObject({ schemaVersion: 1, event: 'click', action: 'details', surface: 'card', count: 2 });
    expect(first.sessionKey).toMatch(/^[a-f0-9]{24}$/);
    expect(second.sessionKey).toBe(first.sessionKey);
    expect(second.eventId).not.toBe(first.eventId);
    expect(second).not.toHaveProperty('action');
    expect(second).not.toHaveProperty('revision');
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/secret|private/);
  });
  it('honors a live opt-out and isolates logging errors', () => {
    const { tracker, info, disable } = fixture();
    info.mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => tracker.track('failure')).not.toThrow();
    disable();
    tracker.track('click');
    expect(info).toHaveBeenCalledTimes(1);
  });
  it('bounds numbers and rejects nonfinite or negative counts', () => {
    const { tracker, info } = fixture();
    tracker.track('check', { durationMs: Infinity, count: -1 });
    expect(info.mock.calls[0]![1]).not.toHaveProperty('durationMs');
    expect(info.mock.calls[0]![1]).not.toHaveProperty('count');
    tracker.track('check', { durationMs: 4_000_000, count: 30_000 });
    expect(info.mock.calls[1]![1]).toMatchObject({ durationMs: 3_600_000, count: 10_000 });
  });
});

describe('experience analysis', () => {
  const line = (id: string, data: Record<string, unknown> = {}, plugin = 'context-handoff') =>
    JSON.stringify({
      plugin,
      time: '2026-11-05T00:00:00Z',
      event: 'plugin:experience',
      data: {
        schemaVersion: 1,
        eventId: id,
        pluginVersion: '1.0.0',
        sessionKey: 'a'.repeat(24),
        event: 'impression',
        surface: 'card',
        ...data,
      },
    });
  it('deduplicates copied logs, isolates versions, and excludes non-UX entries', () => {
    const entries = [
      line('one'),
      line('one'),
      line('two', { event: 'click', action: 'details' }),
      line('three', { event: 'check', surface: 'panel', durationMs: 100 }),
      line('four', { event: 'check', surface: 'panel', durationMs: 200 }),
      line('five', { pluginVersion: '2.0.0' }),
      line('six', { schemaVersion: 99 }),
      '{broken',
      JSON.stringify({ event: 'tool:result', text: 'secret' }),
    ];
    const result = summarizePluginExperience(entries);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      sessions: 1,
      cardImpressions: 1,
      cardClicks: 1,
      checkDurationSamples: 2,
      averageCheckDurationMs: 150,
      events: { impression: 1, click: 1, check: 2 },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('supports time and plugin filters', () => {
    expect(summarizePluginExperience([line('one')], { since: Date.parse('2026-11-06') })).toEqual([]);
    expect(summarizePluginExperience([line('one')], { plugin: 'other-plugin' })).toEqual([]);
    const malformedTime = JSON.parse(line('malformed'));
    malformedTime.time = { toString: 1, valueOf: 1 };
    expect(summarizePluginExperience([JSON.stringify(malformedTime)], { since: 0 })).toEqual([]);
  });
});
