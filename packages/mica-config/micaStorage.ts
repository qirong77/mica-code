import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export const MICA_STORAGE_PATH = resolveMicaHomePath('storage.json');

const MAX_INPUT_HISTORY_ITEMS = 200;

export interface ProviderPreference {
  model?: string;
  effort?: string;
}

export interface LastUsedConfig {
  provider?: string;
  model?: string;
  effort?: string;
  contextWindowSize?: number;
  providerPreferences?: Record<string, ProviderPreference>;
}

export interface MicaStorageFile {
  version: 1;
  lastUsed?: LastUsedConfig;
  inputHistory?: string[];
  preferences?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

export function readMicaStorage(): MicaStorageFile {
  if (!existsSync(MICA_STORAGE_PATH)) return { version: 1 };
  try {
    const parsed = JSON.parse(readFileSync(MICA_STORAGE_PATH, 'utf-8')) as unknown;
    if (!isMicaStorageFile(parsed)) return { version: 1 };
    return {
      ...parsed,
      inputHistory: normalizeInputHistory(parsed.inputHistory ?? []),
    };
  } catch {
    return { version: 1 };
  }
}

export function updateMicaStorage(updater: (storage: MicaStorageFile) => MicaStorageFile): MicaStorageFile {
  const next = normalizeStorage(updater(readMicaStorage()));
  writeMicaStorage(next);
  return next;
}

export function readLastUsedConfig(): LastUsedConfig {
  return readMicaStorage().lastUsed ?? {};
}

export function updateLastUsedConfig(update: LastUsedConfig): LastUsedConfig {
  const next = updateMicaStorage((storage) => ({
    ...storage,
    lastUsed: {
      ...(storage.lastUsed ?? {}),
      ...dropUndefined(update),
    },
  }));
  return next.lastUsed ?? {};
}

export function readProviderPreference(providerId: string): ProviderPreference {
  return readLastUsedConfig().providerPreferences?.[providerId] ?? {};
}

export function updateProviderPreference(
  providerId: string,
  preference: ProviderPreference,
): ProviderPreference {
  const next = updateMicaStorage((storage) => ({
    ...storage,
    lastUsed: {
      ...(storage.lastUsed ?? {}),
      providerPreferences: {
        ...(storage.lastUsed?.providerPreferences ?? {}),
        [providerId]: {
          ...(storage.lastUsed?.providerPreferences?.[providerId] ?? {}),
          ...dropUndefined(preference),
        },
      },
    },
  }));
  return next.lastUsed?.providerPreferences?.[providerId] ?? {};
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
  mkdirSync(dirname(MICA_STORAGE_PATH), { recursive: true });
  writeFileSync(MICA_STORAGE_PATH, `${JSON.stringify(storage, null, 2)}\n`, 'utf-8');
}

function normalizeStorage(storage: MicaStorageFile): MicaStorageFile {
  return {
    ...storage,
    version: 1,
    inputHistory: storage.inputHistory ? normalizeInputHistory(storage.inputHistory) : undefined,
  };
}

function normalizeInputHistory(entries: string[]): string[] {
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

function dropUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function isMicaStorageFile(value: unknown): value is MicaStorageFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const storage = value as Partial<MicaStorageFile>;
  if (storage.version !== 1) return false;
  if (storage.inputHistory !== undefined && !isStringArray(storage.inputHistory)) return false;
  if (storage.lastUsed !== undefined && !isLastUsedConfig(storage.lastUsed)) return false;
  return true;
}

function isLastUsedConfig(value: unknown): value is LastUsedConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const lastUsed = value as Partial<LastUsedConfig>;
  return (
    optionalString(lastUsed.provider) &&
    optionalString(lastUsed.model) &&
    optionalString(lastUsed.effort) &&
    optionalPositiveNumber(lastUsed.contextWindowSize) &&
    optionalProviderPreferences(lastUsed.providerPreferences)
  );
}

function optionalProviderPreferences(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isProviderPreference);
}

function isProviderPreference(value: unknown): value is ProviderPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pref = value as Partial<ProviderPreference>;
  return optionalString(pref.model) && optionalString(pref.effort);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalPositiveNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}

function resolveMicaHomePath(...parts: string[]): string {
  const micaHome = process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : resolve(homedir(), '.mica');
  return resolve(micaHome, ...parts);
}
