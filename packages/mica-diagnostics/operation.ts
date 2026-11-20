import { randomUUID } from 'node:crypto';
import { logger } from './index.js';
import { diagnosticPluginVersion, processIdentity } from './identity.js';
import { combineHeartbeat } from './heartbeat.js';

export type OperationOutcome = {
  outcome: 'success' | 'error' | 'cancelled' | 'timeout' | 'declined' | 'waiting' | 'conflict' | 'busy' | 'partial' | 'unknown' | 'skipped';
  code: string;
};

const log = logger('plugin-operation');

/** Only fixed operation names and trusted plugin identities belong in this envelope. */
export type OperationContext = {
  plugin: string;
  pluginVersion?: string;
  operation: string;
  surface?: 'tool' | 'command' | 'panel' | 'action' | 'menu' | 'background' | 'hook' | 'lifecycle' | 'page' | 'mcp' | 'api' | 'launcher';
  signal?: AbortSignal;
  /** Fixed background task identity. Routine successful ticks are combined, not sampled. */
  taskId?: string;
  heartbeat?: boolean;
  /** Observations never include the value or the exception, only this projection. */
  classify?: (value: unknown) => OperationOutcome;
};

export function operationResult(value: unknown): OperationOutcome {
  if (typeof value === 'string' && value.trimStart().startsWith('{')) {
    try { value = JSON.parse(value); } catch { /* ordinary text, not an envelope */ }
  }
  // Tool media carry a leading metadata block; never scan arbitrary stdout/source.
  if (Array.isArray(value) && value[0]?.type === 'text' && typeof value[0].text === 'string') {
    const head = value[0].text.trim();
    if (head.startsWith('{')) {
      try { value = JSON.parse(head); } catch { /* plain tool text */ }
    }
  }
  if (value && typeof value === 'object') {
    const result = value as Record<string, unknown>;
    const outcome = result.outcome ?? result.status;
    const outcomes: Record<string, OperationOutcome['outcome']> = {
      success: 'success', error: 'error', failure: 'error', failed: 'error', timeout: 'timeout',
      cancelled: 'cancelled', aborted: 'cancelled', killed: 'cancelled', declined: 'declined', denied: 'declined',
      waiting: 'waiting', running: 'waiting', conflict: 'conflict', busy: 'busy', partial: 'partial', unknown: 'unknown',
      skipped: 'skipped', 'expected-exit': 'success',
    };
    // The explicit contract wins over structural transport flags, never over prose.
    if (outcome !== undefined) {
      if (typeof outcome !== 'string' || !Object.hasOwn(outcomes, outcome))
        return { outcome: 'unknown', code: 'invalid_outcome' };
      return { outcome: outcomes[outcome]!, code: resultCode(result.code, outcome) };
    }
    if (typeof result.code === 'string' && BUSY_CODES.has(result.code)) return { outcome: 'busy', code: resultCode(result.code, 'busy') };
    if (result.conflict === true) return { outcome: 'conflict', code: resultCode(result.code, 'conflict') };
    if (result.cancelled === true || result.canceled === true) return { outcome: 'cancelled', code: resultCode(result.code, 'aborted') };
    if (result.timedOut === true || result.timed_out === true)
      return { outcome: 'timeout', code: resultCode(result.code, 'timeout') };
    if (result.isError === true) return { outcome: 'error', code: resultCode(result.code, 'mcp_error') };
    if (result.ok === false || result.success === false || result.error)
      return { outcome: 'error', code: resultCode(result.code, 'returned_error') };
    const exitCode = result.exitCode ?? result.exit_code;
    if (typeof exitCode === 'number' && exitCode !== 0) return { outcome: 'error', code: resultCode(result.code, 'nonzero_exit') };
    return { outcome: 'success', code: resultCode(result.code, 'ok') };
  }
  return { outcome: 'success', code: 'ok' };
}

function resultCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[a-z][a-z0-9._-]{0,59}$/i.test(value) ? value : fallback;
}

function metadata(context: OperationContext) {
  return {
    schemaVersion: 1, operationId: randomUUID(),
    plugin: /^[a-z0-9][a-z0-9._-]{0,159}$/i.test(context.plugin) ? context.plugin : 'unknown',
    pluginVersion: diagnosticPluginVersion(context.pluginVersion),
    operation: /^[a-z][a-z0-9:._-]{0,79}$/i.test(context.operation) ? context.operation : 'custom',
    surface: ['tool', 'command', 'panel', 'action', 'menu', 'background', 'hook', 'lifecycle', 'page', 'mcp', 'api', 'launcher'].includes(context.surface ?? '') ? context.surface : undefined,
    taskId: context.taskId && /^[a-z][a-z0-9:._-]{0,79}$/i.test(context.taskId) ? context.taskId : undefined,
    ...processIdentity(),
  };
}

