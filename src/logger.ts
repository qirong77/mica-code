import { atom } from 'nanostores';

export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type RuntimeLogEntry = {
  id: number;
  at: number;
  level: RuntimeLogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
};

const MAX_LOG_ENTRIES = 500;

let nextLogId = 0;

export const runtimeLogs = atom<RuntimeLogEntry[]>([]);

export function logRuntime(
  scope: string,
  message: string,
  data?: Record<string, unknown>,
  level: RuntimeLogLevel = 'info',
) {
  const entry: RuntimeLogEntry = {
    id: ++nextLogId,
    at: Date.now(),
    level,
    scope,
    message,
    data,
  };
  const next = [...runtimeLogs.get(), entry];
  runtimeLogs.set(next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next);
}

export function clearRuntimeLogs() {
  runtimeLogs.set([]);
}

export function formatLogEntry(entry: RuntimeLogEntry) {
  const time = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false });
  const data = entry.data ? ` ${formatLogData(entry.data)}` : '';
  return `${time} ${entry.level.toUpperCase().padEnd(5)} ${entry.scope} ${entry.message}${data}`;
}

function formatLogData(data: Record<string, unknown>) {
  const pairs = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`);
  return pairs.length > 0 ? pairs.join(' ') : '';
}

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(truncate(value, 120));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return String(value);
  try {
    return truncate(JSON.stringify(value), 160);
  } catch {
    return truncate(String(value), 160);
  }
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
