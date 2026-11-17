import { CODEX_METHODS, MICA_METHODS } from '@packages/mica-runtime/index.js';

const METHODS = new Set<string>([...Object.values(CODEX_METHODS), ...Object.values(MICA_METHODS)]);

/** Do not log request params, client ids, error messages or stacks from RPC. */
export function appServerFailureFields(method: string, correlation: string, code: number, error?: unknown) {
  const name = error instanceof Error ? error.name : '';
  return {
    method: METHODS.has(method) ? method : 'unknown',
    requestId: correlation,
    code,
    phase: 'dispatch',
    category: name === 'AbortError' ? 'cancelled' : name === 'TimeoutError' ? 'timeout' : 'request-error',
  };
}