function classified(context: OperationContext, value: unknown): OperationOutcome {
  try {
    const result = (context.classify ?? operationResult)(value);
    return {
      outcome: ['success', 'error', 'cancelled', 'timeout', 'declined', 'waiting', 'conflict', 'busy', 'partial', 'unknown', 'skipped'].includes(result.outcome) ? result.outcome : 'unknown',
      code: /^[a-z][a-z0-9._-]{0,59}$/i.test(result.code) ? result.code : 'unknown',
    };
  } catch { return { outcome: 'unknown', code: 'classification_failed' }; }
}

export function operationFailure(error: unknown, signal?: AbortSignal): OperationOutcome {
  const reason = signal?.aborted ? signal.reason : error;
  const value = reason && typeof reason === 'object' ? reason as { name?: unknown; code?: unknown } : {};
  const name = value.name;
  return name === 'TimeoutError'
    ? { outcome: 'timeout', code: 'timeout' }
    : signal?.aborted || name === 'AbortError' || name === 'AgentAbortError'
      ? { outcome: 'cancelled', code: 'aborted' }
      : name === 'BusyError' || (typeof value.code === 'string' && BUSY_CODES.has(value.code))
        ? { outcome: 'busy', code: 'busy' }
        : { outcome: 'error', code: 'exception' };
}

const BUSY_CODES = new Set(['busy', 'session_busy', 'turn_busy', 'resource_busy', 'maintenance_busy', 'TURN_LEASE_BUSY', 'EBUSY', 'ERR_BUSY', 'E_BUSY']);

/** Synchronous begin/end handles also cover handlers whose return type cannot become a Promise. */
export function startPluginOperation(context: OperationContext) {
  const meta = metadata(context);
  const started = Date.now();
  let terminal: OperationOutcome | undefined;
  const combined = context.heartbeat === true && context.surface === 'background';
  if (!combined) try { log.info('operation.start', meta); } catch { /* diagnostics are not a task dependency */ }
  const handle = {
    finish(value?: unknown, failure?: { error: unknown }): OperationOutcome {
      if (terminal) return terminal;
      let outcome: OperationOutcome;
      try {
        outcome = failure || context.signal?.aborted ? operationFailure(failure?.error, context.signal) : classified(context, value);
      } catch { outcome = { outcome: 'unknown', code: 'classification_failed' }; }
      terminal = outcome;
      context.signal?.removeEventListener('abort', onAbort);
      try {
        const ms = Math.max(0, Date.now() - started);
        if (combined && combineHeartbeat(meta, outcome, started, ms)) return outcome;
        // Routine starts are delayed; failures/transitions keep their actual start
        // time and an immediate paired finish. Never log handler arguments/results.
        if (combined) log.info('operation.start', { ...meta, at: started });
        const fields = { ...meta, ...outcome, ms };
        if (outcome.outcome === 'error' || outcome.outcome === 'timeout') log.warn('operation.finish', fields);
        else log.info('operation.finish', fields);
      } catch { /* logging must not change the handler's result */ }
      return outcome;
    },
  };
  // A handler may ignore its signal. Record caller cancellation immediately;
  // a late handler completion cannot rewrite it to success (nor proves it stopped).
  const onAbort = () => handle.finish(undefined, { error: context.signal?.reason });
  if (context.signal?.aborted) onAbort();
  else context.signal?.addEventListener('abort', onAbort, { once: true });
  return handle;
}

/** Only an allowlisted projection reaches diagnostics' timer, never results or exception messages. */
export async function observePluginOperation<T>(context: OperationContext, task: () => T | Promise<T>): Promise<T> {
  if (context.heartbeat && context.surface === 'background') {
    const span = startPluginOperation(context);
    try {
      const value = await awaitOperation(task, context.signal);
      span.finish(value);
      return value;
    } catch (error) {
      span.finish(undefined, { error });
      throw error;
    }
  }
  const meta = { ...metadata(context), outcome: 'unknown' as OperationOutcome['outcome'], code: 'unknown' };
  try { log.info('operation.start', meta); } catch { /* observation is best effort */ }
  let value: T;
  let failure: { error: unknown } | undefined;
  const execute = async () => {
    let result: OperationOutcome;
    try {
      value = await awaitOperation(task, context.signal);
      result = classified(context, value);
    } catch (error) {
      failure = { error };
      result = operationFailure(error, context.signal);
    }
    Object.assign(meta, result);
    return result.outcome === 'error' || result.outcome === 'timeout' ? { ok: false, error: result.code } : { ok: true };
  };
  // Retain ordinary operation baselines in slowReport. Never retry execute if
  // diagnostics fail: it may already have performed an irreversible side effect.
  await log.timedResult('operation.finish', execute, undefined, meta);
  if (failure) throw failure.error;
  return value!;
}

/** Honor the caller's deadline even if a plugin ignores cancellation. No local timeout is imposed. */
export function awaitOperation<T>(task: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (!signal) return Promise.resolve().then(task);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw abortReason(signal);
        return task();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          if (signal.aborted) reject(abortReason(signal));
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}
