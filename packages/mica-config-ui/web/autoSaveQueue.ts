/** 改动停下多久之后落盘：既不让每一击键都写文件，也不至于切页面时还在路上。 */
export const AUTO_SAVE_DEBOUNCE_MS = 400;
const SAVED_NOTICE_MS = 1600;

export type AutoSaveStatus = 'saving' | 'saved' | null;

export type AutoSaveOptions<T, R> = {
  save(value: T): Promise<R>;
  /** 保存成功、且请求期间没有新的改动时才调用：拿服务端结果刷新页面状态。 */
  onSaved?(result: R, value: T): void;
  onError?(message: string): void;
  onStatusChange?(status: AutoSaveStatus): void;
  debounceMs?: number;
  savedNoticeMs?: number;
};

export type AutoSaveQueue<T> = {
  /** 记下最新值并重新计时；连续输入只写最后一次。 */
  schedule(value: T): void;
  /** 立刻发出待保存内容，并等到所有写盘结束。 */
  flush(): Promise<void>;
  /** 丢掉还没发出的改动。 */
  cancel(): void;
  /** 组件卸载：清定时器，但把最后一批改动发出去。 */
  dispose(): void;
};

/**
 * 自动保存的时序核心（不依赖 React，便于单测）。
 *
 * 写盘串行化：同一时刻只有一个请求在飞，期间的改动攒成「最后一次」补发——直接丢弃会让
 * 界面上已是新值、磁盘上还是旧值。失败不回滚输入（用户正在改的东西不能被他看不懂的错误
 * 吞掉），只报错，下一次改动自然带着最新值重试。
 */
export function createAutoSaveQueue<T, R>(readOptions: () => AutoSaveOptions<T, R>): AutoSaveQueue<T> {
  let pending: { value: T } | null = null;
  let inFlight: Promise<void> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let status: AutoSaveStatus = null;
  let disposed = false;

  function emitStatus(next: AutoSaveStatus): void {
    status = next;
    if (disposed) return;
    readOptions().onStatusChange?.(next);
  }

  function clearDebounce(): void {
    if (debounceTimer === null) return;
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  function clearNotice(): void {
    if (noticeTimer === null) return;
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }

  function markSaved(): void {
    emitStatus('saved');
    clearNotice();
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      emitStatus(status === 'saved' ? null : status);
    }, readOptions().savedNoticeMs ?? SAVED_NOTICE_MS);
  }

  async function drain(): Promise<void> {
    clearNotice();
    emitStatus('saving');
    for (;;) {
      const next = pending;
      if (!next) return;
      pending = null;
      const options = readOptions();
      try {
        const result = await options.save(next.value);
        // 请求期间又改了：这次的响应已经过期，别拿它覆盖编辑器；循环接着写新值。
        if (pending) continue;
        options.onSaved?.(result, next.value);
        markSaved();
      } catch (error) {
        options.onError?.(formatError(error));
        return;
      }
    }
  }

  function startRun(): Promise<void> {
    if (inFlight) return inFlight;
    const task = drain().finally(() => {
      inFlight = null;
      if (status === 'saving') emitStatus(null);
    });
    inFlight = task;
    return task;
  }

  function schedule(value: T): void {
    pending = { value };
    clearDebounce();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void startRun();
    }, readOptions().debounceMs ?? AUTO_SAVE_DEBOUNCE_MS);
  }

  async function flush(): Promise<void> {
    clearDebounce();
    // 在飞的一轮会在自己的循环里消费 pending；它结束后若又冒出新值，再补一轮。
    for (let guard = 0; guard < 8; guard += 1) {
      if (inFlight) {
        await inFlight;
        continue;
      }
      if (!pending) return;
      await startRun();
    }
  }

  function cancel(): void {
    clearDebounce();
    pending = null;
    clearNotice();
    if (status === 'saved') emitStatus(null);
  }

  function dispose(): void {
    clearDebounce();
    clearNotice();
    const hasPending = pending !== null;
    disposed = true;
    if (hasPending) void startRun();
  }

  return { schedule, flush, cancel, dispose };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
