import { atom } from 'nanostores';

const MAX_SYSTEM_LOG_LINES = 64;

export const systemLogAtom = atom<string[]>([]);

export function appendSystemLog(message: string): void {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${time}] ${message}`;
  const lines = systemLogAtom.get();
  const next = [...lines, line];
  systemLogAtom.set(
    next.length > MAX_SYSTEM_LOG_LINES ? next.slice(-MAX_SYSTEM_LOG_LINES) : next,
  );
}

export function clearSystemLog(): void {
  systemLogAtom.set([]);
}

export interface SessionToolRecord {
  toolName: string;
  toolInput: Record<string, any>;
  elapsedMs: number;
}

export const sessionToolRecordsAtom = atom<SessionToolRecord[]>([]);

export function clearSessionToolRecords(): void {
  sessionToolRecordsAtom.set([]);
}
