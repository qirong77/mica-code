import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeTextFileAtomic } from './atomicWrite.js';
import { resolveMicaHomePath } from './brand.js';

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
  providerPreferences?: Record<string, ProviderPreference>;
}

export interface MicaStorageFile {
  version: 1;
  lastUsedByDirectory?: Record<string, LastUsedConfig>;
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

export function readLastUsedConfig(directory = getCurrentDirectory()): LastUsedConfig {
  const storage = readMicaStorage();
  return readDirectoryLastUsedConfig(storage, directory) ?? {};
}

export function updateLastUsedConfig(update: LastUsedConfig, directory = getCurrentDirectory()): LastUsedConfig {
  const directoryPath = normalizeDirectoryPath(directory);
  const next = updateMicaStorage((storage) => ({
    ...storage,
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
    const nextPreference = {
      ...(currentLastUsed.providerPreferences?.[providerId] ?? {}),
      ...dropUndefined(preference),
    };
    return {
      ...storage,
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
  writeTextFileAtomic(MICA_STORAGE_PATH, `${JSON.stringify(storage, null, 2)}\n`);
}

function normalizeStorage(storage: MicaStorageFile): MicaStorageFile {
  return {
    version: 1,
    lastUsedByDirectory: storage.lastUsedByDirectory
      ? normalizeLastUsedByDirectory(storage.lastUsedByDirectory)
      : undefined,
    inputHistory: storage.inputHistory ? normalizeInputHistory(storage.inputHistory) : undefined,
    preferences: storage.preferences,
    usage: storage.usage,
  };
}

function normalizeLastUsedByDirectory(entries: Record<string, LastUsedConfig>): Record<string, LastUsedConfig> {
  return Object.fromEntries(
    Object.entries(entries).map(([directory, lastUsed]) => [
      normalizeDirectoryPath(directory),
      normalizeLastUsed(lastUsed),
    ]),
  );
}

function normalizeLastUsed(lastUsed: LastUsedConfig): LastUsedConfig {
  return dropUndefined({
    provider: lastUsed.provider,
    model: lastUsed.model,
    effort: lastUsed.effort,
    providerPreferences: lastUsed.providerPreferences
      ? normalizeProviderPreferences(lastUsed.providerPreferences)
      : undefined,
  });
}

function normalizeProviderPreferences(entries: Record<string, ProviderPreference>): Record<string, ProviderPreference> {
  return Object.fromEntries(
    Object.entries(entries).map(([providerId, preference]) => [
      providerId,
      dropUndefined({ model: preference.model, effort: preference.effort }),
    ]),
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
