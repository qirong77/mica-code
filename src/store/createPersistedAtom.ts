import { atom, onMount, type WritableAtom } from 'nanostores';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_PATH = resolve(homedir(), '.mica', 'config.json');

interface PersistedData {
  [key: string]: unknown;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingData: PersistedData | null = null;
let loadedData: PersistedData | null = null;

async function loadAll(): Promise<PersistedData> {
  if (loadedData) return loadedData;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    loadedData = JSON.parse(raw);
  } catch {
    loadedData = {};
  }
  return loadedData!;
}

function scheduleSave() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    if (!pendingData) return;
    const data = pendingData;
    pendingData = null;
    try {
      await mkdir(resolve(homedir(), '.mica'), { recursive: true });
      const existing = await loadAll();
      const merged = { ...existing, ...data };
      loadedData = merged;
      await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
    } catch {
      // silent
    }
  }, 500);
}

export function createPersistedAtom<T>(key: string, defaultValue: T): WritableAtom<T> {
  const store = atom<T>(defaultValue);

  onMount(store, () => {
    loadAll().then((data) => {
      if (key in data) {
        store.set(data[key] as T);
      }
    });

    return store.subscribe((value) => {
      if (!pendingData) pendingData = {};
      pendingData[key] = value;
      scheduleSave();
    });
  });

  return store;
}
