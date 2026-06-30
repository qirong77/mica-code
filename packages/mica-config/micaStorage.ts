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
  /** Global fallback runtime selection for directories without an exact entry. */
  lastUsed?: LastUsedConfig;
  lastUsedByDirectory?: Record<string, LastUsedConfig>;
  inputHistory?: string[];
  preferences?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

export function readMicaStorage(): MicaStorageFile {
  if (!existsSync(MICA_STORAGE_PATH)) return { version: 1 };
  try {
    const parsed = JSON.parse(readFileSync(MICA_STORAGE_PATH, 'utf-8')) as unknown;
    if (!isMicaStorageFile(parsed)) return { version: 1 };
    return normalizeStorage({
      ...parsed,
      inputHistory: normalizeInputHistory(parsed.inputHistory ?? []),
    });
  } catch {
    return { version: 1 };
  }
}

export function updateMicaStorage(updater: (storage: MicaStorageFile) => MicaStorageFile): MicaStorageFile {
  const next = normalizeStorage(updater(readMicaStorage()));
  writeMicaStorage(next);
  return next;
}

export function readLastUsedConfig(directory = getCurrentDirectory()): LastUsedConfig {
  const storage = readMicaStorage();
  return readDirectoryLastUsedConfig(storage, directory) ?? storage.lastUsed ?? {};
}

export function updateLastUsedConfig(update: LastUsedConfig, directory = getCurrentDirectory()): LastUsedConfig {
  const directoryPath = normalizeDirectoryPath(directory);
  const next = updateMicaStorage((storage) => ({
    ...storage,
    lastUsed: {
      ...(storage.lastUsed ?? {}),
      ...dropUndefined(update),
    },
    lastUsedByDirectory: {
      ...(storage.lastUsedByDirectory ?? {}),
      [directoryPath]: {
        ...readLastUsedConfigForStorage(storage, directoryPath),
        ...dropUndefined(update),
      },
    },
  }));
  return next.lastUsedByDirectory?.[directoryPath] ?? {};
}

export function readProviderPreference(providerId: string, directory = getCurrentDirectory()): ProviderPreference {
  return readLastUsedConfig(directory).providerPreferences?.[providerId] ?? {};
}

export function updateProviderPreference(
  providerId: string,
  preference: ProviderPreference,
  directory = getCurrentDirectory(),
): ProviderPreference {
  const directoryPath = normalizeDirectoryPath(directory);
  const next = updateMicaStorage((storage) => {
    const currentLastUsed = readLastUsedConfigForStorage(storage, directoryPath);
    const currentGlobalLastUsed = storage.lastUsed ?? {};
    const nextPreference = {
      ...(currentLastUsed.providerPreferences?.[providerId] ?? {}),
      ...dropUndefined(preference),
    };
    return {
      ...storage,
      lastUsed: {
        ...currentGlobalLastUsed,
        providerPreferences: {
          ...(currentGlobalLastUsed.providerPreferences ?? {}),
          [providerId]: {
            ...(currentGlobalLastUsed.providerPreferences?.[providerId] ?? {}),
            ...dropUndefined(preference),
          },
        },
      },
      lastUsedByDirectory: {
        ...(storage.lastUsedByDirectory ?? {}),
        [directoryPath]: {
          ...currentLastUsed,
          providerPreferences: {
            ...(currentLastUsed.providerPreferences ?? {}),
            [providerId]: nextPreference,
          },
        },
      },
    };
  });
  return next.lastUsedByDirectory?.[directoryPath]?.providerPreferences?.[providerId] ?? {};
}

export function getCurrentDirectory(): string {
  return normalizeDirectoryPath(process.cwd());
}

function readLastUsedConfigForStorage(storage: MicaStorageFile, directory: string): LastUsedConfig {
  return readDirectoryLastUsedConfig(storage, directory) ?? {};
}

function readDirectoryLastUsedConfig(storage: MicaStorageFile, directory: string): LastUsedConfig | undefined {
  return storage.lastUsedByDirectory?.[normalizeDirectoryPath(directory)];
}

function normalizeDirectoryPath(directory: string): string {
  return resolve(directory);
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
    lastUsedByDirectory: storage.lastUsedByDirectory
      ? normalizeLastUsedByDirectory(storage.lastUsedByDirectory)
      : undefined,
    inputHistory: storage.inputHistory ? normalizeInputHistory(storage.inputHistory) : undefined,
  };
}

function normalizeLastUsedByDirectory(entries: Record<string, LastUsedConfig>): Record<string, LastUsedConfig> {
  return Object.fromEntries(
    Object.entries(entries).map(([directory, lastUsed]) => [normalizeDirectoryPath(directory), lastUsed]),
  );
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
  if (storage.lastUsedByDirectory !== undefined && !isLastUsedByDirectory(storage.lastUsedByDirectory)) return false;
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

function isLastUsedByDirectory(value: unknown): value is Record<string, LastUsedConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([directory, lastUsed]) => typeof directory === 'string' && isLastUsedConfig(lastUsed),
  );
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
