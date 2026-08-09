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
  if (
    type === 'api_error' ||
    type === 'server_error' ||
    type === 'rate_limit_error' ||
    type === 'service_unavailable_error'
  ) {
    return true;
  }

  const code = typeof err.code === 'string' ? err.code.toLowerCase() : undefined;
  if (code) {
    if (code === 'econnreset' || code === 'etimedout' || code === 'econnrefused' || code === 'enotfound') return true;
    if (
      code === 'rate_limit_exceeded' ||
      code === 'rate_limit_error' ||
      code === 'server_error' ||
      code === 'service_unavailable' ||
      code === 'server_is_overloaded' ||
      code === 'slow_down' ||
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
    /** 指数退避倍数（每次重试 delayMs * factor^attempt），默认 1（固定间隔） */
    backoffFactor?: number;
    /** 单次重试等待上限，默认与 delayMs 相同 */
    maxDelayMs?: number;
    signal?: AbortSignal;
    /**
     * 覆盖默认的可重试判定。默认用 isRetryableError(error)。
     * 典型用法：调用方想在"重放安全"的前提下才重试（例如 provider 流消费
     * 只有 0 输出时才可整体重发），用闭包状态决定是否允许本次重试。
     */
    shouldRetry?: (error: unknown) => boolean;
    /** 每次实际重试前回调（用于诊断日志） */
    onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
  },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.delayMs ?? DEFAULT_RETRY_DELAY_MS;
  const backoffFactor = options?.backoffFactor ?? 1;
  const maxDelayMs = options?.maxDelayMs ?? baseDelayMs;
  const shouldRetry = options?.shouldRetry ?? isRetryableError;
  const onRetry = options?.onRetry;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfQueryStopped(options);
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && shouldRetry(error)) {
        const delayMs = Math.min(baseDelayMs * Math.pow(backoffFactor, attempt), maxDelayMs);
        onRetry?.({ attempt: attempt + 1, error, delayMs });
        await sleep(delayMs, options?.signal);
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}
