import { existsSync, readFileSync } from 'node:fs';
import { writeTextFileAtomic } from './atomicWrite.js';
import { resolveMicaHomePath } from './brand.js';

export const MICA_STORAGE_PATH = resolveMicaHomePath('storage.json');

const MAX_INPUT_HISTORY_ITEMS = 200;

export interface MicaStorageFile {
  version: 1;
  inputHistory?: string[];
  preferences?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

export function readMicaStorage(): MicaStorageFile {
  if (!existsSync(MICA_STORAGE_PATH)) return { version: 1 };
  try {
    const parsed = JSON.parse(readFileSync(MICA_STORAGE_PATH, 'utf-8')) as unknown;
    if (!isMicaStorageFile(parsed)) throw new Error('invalid storage structure');
    return normalizeStorage({
      ...parsed,
      inputHistory: normalizeInputHistory(parsed.inputHistory ?? []),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read storage ${MICA_STORAGE_PATH}: ${detail}`);
  }
}

export function updateMicaStorage(updater: (storage: MicaStorageFile) => MicaStorageFile): MicaStorageFile {
  const next = normalizeStorage(updater(readMicaStorage()));
  writeMicaStorage(next);
  return next;
}

export function readInputHistory(): string[] {
  return readMicaStorage().inputHistory ?? [];
}

export function appendInputHistory(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return readInputHistory();

  const nextEntries = normalizeInputHistory([...readInputHistory(), trimmed]).slice(-MAX_INPUT_HISTORY_ITEMS);
  updateMicaStorage((storage) => ({
    ...storage,
    inputHistory: nextEntries,
  }));
  return nextEntries;
}

function writeMicaStorage(storage: MicaStorageFile): void {
  writeTextFileAtomic(MICA_STORAGE_PATH, `${JSON.stringify(storage, null, 2)}\n`);
}

function normalizeStorage(storage: MicaStorageFile): MicaStorageFile {
  return {
    version: 1,
    inputHistory: storage.inputHistory ? normalizeInputHistory(storage.inputHistory) : undefined,
    preferences: storage.preferences,
    usage: storage.usage,
  };
}

function normalizeInputHistory(entries: string[]): string[] {
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

function isMicaStorageFile(value: unknown): value is MicaStorageFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const storage = value as Partial<MicaStorageFile>;
  if (storage.version !== 1) return false;
  if (storage.inputHistory !== undefined && !isStringArray(storage.inputHistory)) return false;
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
