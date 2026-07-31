import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { SyncEvent } from './api';

const API_BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');
const INITIAL_RETRY_MS = 2000;
const MAX_RETRY_MS = 30_000;

/**
 * SSE client over fetch streams. Reconnects with the last seen sequence number
 * so no event is lost across transient network failures.
 *
 * State:
 * - `connected`: an SSE stream is currently open and has been established.
 * - `connecting`: an attempt is in flight (initial connect or reconnect).
 * The UI shows "connecting" instead of a scary "disconnected" while the very
 * first stream for a session is being established.
 */
export function useSse(
  machineId: string | null,
  sessionId: string | null,
  onEvent: (event: SyncEvent, machineId: string, sessionId: string) => void,
  enabled = true,
  initialSinceRef?: MutableRefObject<number>,
): { connected: boolean; connecting: boolean } {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const onEventRef = useRef(onEvent);
  const subscriptionRef = useRef(0);
  // Last seen seq survives effect restarts so a restart never replays events
  // the stream has already delivered (replaying text_delta duplicates text).
  const lastSeqRef = useRef<{ key: string; seq: number }>({ key: '', seq: 0 });
  onEventRef.current = onEvent;

  useEffect(() => {
    const subscription = ++subscriptionRef.current;
    if (!machineId || !sessionId || !enabled) {
      setConnected(false);
      setConnecting(false);
      return;
    }

    const key = `${machineId}/${sessionId}`;
    // New conversation: start from the watermark of the latest session
    // snapshot (list or detail fetch). Same conversation restarted (detail
    // refresh): keep the max of seen seq and the watermark, never replay.
    if (lastSeqRef.current.key !== key) {
      lastSeqRef.current = { key, seq: initialSinceRef?.current ?? 0 };
    }
    let lastSeq = Math.max(lastSeqRef.current.seq, initialSinceRef?.current ?? 0);

    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = INITIAL_RETRY_MS;
    let controller: AbortController | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const isActive = () => !stopped && subscriptionRef.current === subscription;

    // A restart (e.g. detail arrived with a newer watermark) must not flip the
    // connection badge to "disconnected"; only a real failure does that.
    setConnecting(true);

    const connect = async () => {
      if (!isActive()) return;
      const attemptController = new AbortController();
      controller = attemptController;
      try {
        const params = new URLSearchParams({ since: String(lastSeq) });
        const response = await fetch(
          `${API_BASE}/api/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionId)}/events?${params}`,
          { signal: attemptController.signal },
        );
        if (!response.ok || !response.body) {
          throw new Error(`SSE HTTP ${response.status}`);
        }
        if (!isActive()) {
          await response.body.cancel();
          return;
        }
        setConnected(true);
        setConnecting(false);
        retryDelay = INITIAL_RETRY_MS;
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (isActive()) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!isActive()) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data:'));
            if (line) {
              try {
                const event = JSON.parse(line.slice(5).trim()) as SyncEvent;
                const seq = Number(event.seq);
                if (Number.isSafeInteger(seq) && seq > lastSeq && isActive()) {
                  lastSeq = seq;
                  lastSeqRef.current.seq = seq;
                  onEventRef.current(event, machineId, sessionId);
                }
              } catch {
                // Ignore malformed frames.
              }
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // Fall through to reconnect.
      }
      if (!isActive()) return;
      setConnected(false);
      setConnecting(true);
      retryTimer = setTimeout(() => void connect(), retryDelay);
      retryDelay = Math.min(Math.round(retryDelay * 1.5), MAX_RETRY_MS);
    };

    void connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
      void reader?.cancel().catch(() => undefined);
    };
    // Restart when the snapshot watermark moves (detail fetched after switch).
  }, [machineId, sessionId, enabled, initialSinceRef?.current ?? 0]);

  return { connected, connecting };
}
