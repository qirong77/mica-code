import { randomUUID } from 'node:crypto';

/** A PID can be reused; this token identifies this writer's process lifetime. */
const identity = Object.freeze({ pid: process.pid, generation: randomUUID() });

export function processIdentity(): Readonly<{ pid: number; generation: string }> {
  return identity;
}

/** Versions must come from the loaded producer, never a later catalog lookup. */
export function diagnosticPluginVersion(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9._+-]{1,60}$/i.test(value) ? value : 'unknown';
}
