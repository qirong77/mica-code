import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaysResponse, Overview, Range } from '../shared/types';

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}），请检查采集服务后重试。`);
  return response.json() as Promise<T>;
}

export function useJsonResource<T>(url: string | null) {
  const [state, setState] = useState<{ url: string; data: T } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!url) {
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    getJson<T>(url, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ url, data });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '数据加载失败，请重试。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [url, revision]);
  return { data: state?.url === url ? state.data : null, loading, error, retry };
}

export function useMonitor() {
  const days = useJsonResource<DaysResponse>('/api/days');
  const [day, setDay] = useState('');
  const [range, setRange] = useState<Range>('24h');
  const [automatic, setAutomatic] = useState(true);
  const automaticRef = useRef(automatic);
  automaticRef.current = automatic;
  const [visible, setVisible] = useState(!document.hidden);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; data: Overview; receivedAt: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeDay = day || days.data?.latestDay || days.data?.days[0] || '';
  const key = `${activeDay}:${range}`;
  const refresh = useCallback(() => {
    days.retry();
    setRevision((value) => value + 1);
  }, [days.retry]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (automaticRef.current && !document.hidden) days.retry();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [days.retry]);

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (!activeDay) return;
    let disposed = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      setLoading(true);
      setError(null);
      try {
        const data = await getJson<Overview>(
          `/api/overview?day=${encodeURIComponent(activeDay)}&range=${range}`,
          controller.signal,
        );
        if (!disposed) setState({ key, data, receivedAt: Date.now() });
      } catch (cause) {
        if (!disposed && !controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '监控数据加载失败，请重试。');
      } finally {
        if (!disposed) {
          inFlight = false;
          setLoading(false);
        }
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (automaticRef.current && !document.hidden) void load();
    }, 15_000);
    const onVisibility = () => {
      if (automaticRef.current && !document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activeDay, range, revision, key]);

  return {
    days,
    day: activeDay,
    setDay,
    range,
    setRange,
    automatic,
    setAutomatic,
    visible,
    data: state?.key === key ? state.data : null,
    receivedAt: state?.key === key ? state.receivedAt : null,
    loading,
    error,
    refresh,
  };
}
