import { describe, expect, test } from 'vitest';
import { parseUsageLedger } from './usage-ledger.js';

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

describe('parseUsageLedger', () => {
  test('keeps well-formed entries and normalizes missing numbers', () => {
    const entries = parseUsageLedger(
      [
        line({
          id: 'u1',
          occurredAt: '2026-10-01T10:00:00.000Z',
          model: 'deepseek-chat',
          pluginId: 'commit',
          purpose: '写提交说明',
          cwd: '/repo',
          inputTokens: 1200,
          cachedInputTokens: 800,
          outputTokens: 60,
        }),
      ].join('\n'),
    );
    expect(entries).toEqual([
      {
        id: 'u1',
        occurredAt: '2026-10-01T10:00:00.000Z',
        model: 'deepseek-chat',
        pluginId: 'commit',
        purpose: '写提交说明',
        cwd: '/repo',
        inputTokens: 1200,
        cachedInputTokens: 800,
        outputTokens: 60,
      },
    ]);
  });

  test('skips half-written lines and duplicate ids', () => {
    const good = line({
      id: 'u1',
      occurredAt: '2026-10-01T10:00:00.000Z',
      model: 'm',
      pluginId: 'commit',
      inputTokens: 10,
    });
    const entries = parseUsageLedger([good, '{"id":"u2","occur', good].join('\n'));
    expect(entries.map((entry) => entry.id)).toEqual(['u1']);
  });

  test('preserves valid optional providerId and timing values', () => {
    const entry = parseUsageLedger(line({
      id: 'u1', occurredAt: '2026-10-01T10:00:00.000Z', model: 'm', pluginId: 'commit',
      providerId: ' example ', durationMs: 1250.5, firstTokenMs: 0, responseWaitMs: 30, generationDurationMs: 50,
      outputTokens: 100, generationOutputTokens: 99,
    }))[0];
    expect(entry.providerId).toBe('example');
    expect(entry.durationMs).toBe(1250.5);
    expect(entry.firstTokenMs).toBe(0);
    expect(entry.responseWaitMs).toBe(30);
    expect(entry.generationDurationMs).toBe(50);
    expect(entry.generationOutputTokens).toBe(99);
  });

  test('requires attributable positive tokens and timing as a pair for generation', () => {
    for (const generationOutputTokens of [undefined, 0, -1, 100, 101, 1.5, '99', Infinity]) {
      const entry = parseUsageLedger(line({
        id: 'u1', occurredAt: '2026-10-01', model: 'm', pluginId: 'commit',
        outputTokens: 100, generationOutputTokens, generationDurationMs: 1000, responseWaitMs: 20,
      }))[0];
      expect(entry.outputTokens).toBe(100);
      expect(entry.responseWaitMs).toBe(20);
      expect(entry).not.toHaveProperty('generationDurationMs');
      expect(entry).not.toHaveProperty('generationOutputTokens');
    }
    for (const outputTokens of [undefined, 0, -1, '100', Infinity]) {
      const entry = parseUsageLedger(line({
        id: 'u1', occurredAt: '2026-10-01', model: 'm', pluginId: 'commit',
        outputTokens, generationOutputTokens: 99, generationDurationMs: 1000,
      }))[0];
      expect(entry).not.toHaveProperty('generationDurationMs');
      expect(entry).not.toHaveProperty('generationOutputTokens');
    }
  });

  test('omits invalid optional fields without dropping the entry', () => {
    const invalid = [-1, '123', null, true, {}, [], Infinity];
    for (const value of invalid) {
      const entry = parseUsageLedger(line({
        id: 'u1', occurredAt: '2026-10-01T10:00:00.000Z', model: 'm', pluginId: 'commit',
        providerId: '  ', durationMs: value, firstTokenMs: value, responseWaitMs: value, generationDurationMs: value,
      }))[0];
      expect(entry).toBeDefined();
      expect(entry).not.toHaveProperty('providerId');
      expect(entry).not.toHaveProperty('durationMs');
      expect(entry).not.toHaveProperty('firstTokenMs');
      expect(entry).not.toHaveProperty('responseWaitMs');
      expect(entry).not.toHaveProperty('generationDurationMs');
    }
    const overflow = parseUsageLedger(
      '{"id":"u2","occurredAt":"2026-10-01","model":"m","pluginId":"commit","durationMs":1e999}',
    )[0];
    expect(overflow).not.toHaveProperty('durationMs');
  });

  test('drops entries without an identity, time, model or plugin', () => {
    expect(
      parseUsageLedger(
        [
          line({ occurredAt: '2026-10-01T10:00:00.000Z', model: 'm', pluginId: 'commit' }),
          line({ id: 'u2', model: 'm', pluginId: 'commit' }),
          line({ id: 'u3', occurredAt: '2026-10-01T10:00:00.000Z', pluginId: 'commit' }),
          line({ id: 'u4', occurredAt: '2026-10-01T10:00:00.000Z', model: 'm' }),
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  test('treats an empty or missing file as no usage', () => {
    expect(parseUsageLedger('')).toEqual([]);
    expect(parseUsageLedger('\n\n')).toEqual([]);
  });
});
