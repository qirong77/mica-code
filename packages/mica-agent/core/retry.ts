const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 3000;

export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Record<string, unknown>;

  if (err.name === 'AbortError') return false;

  const status = typeof err.status === 'number' ? err.status : undefined;
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }

  const type = typeof err.type === 'string' ? err.type : undefined;
  if (type === 'connection_error' || type === 'timeout_error') return true;
  if (type === 'api_error' || type === 'server_error' || type === 'rate_limit_error') return true;

  const code = typeof err.code === 'string' ? err.code.toLowerCase() : undefined;
  if (code) {
    if (code === 'econnreset' || code === 'etimedout' || code === 'econnrefused' || code === 'enotfound') return true;
    if (
      code === 'rate_limit_exceeded' ||
      code === 'rate_limit_error' ||
      code === 'server_error' ||
      code === 'service_unavailable' ||
      code === 'temporarily_unavailable' ||
      code === 'overloaded'
    ) {
      return true;
    }
  }

  if (err.message && typeof err.message === 'string') {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('rate limit') ||
      msg.includes('rate_limit') ||
      msg.includes('too many requests') ||
      msg.includes('timeout') ||
      msg.includes('connection') ||
      msg.includes('network') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('5xx') ||
      msg.includes('server_error') ||
      msg.includes('server error') ||
      msg.includes('service unavailable') ||
      msg.includes('internal server error') ||
      msg.includes('temporarily unavailable') ||
      msg.includes('try again later') ||
      msg.includes('overloaded')
    ) {
      return true;
    }
  }

  return false;
}

export function abortError(): Error {
  const error = new Error('Agent query aborted');
  error.name = 'AbortError';
  return error;
}

export function throwIfQueryStopped(options?: { signal?: AbortSignal; shouldContinue?: () => boolean }): void {
  if (options?.signal?.aborted || options?.shouldContinue?.() === false) {
    throw abortError();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let onAbort: () => void;
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    onAbort = () => {
      finish(() => reject(abortError()));
    };
    timer = setTimeout(() => {
      finish(resolve);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    delayMs?: number;
    signal?: AbortSignal;
  },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const delayMs = options?.delayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfQueryStopped(options);
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && isRetryableError(error)) {
        await sleep(delayMs, options?.signal);
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}
