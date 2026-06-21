import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export const INPUT_HISTORY_PATH = resolve(homedir(), '.mica', 'input-history.json');

const MAX_INPUT_HISTORY_ITEMS = 200;

export interface InputHistoryFile {
  version: 1;
  entries: string[];
}

export function readInputHistory(): string[] {
  if (!existsSync(INPUT_HISTORY_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(INPUT_HISTORY_PATH, 'utf-8')) as unknown;
    if (!isInputHistoryFile(parsed)) return [];
    return normalizeEntries(parsed.entries);
  } catch {
    return [];
  }
}

export function appendInputHistory(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return readInputHistory();

  const entries = [...readInputHistory(), trimmed];
  const next = normalizeEntries(entries).slice(-MAX_INPUT_HISTORY_ITEMS);
  writeInputHistory(next);
  return next;
}

function writeInputHistory(entries: string[]): void {
  mkdirSync(dirname(INPUT_HISTORY_PATH), { recursive: true });
  const payload: InputHistoryFile = { version: 1, entries };
  writeFileSync(INPUT_HISTORY_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function normalizeEntries(entries: string[]): string[] {
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

function isInputHistoryFile(value: unknown): value is InputHistoryFile {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'version' in value &&
      (value as { version?: unknown }).version === 1 &&
      'entries' in value &&
      Array.isArray((value as { entries?: unknown }).entries) &&
      (value as { entries: unknown[] }).entries.every((entry) => typeof entry === 'string'),
  );
}
