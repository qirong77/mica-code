import { useCallback, useEffect, useRef, useState } from 'react';
import { createAutoSaveQueue, type AutoSaveOptions, type AutoSaveStatus, type AutoSaveQueue } from './autoSaveQueue.js';

export type { AutoSaveStatus } from './autoSaveQueue.js';

export type AutoSave<T> = {
  status: AutoSaveStatus;
  /** 有请求在飞（列表里的删除/新建按钮据此置灰，编辑器本身不要禁用）。 */
  saving: boolean;
  error: string | null;
  schedule(value: T): void;
  /** 切条目、刷新、切页面之前调用：把路上那份写完再走。 */
  flush(): Promise<void>;
  cancel(): void;
  clearError(): void;
};

/**
 * 设置页共用的自动保存。
 *
 * 时序（防抖、串行、最后一次补发、失败不回滚）在 `autoSaveQueue.ts`，这里只把它接到 state。
 * 页面照旧渲染「保存中… / 已保存」，但不再有保存按钮。
 */
export function useAutoSave<T, R>(options: AutoSaveOptions<T, R>): AutoSave<T> {
  const [status, setStatus] = useState<AutoSaveStatus>(null);
  const [error, setError] = useState<string | null>(null);
  // 保存循环是异步的，回调里的闭包会拿到上一轮渲染的选中项与草稿，所以每次渲染同步一份。
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const queueRef = useRef<AutoSaveQueue<T> | null>(null);
  if (!queueRef.current) {
    queueRef.current = createAutoSaveQueue<T, R>(() => {
      const current = optionsRef.current;
      return {
        ...current,
        onSaved: (result, value) => {
          setError(null);
          current.onSaved?.(result, value);
        },
        onError: (message) => {
          setError(message);
          current.onError?.(message);
        },
        onStatusChange: (next) => setStatus(next),
      };
    });
  }

  useEffect(() => {
    const queue = queueRef.current;
    return () => queue?.dispose();
  }, []);

  const schedule = useCallback((value: T) => queueRef.current?.schedule(value), []);
  const flush = useCallback(() => queueRef.current?.flush() ?? Promise.resolve(), []);
  const cancel = useCallback(() => queueRef.current?.cancel(), []);
  const clearError = useCallback(() => setError(null), []);

  return { status, saving: status === 'saving', error, schedule, flush, cancel, clearError };
}
