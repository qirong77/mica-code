import { vi } from 'vitest';
import { EnvironmentController, type ControllerDeps, type Owner } from './controller.js';
import type { EnvironmentState, ProbeStatus, Target } from './state.js';

export const web: Target = { id: 'web', label: 'Web', kind: 'http', url: 'http://127.0.0.1:3000/health' };
export function harness(overrides: Partial<ControllerDeps> = {}) {
  const ownerA: Owner = { id: 'session-a', handle: { id: 'session-a' } };
  const ownerB: Owner = { id: 'session-b', handle: { id: 'session-b' } };
  let current = ownerA;
  let now = 1000;
  let revision = 0;
  const states = new Map<string, unknown>();
  const writes = vi.fn((value: EnvironmentState, owner: Owner) => {
    states.set(owner.id, value);
  });
  const track = vi.fn();
  const probe = vi.fn(
    async (): Promise<ProbeStatus> => ({ checkedAt: now, reachable: true, healthy: true, statusCode: 200 }),
  );
  const deps: ControllerDeps = {
    capture: () => current,
    read: (owner) => states.get(owner.id),
    write: writes,
    now: () => now,
    revision: () => `config-${++revision}`,
    probe,
    track,
    ...overrides,
  };
  const controller = new EnvironmentController(deps);
  return {
    controller,
    deps,
    ownerA,
    ownerB,
    states,
    writes,
    track,
    probe,
    setCurrent: (owner: Owner) => {
      current = owner;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
