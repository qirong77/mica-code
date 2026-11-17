import { randomUUID } from 'node:crypto';
import { logger } from './index.js';

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
  surface?: 'tool' | 'command' | 'panel' | 'action' | 'menu' | 'background' | 'hook' | 'lifecycle' | 'page' | 'mcp' | 'launcher';
  signal?: AbortSignal;
  /** Observations never include the value or the exception, only this projection. */
  classify?: (value: unknown) => OperationOutcome;
};

export function operationResult(value: unknown): OperationOutcome {
  if (typeof value === 'string' && /^(?:Error:|Tool (?:execution )?(?:error|failed):|工具[^\n]*(?:失败|错误)[:：])/i.test(value.trimStart()))
    return { outcome: 'error', code: 'explicit_error' };
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
    const neutral: Record<string, OperationOutcome['outcome']> = {
      cancelled: 'cancelled', aborted: 'cancelled', killed: 'cancelled', declined: 'declined', denied: 'declined',
      waiting: 'waiting', running: 'waiting', conflict: 'conflict', busy: 'busy', partial: 'partial', unknown: 'unknown',
      skipped: 'skipped', 'expected-exit': 'success',
    };
    if (typeof outcome === 'string' && Object.hasOwn(neutral, outcome))
      return { outcome: neutral[outcome]!, code: outcome };
    if (result.conflict === true) return { outcome: 'conflict', code: 'conflict' };
    if (result.cancelled === true || result.canceled === true) return { outcome: 'cancelled', code: 'aborted' };
    if (result.timedOut === true || result.timed_out === true || outcome === 'timeout')
      return { outcome: 'timeout', code: 'timeout' };
    if (result.isError === true) return { outcome: 'error', code: 'mcp_error' };
    if (result.ok === false || result.success === false || outcome === 'error' || outcome === 'failed' || result.error)
      return { outcome: 'error', code: 'returned_error' };
    const exitCode = result.exitCode ?? result.exit_code;
    if (typeof exitCode === 'number' && exitCode !== 0) return { outcome: 'error', code: 'nonzero_exit' };
  }
  return { outcome: 'success', code: 'ok' };
}

function metadata(context: OperationContext) {
  return {
    schemaVersion: 1, operationId: randomUUID(),
    plugin: /^[a-z0-9][a-z0-9._-]{0,159}$/i.test(context.plugin) ? context.plugin : 'unknown',
    pluginVersion: context.pluginVersion && /^[a-z0-9._+-]{1,60}$/i.test(context.pluginVersion) ? context.pluginVersion : undefined,
    operation: /^[a-z][a-z0-9:._-]{0,79}$/i.test(context.operation) ? context.operation : 'custom',
    surface: ['tool', 'command', 'panel', 'action', 'menu', 'background', 'hook', 'lifecycle', 'page', 'mcp', 'launcher'].includes(context.surface ?? '') ? context.surface : undefined,
    pid: process.pid,
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

function failureOutcome(error: unknown, signal?: AbortSignal): OperationOutcome {
  const reason = signal?.aborted ? signal.reason : error;
  const name = reason instanceof Error ? reason.name : undefined;
  return name === 'TimeoutError'
    ? { outcome: 'timeout', code: 'timeout' }
    : signal?.aborted || name === 'AbortError' || name === 'AgentAbortError'
      ? { outcome: 'cancelled', code: 'aborted' }
      : { outcome: 'error', code: 'exception' };
}

/** Synchronous begin/end handles also cover handlers whose return type cannot become a Promise. */
export function startPluginOperation(context: OperationContext) {
  const meta = metadata(context);
  const started = Date.now();
  let finished = false;
  try { log.info('operation.start', meta); } catch { /* diagnostics are not a task dependency */ }
  return {
    finish(value?: unknown, failure?: { error: unknown }): OperationOutcome {
      let outcome: OperationOutcome;
      try {
        outcome = failure ? failureOutcome(failure.error, context.signal) : classified(context, value);
      } catch { outcome = { outcome: 'unknown', code: 'classification_failed' }; }
      if (!finished) {
        finished = true;
        try {
          const fields = { ...meta, ...outcome, ms: Math.max(0, Date.now() - started) };
          if (outcome.outcome === 'error' || outcome.outcome === 'timeout') log.warn('operation.finish', fields);
          else log.info('operation.finish', fields);
        } catch { /* logging must not change the handler's result */ }
      }
      return outcome;
    },
  };
}

/** Only an allowlisted projection reaches diagnostics' timer, never results or exception messages. */
export async function observePluginOperation<T>(context: OperationContext, task: () => T | Promise<T>): Promise<T> {
  const meta = {
    ...metadata(context),
    outcome: 'unknown' as OperationOutcome['outcome'], code: 'unknown',
  };
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
      result = failureOutcome(error, context.signal);
    }
    Object.assign(meta, result);
    return result.outcome === 'error' || result.outcome === 'timeout' ? { ok: false, error: result.code } : { ok: true };
  };
  // Never retry execute if logging fails: the task may already have performed a write.
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
