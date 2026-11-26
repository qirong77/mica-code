/**
 * 请求级重试策略：一次模型请求没有正常结束就重发，唯一不重发的是用户自己按了停止。
 *
 * 这里不再按错误类型挑「值不值得重试」：400 的网关解析失败、429、5xx、连接被掐、
 * 流中途断、握手成功后长时间没有数据，全部走同一条路。确定性错误（上下文超长、
 * 参数不合法）重发也不会变好，但那是把「重试了几次、最后一次为什么失败」摆到界面上
 * 让人决定要不要停，比在客户端猜哪些错误不该重发更可靠。
 */
export const REQUEST_MAX_RETRIES = 10;
const REQUEST_RETRY_BASE_DELAY_MS = 2_000;
const REQUEST_RETRY_MAX_DELAY_MS = 30_000;

/**
 * 第 `retry` 次重试前等多久（`retry` 从 1 开始）：2s 起步、每次翻倍、封顶 30s。
 *
 * 10 次合计约 3.5 分钟：短抖动很快就能过去，又不至于在一条注定失败的请求上
 * 干等十几分钟——等人看到界面上的次数与原因后自己中止。
 */
export function requestRetryDelayMs(retry: number): number {
  return Math.min(REQUEST_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retry - 1), REQUEST_RETRY_MAX_DELAY_MS);
}

/** 用户中止（CLI 的 `AbortError`、宿主的 `AgentAbortError`）不是请求失败，不该重发。 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'AgentAbortError';
}

/**
 * 展示用的一句话失败原因：正文之后补上 HTTP 状态与错误码。
 *
 * notice 里只有 `error.message` 时，「500」与「socket closed」看起来一样都是
 * 一句英文；把状态码和 code 一并写出来，才能判断是上游 5xx 还是链路断了。
 */
export function describeRequestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '未知错误');
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const detail = [
    typeof record.status === 'number' ? `HTTP ${record.status}` : '',
    typeof record.code === 'string' && record.code && !message.includes(record.code) ? record.code : '',
  ].filter(Boolean);
  if (!detail.length) return message;
  if (typeof record.status === 'number' && message.includes(String(record.status))) return message;
  return `${message}（${detail.join(' · ')}）`;
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

/**
 * 重发 `fn` 直到它正常返回、用户中止，或用完 `maxRetries`。
 *
 * 调用方只需要把「一次完整的模型请求」交给它；能不能安全重发（已经吐出去的正文与
 * 思考能不能撤掉）由调用方在 `onRetry` 里处理，这里不做取舍。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number;
    /** 第 `retry` 次重试前的等待（`retry` 从 1 开始）。 */
    delayMs: (retry: number) => number;
    signal?: AbortSignal;
    /** 每次实际重试前回调：展示层用它报「第几次、多久后、上一次为什么失败」。 */
    onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
  },
): Promise<T> {
  for (let retry = 0; ; retry++) {
    throwIfQueryStopped({ signal: options.signal });
    try {
      return await fn();
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted || retry >= options.maxRetries) throw error;
      const delayMs = options.delayMs(retry + 1);
      options.onRetry?.({ attempt: retry + 1, error, delayMs });
      await sleep(delayMs, options.signal);
    }
  }
}
