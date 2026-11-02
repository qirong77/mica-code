import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const previousMicaHome = process.env.MICA_HOME;
const tempHome = mkdtempSync(join(tmpdir(), 'mica-storage-'));
let storageApi: typeof import('./micaStorage.js');

beforeAll(async () => {
  process.env.MICA_HOME = tempHome;
  vi.resetModules();
  storageApi = await import('./micaStorage.js');
});

afterAll(() => {
  if (previousMicaHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = previousMicaHome;
  rmSync(tempHome, { recursive: true, force: true });
});

describe('mica storage', () => {
  it('preserves input history, preferences and usage when saving', () => {
    storageApi.updateMicaStorage(() => ({
      version: 1,
      preferences: { theme: 'dark' },
      usage: { tokens: 42 },
    }));
    storageApi.appendInputHistory(' first ');
    storageApi.appendInputHistory('second');
    expect(storageApi.readMicaStorage()).toEqual({
      version: 1,
      inputHistory: ['first', 'second'],
      preferences: { theme: 'dark' },
      usage: { tokens: 42 },
    });
  });

  it('does not replace invalid storage during a later update', () => {
    const invalidStorage = '{"version": 1, "inputHistory": [';
    writeFileSync(storageApi.MICA_STORAGE_PATH, invalidStorage, 'utf-8');

    expect(() => storageApi.appendInputHistory('new input')).toThrow('Failed to read storage');
    expect(readFileSync(storageApi.MICA_STORAGE_PATH, 'utf-8')).toBe(invalidStorage);
  });
});
