import { processIdentity } from './identity.js';

export type WriterCounters = {
  dropped: number;
  overflowDrops: number;
  serializationFailures: number;
  /** Entries in batches whose append failed; a partial append is possible. */
  writeFailures: number;
};
export type WriterPolicy = {
  logLevel: string;
  pluginLogEnabled: boolean;
  closePolicy: 'best_effort_sync_exit';
};
export type WriterCheckpoint = WriterCounters &
  WriterPolicy & {
    at: number;
    level: 'info' | 'warn';
    scope: 'writer-health';
    event: 'writer.checkpoint';
    schemaVersion: 1;
    pid: number;
    generation: string;
    reason: 'periodic' | 'flush' | 'exit';
    lostLowerBound: number;
    checkpointFailures: number;
  };

/** A protected side channel: never enqueue a checkpoint into the writer it describes. */
export class WriterHealth {
  private writing = false;
  private lastAttemptAt = -Infinity;
  private lastSignature = '';
  private checkpointFailures = 0;

  constructor(
    private readonly persist: (entry: WriterCheckpoint) => void,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 60_000,
  ) {}

  checkpoint(counters: WriterCounters, policy: WriterPolicy, reason: WriterCheckpoint['reason'] = 'periodic'): boolean {
    if (this.writing) return false;
    const at = this.now();
    const signature = JSON.stringify([counters, policy, this.checkpointFailures]);
    if (reason === 'periodic' && at - this.lastAttemptAt < this.intervalMs) return false;
    if (reason === 'flush' && signature === this.lastSignature) return false;
    this.lastAttemptAt = at;
    this.writing = true;
    try {
      this.persist({
        at,
        level: counters.dropped || this.checkpointFailures ? 'warn' : 'info',
        scope: 'writer-health',
        event: 'writer.checkpoint',
        schemaVersion: 1,
        ...processIdentity(),
        ...counters,
        ...policy,
        reason,
        // These entries never reached append. A throwing append may have written
        // a prefix, so writeFailures must not inflate the proven loss lower bound.
        lostLowerBound: counters.overflowDrops + counters.serializationFailures,
        checkpointFailures: this.checkpointFailures,
      });
      this.lastSignature = signature;
      return true;
    } catch {
      this.checkpointFailures++;
      return false; // Retry later with the latest cumulative counters, never recursively.
    } finally {
      this.writing = false;
    }
  }
}
