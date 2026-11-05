import type { AgentObservationEvent } from '@packages/mica-plugin/AgentObservation.js';
import { identifier, timestamp, type Evidence } from './state.js';

type Run = { runId?: number; calls: Map<string, string>; results: Map<string, Evidence> };
/** Runtime identities are opaque; only turn:before owners can acquire an observation run. */
export class DeliveryEvidence {
  private readonly runs = new WeakMap<object, Run>();
  begin(owner: object): void {
    this.runs.set(owner, { calls: new Map(), results: new Map() });
  }
  observe(event: AgentObservationEvent): void {
    const run = this.runs.get(event.owner);
    if (!run) return;
    if (event.type === 'run:start') {
      if (event.helper || event.delegation) return;
      run.runId = event.runId;
      run.calls.clear();
      run.results.clear();
      return;
    }
    if (run.runId !== event.runId) return;
    if (
      event.type === 'tool:call' &&
      identifier(event.id) &&
      identifier(event.name) &&
      event.name !== 'task_delivery'
    ) {
      if (run.calls.size >= 128) run.calls.delete(run.calls.keys().next().value!);
      run.calls.set(event.id, event.name);
    }
    if (
      event.type !== 'tool:result' ||
      !identifier(event.id) ||
      run.calls.get(event.id) !== event.name ||
      !timestamp(event.timestamp)
    )
      return;
    run.calls.delete(event.id);
    if (run.results.size >= 64) run.results.delete(run.results.keys().next().value!);
    const exitCode = commandExitCode(event.name, event.result);
    run.results.set(event.id, {
      id: event.id,
      tool: event.name,
      runId: event.runId,
      observedAt: event.timestamp,
      kind: exitCode === undefined ? 'returned' : 'command-exit',
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  }
  select(owner: object, ids: string[]): Evidence[] {
    const run = this.runs.get(owner);
    return [...new Set(ids)].flatMap((id) => {
      const item = run?.results.get(id);
      return item ? [{ ...item }] : [];
    });
  }
}

/** Parse only the known run_shell metadata prefix, never stdout text or a model report. */
export function commandExitCode(name: string, result: string): number | undefined {
  if (name !== 'run_shell') return;
  const header = result
    .slice(0, 16000)
    .match(
      /^\[command\]\ncommand: [^\n]*\ncwd: [^\n]*\nshell: [^\n]*\ntimeout_ms: \d+\nduration_ms: \d+\nexit_code: (-?\d+)\nsignal: null\ntimed_out: false\naborted: false\nstream_output_truncated: (?:true|false)\nstdout_truncated: (?:true|false)\nstderr_truncated: (?:true|false)\n\n\[stdout\]\n/,
    );
  if (!header) return;
  const code = Number(header[1]);
  return Number.isSafeInteger(code) ? code : undefined;
}
