import { useEffect, useRef, useState } from 'react';

interface Readable<T> {
  get(): T;
  subscribe(cb: (v: T) => void): () => void;
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const THROTTLE_INTERVAL = 16;
let lastFlushTime = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const pendingUpdaters: Record<string, Function> = {};

function flushAll() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  lastFlushTime = Date.now();
  Object.keys(pendingUpdaters).forEach((key) => {
    pendingUpdaters[key]();
  });
}

function scheduleFlush(immediate = false) {
  if (immediate) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushAll();
    return;
  }
  if (flushTimer) return; // 已有排期，等待统一刷新
  const elapsed = Date.now() - lastFlushTime;
  if (elapsed >= THROTTLE_INTERVAL) {
    flushAll();
  } else {
    flushTimer = setTimeout(flushAll, THROTTLE_INTERVAL - elapsed);
  }
}

export function useScheduleState<T>(atom: Readable<T>): T {
  const [state, setState] = useState<T>(atom.get());
  const snapRef = useRef(state);
  const stateUpdaterId = useRef(uuid());
  useEffect(() => {
    const id = stateUpdaterId.current;
            setState(snapRef.current);
    const unsub = atom.subscribe((newState) => {
      snapRef.current = newState;
      pendingUpdaters[id] = () => {
        setState(snapRef.current);
      };
      scheduleFlush();
    });
    return () => {
      unsub();
      delete pendingUpdaters[id];
    };
  }, []);

  return state;
}
