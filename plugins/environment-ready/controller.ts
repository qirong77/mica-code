import { randomUUID } from 'node:crypto';
import type { ExperienceEvent, ExperienceFields } from '@packages/mica-plugin/PluginExperience.js';
import { probeTarget } from './probes.js';
import {
  FRESHNESS_MS,
  fingerprint,
  normalizeState,
  parseTargets,
  type EnvironmentState,
  type ProbeStatus,
  type Target,
} from './state.js';

export type Owner = { handle: unknown; id: string };
export type Surface = 'card' | 'panel' | 'tool';
export type Track = (event: ExperienceEvent, fields?: ExperienceFields, owner?: unknown) => void;
export type ControllerDeps = {
  capture(context?: unknown): Owner;
  /** A runtime may resume another session while retaining the same owner object. */
  ownerAvailable?(owner: Owner): boolean;
  read(owner: Owner): unknown;
  write(state: EnvironmentState, owner: Owner): void;
  probe?: (target: Target, signal: AbortSignal) => Promise<ProbeStatus>;
  now?: () => number;
  revision?: () => string;
  track: Track;
  report?: (failed: number, count: number) => void;
};
export type CheckResult = { outcome: 'success' | 'error' | 'stale' | 'busy'; count: number };

export class EnvironmentController {
  private disposed = false;
  private active?: { controller: AbortController; ownerId: string };
  // Persisted results are displayed as history until this plugin instance verifies them.
  private verified = new Map<string, string>();
  private readonly now: () => number;
  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now;
  }
  capture(context?: unknown): Owner {
    return this.deps.capture(context);
  }
  read(owner: Owner): EnvironmentState {
    return normalizeState(this.deps.read(owner));
  }
  private snapshot(state: EnvironmentState): string {
    return fingerprint([state.revision, state.targets]);
  }
  private verifiedKey(owner: Owner, state: EnvironmentState, id: string): string {
    return `${owner.id}:${this.snapshot(state)}:${id}`;
  }
  liveStatus(owner: Owner, state: EnvironmentState, id: string): ProbeStatus | undefined {
    const status = state.statuses[id];
    if (!status || this.verified.get(this.verifiedKey(owner, state, id)) !== fingerprint(status)) return undefined;
    const age = this.now() - status.checkedAt;
    return age >= 0 && age <= FRESHNESS_MS ? status : undefined;
  }
  replace(value: unknown, owner: Owner, surface: Surface = 'tool'): EnvironmentState {
    this.assertActive();
    const targets = parseTargets(value);
    if (this.active?.ownerId === owner.id) this.active.controller.abort();
    const next: EnvironmentState = {
      version: 1,
      revision: (this.deps.revision ?? randomUUID)(),
      targets,
      statuses: {},
    };
    this.deps.write(next, owner);
    for (const key of this.verified.keys()) {
      if (key.startsWith(`${owner.id}:`)) this.verified.delete(key);
    }
    this.deps.track(
      targets.length ? 'update' : 'clear',
      {
        surface,
        action: targets.length ? 'set' : 'clear',
        revision: next.revision,
        count: targets.length,
        outcome: 'success',
      },
      owner.handle,
    );
    return next;
  }
  remove(id: string, owner: Owner, surface: Surface = 'tool'): void {
    const current = this.read(owner);
    if (!current.targets.some((target) => target.id === id)) throw new Error('目标不存在，请刷新列表');
    this.replace(
      current.targets.filter((target) => target.id !== id),
      owner,
      surface,
    );
  }
  dismiss(owner: Owner): void {
    this.assertActive();
    const state = this.read(owner);
    this.deps.write({ ...state, dismissedRevision: state.revision }, owner);
    this.deps.track(
      'dismiss',
      {
        surface: 'card',
        action: 'dismiss',
        revision: state.revision,
        outcome: 'dismissed',
        count: state.targets.length,
      },
      owner.handle,
    );
  }
  reopen(owner: Owner): void {
    this.assertActive();
    const state = this.read(owner);
    if (state.dismissedRevision) {
      delete state.dismissedRevision;
      this.deps.write(state, owner);
    }
  }
  key(state: EnvironmentState, id?: string): string {
    return `${this.snapshot(state)}${id ? `:${id}` : ''}`;
  }
  matches(state: EnvironmentState, key: string | undefined, id?: string): boolean {
    return key === this.key(state, id);
  }
  track: Track = (event, fields, owner) => this.deps.track(event, fields, owner);
  async check(
    owner: Owner,
    options: { id?: string; signal?: AbortSignal; surface?: Surface } = {},
  ): Promise<CheckResult> {
    this.assertActive();
    if (this.deps.ownerAvailable?.(owner) === false) return { outcome: 'stale', count: 0 };
    if (this.active) return { outcome: 'busy', count: 0 };
    const state = this.read(owner);
    const targets = options.id ? state.targets.filter((target) => target.id === options.id) : state.targets;
    if (options.id && !targets.length) throw new Error('目标不存在，请刷新列表');
    if (!targets.length) return { outcome: 'success', count: 0 };
    const snapshot = this.snapshot(state);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const active = { controller, ownerId: owner.id };
    this.active = active;
    const started = this.now();
    try {
      const results = await Promise.all(
        targets.map(async (target) => {
          try {
            return await (this.deps.probe ?? probeTarget)(target, controller.signal);
          } catch {
            return { checkedAt: this.now(), reachable: false, healthy: null, error: 'connection' as const };
          }
        }),
      );
      // Some hosts scope state by the current session and ignore the owner argument.
      if (this.deps.ownerAvailable?.(owner) === false) return { outcome: 'stale', count: 0 };
      const current = this.read(owner);
      if (this.disposed || controller.signal.aborted || this.snapshot(current) !== snapshot) {
        this.deps.track(
          'check',
          {
            surface: options.surface ?? 'background',
            action: 'check',
            outcome: 'stale',
            revision: state.revision,
            count: targets.length,
          },
          owner.handle,
        );
        return { outcome: 'stale', count: 0 };
      }
      const statuses = { ...current.statuses };
      targets.forEach((target, index) => {
        statuses[target.id] = results[index]!;
      });
      const next = normalizeState({ ...current, statuses });
      this.deps.write(next, owner);
      targets.forEach((target) => {
        const result = next.statuses[target.id];
        if (result) this.verified.set(this.verifiedKey(owner, next, target.id), fingerprint(result));
      });
      const failed = results.filter((result) => !result.reachable || result.healthy === false).length;
      this.deps.report?.(failed, targets.length);
      this.deps.track(
        'check',
        {
          surface: options.surface ?? 'background',
          action: 'check',
          outcome: failed ? 'error' : 'success',
          revision: state.revision,
          count: targets.length,
          durationMs: Math.max(0, this.now() - started),
        },
        owner.handle,
      );
      return { outcome: failed ? 'error' : 'success', count: targets.length };
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (this.active === active) this.active = undefined;
    }
  }
  dispose(): void {
    this.disposed = true;
    this.active?.controller.abort();
    this.verified.clear();
  }
  private assertActive(): void {
    if (this.disposed) throw new Error('Environment Ready 已停用');
  }
}
