import { atom, onMount, type WritableAtom } from 'nanostores';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_PATH = resolve(homedir(), '.mica', 'config.json');

interface PersistedData {
  [key: string]: unknown;
}

function readConfigFile(): PersistedData {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch {
    // fall through
  }
  return {};
}

export function writeConfigEntriesSync(data: PersistedData): void {
  mkdirSync(resolve(homedir(), '.mica'), { recursive: true });
  const existing = readConfigFile();
  const merged = { ...existing, ...data };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
}

export function readConfig<T>(key: string, defaultValue: T): T {
  const data = readConfigFile();
  return key in data ? (data[key] as T) : defaultValue;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingData: PersistedData | null = null;

function scheduleSave() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    if (!pendingData) return;
    const data = pendingData;
    pendingData = null;
    try {
      await mkdir(resolve(homedir(), '.mica'), { recursive: true });
      const existing = readConfigFile();
      const merged = { ...existing, ...data };
      await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
    } catch {
      // silent
    }
  }, 500);
}

export function writeConfig(key: string, value: unknown): void {
  if (!pendingData) pendingData = {};
  pendingData[key] = value;
  scheduleSave();
}

export function createPersistedAtom<T>(key: string, defaultValue: T): WritableAtom<T> {
  const initialValue = readConfig(key, defaultValue);
  const store = atom<T>(initialValue);

  onMount(store, () => {
    return store.subscribe((value) => {
      writeConfig(key, value);
    });
  });

  return store;
}
