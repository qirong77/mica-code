import { describe, expect, it, vi } from 'vitest';
import { WriterHealth, type WriterCheckpoint, type WriterCounters, type WriterPolicy } from './writer-health.js';
import { processIdentity } from './identity.js';

const policy: WriterPolicy = { logLevel: 'warn', pluginLogEnabled: false, closePolicy: 'best_effort_sync_exit' };
const counters: WriterCounters = { dropped: 5, overflowDrops: 2, serializationFailures: 1, writeFailures: 2 };

describe('protected writer health checkpoints', () => {
  it('persists cumulative loss after recovery without recursive writes or inflating the lower bound', () => {
    let now = 0;
    let failing = true;
    const written: WriterCheckpoint[] = [];
    const persist = vi.fn((entry: WriterCheckpoint) => {
      expect(health.checkpoint(counters, policy, 'exit')).toBe(false);
      if (failing) throw new Error('disk unavailable');
      written.push(entry);
    });
    const health = new WriterHealth(persist, () => now);
    expect(health.checkpoint(counters, policy)).toBe(false);
    now = 59_999;
    expect(health.checkpoint({ ...counters, dropped: 6, overflowDrops: 3 }, policy)).toBe(false);
    expect(persist).toHaveBeenCalledOnce();
    failing = false;
    now = 60_000;
    expect(health.checkpoint({ ...counters, dropped: 6, overflowDrops: 3 }, policy)).toBe(true);
    expect(written[0]).toMatchObject({
      event: 'writer.checkpoint',
      schemaVersion: 1,
      scope: 'writer-health',
      ...processIdentity(),
      ...policy,
      dropped: 6,
      overflowDrops: 3,
      serializationFailures: 1,
      writeFailures: 2,
      lostLowerBound: 4,
      checkpointFailures: 1,
    });
    expect(JSON.stringify(written)).not.toContain('disk unavailable');
  });

  it('deduplicates explicit flushes and always appends a best-effort closing tail', () => {
    const persist = vi.fn();
    const health = new WriterHealth(persist, () => 123);
    expect(health.checkpoint(counters, policy, 'flush')).toBe(true);
    expect(health.checkpoint(counters, policy, 'flush')).toBe(false);
    expect(health.checkpoint({ ...counters, dropped: 6, overflowDrops: 3 }, policy, 'flush')).toBe(true);
    expect(health.checkpoint({ ...counters, dropped: 6, overflowDrops: 3 }, policy, 'exit')).toBe(true);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(persist.mock.calls.at(-1)?.[0]).toMatchObject({ reason: 'exit', closePolicy: 'best_effort_sync_exit' });
  });
});
