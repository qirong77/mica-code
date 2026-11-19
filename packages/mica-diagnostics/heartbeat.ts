import { logger } from './index.js';
import { randomUUID } from 'node:crypto';
import type { OperationOutcome } from './operation.js';

const HEARTBEAT_MS = 60_000;
const MAX_HEARTBEATS = 256;
type Metadata = {
  operationId: string;
  plugin: string;
  pluginVersion: string;
  operation: string;
  surface?: string;
  taskId?: string;
  pid: number;
  generation: string;
};
type Heartbeat = {
  meta: Metadata;
  signature: string;
  result: OperationOutcome;
  bucket?: {
    heartbeatId: string;
    windowStart: number;
    firstAt: number;
    lastAt: number;
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
    durationBuckets: number[];
  };
};
const heartbeats = new Map<string, Heartbeat>();
let timer: ReturnType<typeof setInterval> | undefined;

function flush(state: Heartbeat): void {
  const bucket = state.bucket;
  if (!bucket) return;
  state.bucket = undefined;
  const { operationId: _operationId, ...meta } = state.meta;
  logger('plugin-heartbeat').info('background.heartbeat', {
    ...meta,
    schemaVersion: 1,
    ...state.result,
    ...bucket,
    windowEnd: bucket.windowStart + HEARTBEAT_MS,
    durationBoundsMs: [10, 100, 1000, 10_000],
  });
}

/** Counts exclude immediate transition records; explicit/exit flushes retain the partial tail. */
export function flushPluginHeartbeats(plugin?: string): void {
  for (const state of heartbeats.values()) if (!plugin || state.meta.plugin === plugin) flush(state);
}

export function combineHeartbeat(meta: Metadata, result: OperationOutcome, started: number, ms: number): boolean {
  const key = `${meta.plugin}\n${meta.pluginVersion}\n${meta.taskId ?? meta.operation}`;
  let state = heartbeats.get(key);
  const signature = `${result.outcome}:${result.code}`;
  if (!state) {
    if (heartbeats.size >= MAX_HEARTBEATS) {
      const oldest = heartbeats.keys().next().value!;
      flush(heartbeats.get(oldest)!);
      heartbeats.delete(oldest);
    }
    state = { meta, signature, result };
    heartbeats.set(key, state);
    return false; // The first result is also a state transition.
  }
  if (!['success', 'skipped', 'waiting'].includes(result.outcome) || state.signature !== signature) {
    flush(state);
    state.signature = signature;
    state.result = result;
    state.meta = meta;
    return false;
  }
  const now = Date.now();
  const windowStart = Math.floor(now / HEARTBEAT_MS) * HEARTBEAT_MS;
  if (state.bucket && state.bucket.windowStart !== windowStart) flush(state);
  const bucket = (state.bucket ??= {
    heartbeatId: randomUUID(),
    windowStart,
    firstAt: started,
    lastAt: now,
    count: 0,
    totalMs: 0,
    minMs: ms,
    maxMs: ms,
    durationBuckets: [0, 0, 0, 0, 0],
  });
  bucket.count++;
  bucket.lastAt = now;
  bucket.totalMs += ms;
  bucket.minMs = Math.min(bucket.minMs, ms);
  bucket.maxMs = Math.max(bucket.maxMs, ms);
  const index = ms < 10 ? 0 : ms < 100 ? 1 : ms < 1000 ? 2 : ms < 10_000 ? 3 : 4;
  bucket.durationBuckets[index] = bucket.durationBuckets[index]! + 1;
  if (!timer) {
    timer = setInterval(() => flushPluginHeartbeats(), HEARTBEAT_MS);
    timer.unref?.();
  }
  return true;
}
