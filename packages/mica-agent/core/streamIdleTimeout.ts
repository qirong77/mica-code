/**
 * 上游「握手成功但不再吐数据」的看门狗。
 *
 * OpenAI SDK 的超时只覆盖到响应头：`fetchWithTimeout` 在 fetch resolve 时
 * 就 clearTimeout 了，body 流的静默不受它约束。网关/模型侧卡住时会出现
 * HTTP 200 + SSE 流建立、然后一个事件都不发，客户端只能干等到上游自己断开
 * （实测约 10 分钟，最后以 output=0 的空响应收尾）。
 *
 * 这里给流迭代加空闲上限：距上一个事件超过 idleMs 就主动关掉底层连接，并抛
 * 出 name=TimeoutError 的错误 —— `isRetryableError()` 认这个名字，于是重试
 * 逻辑接管（只有本轮还没输出过文本/工具调用时才会重发，见 shouldRetry）。
 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

export function streamIdleTimeoutError(idleMs: number): Error {
  const elapsed = idleMs >= 1000 ? `${Math.round(idleMs / 1000)}s` : `${idleMs}ms`;
  const error = new Error(`No stream data from provider for ${elapsed} (waiting for model output).`);
  error.name = 'TimeoutError';
  return error;
}

function closeStream<T>(stream: AsyncIterable<T>, iterator: AsyncIterator<T>): void {
  const abortable = stream as { abort?: () => void; controller?: { abort?: () => void } };
  // SDK 的 Stream 自带 abort()（内部就是 controller.abort()），它在关连接的同时
  // 让迭代器收尾；普通异步生成器则只有 return()。
  try {
    if (typeof abortable.abort === 'function') abortable.abort();
    else abortable.controller?.abort?.();
  } catch {
    // Already closed.
  }
  // 底层可能是被上游卡住的原生异步生成器，return() 不会 settle，不能 await。
  try {
    void Promise.resolve(iterator.return?.()).catch(() => {});
  } catch {
    // Ignore: the stream is already being torn down.
  }
}

/** 包装一个异步流：超过 idleMs 没有下一个事件就中止并抛可重试超时错误。 */
export async function* withIdleTimeout<T>(
  stream: AsyncIterable<T>,
  options?: { idleMs?: number },
): AsyncGenerator<T> {
  const idleMs = options?.idleMs ?? STREAM_IDLE_TIMEOUT_MS;
  const iterator = stream[Symbol.asyncIterator]();
  let drained = false;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(streamIdleTimeoutError(idleMs)), idleMs);
      });
      const next = iterator.next();
      // 超时后底层流仍可能再抛错，别让它变成 unhandledRejection。
      next.catch(() => {});
      let step: IteratorResult<T>;
      try {
        step = await Promise.race([next, stalled]);
      } finally {
        clearTimeout(timer);
      }
      if (step.done) {
        drained = true;
        return;
      }
      yield step.value;
    }
  } finally {
    if (!drained) closeStream(stream, iterator);
  }
}
