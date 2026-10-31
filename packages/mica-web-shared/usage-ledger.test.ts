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
