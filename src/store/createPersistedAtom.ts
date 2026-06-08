import { atom, onMount, type WritableAtom } from 'nanostores';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_PATH = resolve(homedir(), '.mica', 'config.json');

interface PersistedData {
  [key: string]: unknown;
}

let loadedData: PersistedData | null = null;

function loadAllSync(): PersistedData {
  if (loadedData) return loadedData;
  try {
    if (existsSync(CONFIG_PATH)) {
      loadedData = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    } else {
      loadedData = {};
    }
  } catch {
    loadedData = {};
  }
  return loadedData!;
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
      const existing = loadAllSync();
      const merged = { ...existing, ...data };
      loadedData = merged;
      await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
    } catch {
      // silent
    }
  }, 500);
}

export function createPersistedAtom<T>(key: string, defaultValue: T): WritableAtom<T> {
  const data = loadAllSync();
  const initialValue = key in data ? (data[key] as T) : defaultValue;
  const store = atom<T>(initialValue);

  onMount(store, () => {
    return store.subscribe((value) => {
      if (!pendingData) pendingData = {};
      pendingData[key] = value;
      scheduleSave();
    });
  });

  return store;
}
