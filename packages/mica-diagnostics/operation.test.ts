import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flushLogs, snapshot } from './index.js';
import { observePluginOperation, operationFailure, operationResult, startPluginOperation } from './operation.js';
import { flushPluginHeartbeats } from './heartbeat.js';
import { processIdentity } from './identity.js';

let dir: string;
let first: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-operation-'));
  vi.stubEnv('MICA_LOG_DIR', dir);
  first = snapshot(1000).length;
});
afterEach(() => {
  flushLogs();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const events = () => snapshot(1000).slice(first);
const context = { plugin: 'contract', pluginVersion: '2.1.0', operation: 'contract.run' };

describe('structured operation results', () => {
  it.each([
    'success',
    'error',
    'failure',
    'failed',
    'busy',
    'cancelled',
    'declined',
    'partial',
    'unknown',
    'waiting',
    'skipped',
    'timeout',
    'conflict',
  ])('recognizes explicit %s and retains a fixed code', (outcome) => {
    expect(operationResult({ outcome, code: 'verified_code', message: 'failure success busy private' })).toEqual({
      outcome: ['failure', 'failed'].includes(outcome) ? 'error' : outcome,
      code: 'verified_code',
    });
  });

  it('does not infer a business result from prose and refuses unrecognized outcomes', () => {
    expect(operationResult('Error: ordinary source text')).toEqual({ outcome: 'success', code: 'ok' });
    expect(operationResult({ message: '请求失败，请稍后重试' })).toEqual({ outcome: 'success', code: 'ok' });
    expect(operationResult({ outcome: 'custom_value', ok: true })).toEqual({
      outcome: 'unknown',
      code: 'invalid_outcome',
    });
    expect(operationResult({ outcome: 'failure', code: '/private/path?token=secret' })).toEqual({
      outcome: 'error',
      code: 'failure',
    });
    expect(operationResult([{ type: 'text', text: '{"outcome":"busy","code":"maintenance_busy"}' }])).toEqual({
      outcome: 'busy',
      code: 'maintenance_busy',
    });
  });

  it('classifies only named/known busy errors and lets caller cancellation take precedence', async () => {
    const busy = Object.assign(new Error('PRIVATE_BUSY_MESSAGE'), { name: 'BusyError' });
    for (const error of [
      busy,
      Object.assign(new Error('private'), { code: 'EBUSY' }),
      { code: 'busy' },
      { code: 'TURN_LEASE_BUSY' },
    ])
      expect(operationFailure(error)).toEqual({ outcome: 'busy', code: 'busy' });
    expect(operationFailure(new Error('busy'))).toEqual({ outcome: 'error', code: 'exception' });
    expect(operationResult({ ok: false, code: 'TURN_LEASE_BUSY' })).toEqual({
      outcome: 'busy',
      code: 'TURN_LEASE_BUSY',
    });
    const controller = new AbortController();
    controller.abort();
    expect(operationFailure(busy, controller.signal)).toEqual({ outcome: 'cancelled', code: 'aborted' });
    await expect(
      observePluginOperation(context, () => {
        throw busy;
      }),
    ).rejects.toBe(busy);
    expect(events().at(-1)).toMatchObject({
      outcome: 'busy',
      code: 'busy',
      ...processIdentity(),
      pluginVersion: '2.1.0',
    });
    expect(JSON.stringify(events())).not.toContain('PRIVATE_BUSY_MESSAGE');
  });

  it('preserves the value/exception and runs a side effect just once', async () => {
    const effect = vi.fn(() => ({ outcome: 'failure', code: 'save_failed', content: 'PRIVATE_RESULT' }));
    const result = await observePluginOperation(context, effect);
    expect(result).toBe(effect.mock.results[0]!.value);
    expect(effect).toHaveBeenCalledOnce();
    expect(events().at(-1)).toMatchObject({ outcome: 'error', code: 'save_failed' });
    expect(JSON.stringify(events())).not.toContain('PRIVATE_RESULT');
  });
});

describe('bounded background heartbeats', () => {
  it('combines unchanged skipped/waiting ticks without relabeling them as successful business work', () => {
    const background = { ...context, plugin: 'heartbeat-neutral', surface: 'background' as const, heartbeat: true, taskId: 'poll' };
    for (const outcome of ['skipped', 'waiting'] as const) {
      for (let i = 0; i < 40; i++) startPluginOperation(background).finish({ outcome, code: outcome === 'skipped' ? 'unconfigured' : 'awaiting_ready' });
    }
    flushPluginHeartbeats(background.plugin);
    const rows = events().filter((row) => row.plugin === background.plugin);
    expect(rows.filter((row) => row.event === 'operation.finish').map((row) => row.outcome)).toEqual(['skipped', 'waiting']);
    expect(rows.filter((row) => row.event === 'background.heartbeat').map((row) => [row.outcome, row.count])).toEqual([['skipped', 39], ['waiting', 39]]);
  });
  it('records cancellation immediately even before an ignoring background handler settles', () => {
    const controller = new AbortController();
    const background = { ...context, plugin: 'heartbeat-cancel', surface: 'background' as const, heartbeat: true, taskId: 'poll', signal: controller.signal };
    const span = startPluginOperation(background);
    expect(events().filter((row) => row.plugin === background.plugin)).toHaveLength(0);
    controller.abort();
    const rows = events().filter((row) => row.plugin === background.plugin);
    expect(rows.map((row) => row.event)).toEqual(['operation.start', 'operation.finish']);
    expect(rows[1]).toMatchObject({ outcome: 'cancelled', code: 'aborted' });
    expect(span.finish({ outcome: 'success' })).toEqual({ outcome: 'cancelled', code: 'aborted' });
    expect(events().filter((row) => row.plugin === background.plugin && row.event === 'operation.finish')).toHaveLength(1);
  });

  it('combines repeated healthy ticks with durations, but preserves failure/cancel/recovery transitions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
    const background = {
      ...context,
      plugin: 'heartbeat-distribution',
      operation: 'background.tick',
      surface: 'background' as const,
      taskId: 'poll',
      heartbeat: true,
    };
    const tick = (ms: number) => {
      const span = startPluginOperation(background);
      vi.advanceTimersByTime(ms);
      span.finish();
    };
    for (const ms of [1, 20, 200, 2000, 12_000]) tick(ms);
    flushPluginHeartbeats(background.plugin);
    const heartbeat = events().find((row) => row.event === 'background.heartbeat');
    expect(heartbeat).toMatchObject({
      scope: 'plugin-heartbeat',
      schemaVersion: 1,
      plugin: background.plugin,
      taskId: 'poll',
      count: 4,
      totalMs: 14_220,
      minMs: 20,
      maxMs: 12_000,
      durationBoundsMs: [10, 100, 1000, 10_000],
      durationBuckets: [0, 1, 1, 1, 1],
      ...processIdentity(),
    });
    startPluginOperation(background).finish(undefined, { error: new Error('PRIVATE_FAILURE') });
    tick(10); // verified transition back to handler success, not product acceptance
    tick(5); // partial heartbeat tail must survive cancellation/flush
    const controller = new AbortController();
    const cancelled = startPluginOperation({ ...background, signal: controller.signal });
    controller.abort();
    cancelled.finish();
    expect(
      events()
        .filter((row) => row.event === 'operation.finish')
        .map((row) => row.outcome),
    ).toEqual(['success', 'error', 'success', 'cancelled']);
    expect(
      events()
        .filter((row) => row.event === 'background.heartbeat')
        .reduce((sum, row) => sum + Number(row.count), 0),
    ).toBe(5);
    expect(JSON.stringify(events())).not.toContain('PRIVATE_FAILURE');
  });

  it('flushes evicted groups instead of silently losing their counts', () => {
    const background = {
      ...context,
      plugin: 'heartbeat-cap',
      operation: 'background.tick',
      surface: 'background' as const,
      heartbeat: true,
    };
    for (let index = 0; index < 270; index++) {
      const task = { ...background, taskId: `task.${index}` };
      startPluginOperation(task).finish();
      startPluginOperation(task).finish();
    }
    flushLogs();
    const rows = readdirSync(dir)
      .filter((file) => file.startsWith('plugin-heartbeat-'))
      .flatMap((file) =>
        readFileSync(join(dir, file), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      );
    expect(rows.filter((row) => row.plugin === background.plugin)).toHaveLength(270);
    expect(rows.filter((row) => row.plugin === background.plugin).reduce((sum, row) => sum + row.count, 0)).toBe(270);
  });
});
