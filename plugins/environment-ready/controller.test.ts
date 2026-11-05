import { describe, expect, it, vi } from 'vitest';
import { EnvironmentController } from './controller.js';
import { normalizeState, type ProbeStatus } from './state.js';
import { deferred, harness, web } from './test-harness.js';

describe('task-owned checks and persistence races', () => {
  it('only checks registered rows, stamps every result and expires fresh results after 60s', async () => {
    const h = harness();
    await h.controller.check(h.ownerA);
    expect(h.probe).not.toHaveBeenCalled();
    h.controller.replace([web], h.ownerA);
    expect(h.probe).not.toHaveBeenCalled();
    expect(await h.controller.check(h.ownerA)).toEqual({ outcome: 'success', count: 1 });
    const state = h.controller.read(h.ownerA);
    expect(state.statuses.web?.checkedAt).toBe(1000);
    expect(h.controller.liveStatus(h.ownerA, state, 'web')?.healthy).toBe(true);
    h.setNow(61_000);
    expect(h.controller.liveStatus(h.ownerA, state, 'web')).toBeDefined();
    h.setNow(61_001);
    expect(h.controller.liveStatus(h.ownerA, state, 'web')).toBeUndefined();
  });
  it('does not trust restored healthy statuses or externally altered results', async () => {
    const h = harness();
    h.controller.replace([web], h.ownerA);
    await h.controller.check(h.ownerA);
    const saved = h.controller.read(h.ownerA);
    const restored = new EnvironmentController(h.deps);
    expect(restored.liveStatus(h.ownerA, saved, 'web')).toBeUndefined();
    await restored.check(h.ownerA);
    expect(restored.liveStatus(h.ownerA, restored.read(h.ownerA), 'web')?.healthy).toBe(true);
    const tampered = { ...saved, statuses: { web: { ...saved.statuses.web!, checkedAt: 1001 } } };
    expect(h.controller.liveStatus(h.ownerA, tampered, 'web')).toBeUndefined();
  });
  it('uses the captured owner after a session switch without cross-writing the new session', async () => {
    const pending = deferred<ProbeStatus>();
    const h = harness({ probe: () => pending.promise });
    h.controller.replace([web], h.ownerA);
    h.controller.replace([{ ...web, id: 'other' }], h.ownerB);
    const check = h.controller.check(h.controller.capture());
    h.setCurrent(h.ownerB);
    pending.resolve({ checkedAt: 1000, reachable: true, healthy: true, statusCode: 200 });
    await check;
    expect(h.controller.read(h.ownerA).statuses.web).toBeDefined();
    expect(h.controller.read(h.ownerB).statuses).toEqual({});
    expect(h.writes.mock.calls.at(-1)?.[1]).toBe(h.ownerA);
  });
  it('prevents overlapping checks and invalidates old results after replacement or clear', async () => {
    const pending = deferred<ProbeStatus>();
    let probeSignal: AbortSignal | undefined;
    const h = harness({
      probe: (_target, signal) => {
        probeSignal = signal;
        return pending.promise;
      },
    });
    h.controller.replace([web], h.ownerA);
    const first = h.controller.check(h.ownerA);
    expect(await h.controller.check(h.ownerA)).toEqual({ outcome: 'busy', count: 0 });
    h.controller.replace([], h.ownerA);
    expect(probeSignal?.aborted).toBe(true);
    pending.resolve({ checkedAt: 1000, reachable: true, healthy: true, statusCode: 200 });
    expect(await first).toEqual({ outcome: 'stale', count: 0 });
    expect(h.controller.read(h.ownerA).targets).toEqual([]);
    expect(h.controller.read(h.ownerA).statuses).toEqual({});
  });
  it('detects out-of-band changes even when a saved config revision is incorrectly reused', async () => {
    const pending = deferred<ProbeStatus>();
    const h = harness({ probe: () => pending.promise });
    h.controller.replace([web], h.ownerA);
    const first = h.controller.check(h.ownerA);
    h.states.set(h.ownerA.id, { ...h.controller.read(h.ownerA), targets: [{ ...web, url: 'http://127.0.0.1:4000' }] });
    pending.resolve({ checkedAt: 1000, reachable: true, healthy: true, statusCode: 200 });
    expect((await first).outcome).toBe('stale');
    expect(h.controller.read(h.ownerA).statuses).toEqual({});
  });
  it('does not write after dispose and forwards cancellation to active requests/sockets', async () => {
    const pending = deferred<ProbeStatus>();
    let signal: AbortSignal | undefined;
    const h = harness({
      probe: (_target, probeSignal) => {
        signal = probeSignal;
        return pending.promise;
      },
    });
    h.controller.replace([web], h.ownerA);
    const check = h.controller.check(h.ownerA);
    h.controller.dispose();
    expect(signal?.aborted).toBe(true);
    pending.resolve({ checkedAt: 1000, reachable: true, healthy: true, statusCode: 200 });
    expect((await check).outcome).toBe('stale');
    expect(h.writes).toHaveBeenCalledTimes(1);
    await expect(h.controller.check(h.ownerA)).rejects.toThrow('已停用');
  });
  it('turns per-probe exceptions into visible sanitized row results and metadata-only check events', async () => {
    const report = vi.fn();
    const h = harness({
      report,
      probe: async () => {
        throw new Error('token=http://secret/path');
      },
    });
    h.controller.replace([web], h.ownerA);
    expect((await h.controller.check(h.ownerA, { surface: 'tool' })).outcome).toBe('error');
    expect(h.controller.read(h.ownerA).statuses.web).toEqual({
      checkedAt: 1000,
      reachable: false,
      healthy: null,
      error: 'connection',
    });
    expect(report).toHaveBeenCalledWith(1, 1);
    expect(h.track).toHaveBeenLastCalledWith(
      'check',
      expect.objectContaining({ surface: 'tool', count: 1, outcome: 'error', durationMs: 0 }),
      h.ownerA.handle,
    );
    expect(JSON.stringify(h.track.mock.calls)).not.toMatch(/http|secret|\/path/);
  });
  it('persists dismissal by configuration revision across checks and reopen; updates reset it', async () => {
    const h = harness();
    h.controller.replace([web], h.ownerA);
    h.controller.dismiss(h.ownerA);
    const dismissed = normalizeState(h.states.get(h.ownerA.id));
    expect(dismissed.dismissedRevision).toBe(dismissed.revision);
    await h.controller.check(h.ownerA);
    expect(h.controller.read(h.ownerA).dismissedRevision).toBe(dismissed.revision);
    h.controller.reopen(h.ownerA);
    expect(h.controller.read(h.ownerA).dismissedRevision).toBeUndefined();
    h.controller.dismiss(h.ownerA);
    h.controller.replace([web], h.ownerA);
    expect(h.controller.read(h.ownerA).dismissedRevision).toBeUndefined();
  });
});
