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
const SCOPE_WIDTH = 13;
const MESSAGE_WIDTH = 16;

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
  const level = entry.level.toUpperCase().padEnd(5);
  const scope = padColumn(entry.scope, SCOPE_WIDTH);
  const message = padColumn(entry.message, MESSAGE_WIDTH);
  const data = entry.data ? ` ${formatLogData(entry.data)}` : '';
  return `${time} ${level} ${scope} ${message}${data}`.trimEnd();
}

function formatLogData(data: Record<string, unknown>) {
  const pairs = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatLogValue(key, value)}`);
  return pairs.length > 0 ? pairs.join(' ') : '';
}

function formatLogValue(key: string, value: unknown): string {
  if (typeof value === 'number') return formatNumberValue(key, value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return formatStringValue(key, value);
  if (value == null) return String(value);
  try {
    return truncate(JSON.stringify(value), 160);
  } catch {
    return truncate(String(value), 160);
  }
}

function formatNumberValue(key: string, value: number) {
  if (key.endsWith('Rate')) return `${formatFixed(value * 100, 2)}%`;
  if (key.endsWith('Ms')) return `${formatFixed(value, 0)}ms`;
  return Number.isInteger(value) ? String(value) : formatFixed(value, 4);
}

function formatStringValue(key: string, value: string) {
  const formatted = looksLikeIdKey(key) ? compactId(value) : truncate(value, 120);
  if (/^[\w./:@-]+$/.test(formatted)) return formatted;
  return JSON.stringify(formatted);
}

function padColumn(value: string, width: number) {
  return value.length >= width ? value : value.padEnd(width);
}

function looksLikeIdKey(key: string) {
  return key === 'id' || key.endsWith('Id') || key.endsWith('ID');
}

function compactId(value: string) {
  if (value.length <= 24) return value;
  return `${value.slice(0, 10)}...${value.slice(-7)}`;
}

function formatFixed(value: number, digits: number) {
  return value.toFixed(digits).replace(/\.0+$|(?<=\.\d*[1-9])0+$/u, '');
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
