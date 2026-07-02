import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const previousMicaHome = process.env.MICA_HOME;
const previousCwd = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'mica-storage-'));
let storageApi: typeof import('./micaStorage.js');

beforeAll(async () => {
  process.env.MICA_HOME = tempHome;
  vi.resetModules();
  storageApi = await import('./micaStorage.js');
});

afterAll(() => {
  process.chdir(previousCwd);
  if (previousMicaHome === undefined) {
    delete process.env.MICA_HOME;
  } else {
    process.env.MICA_HOME = previousMicaHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

describe('mica storage runtime config', () => {
  it('keeps runtime config scoped to exact cwd entries', () => {
    const projectA = join(tempHome, 'project-a');
    const projectB = join(tempHome, 'project-b');
    const projectC = join(tempHome, 'project-c');
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    mkdirSync(projectC, { recursive: true });

    process.chdir(projectA);
    storageApi.updateLastUsedConfig({ provider: 'a', model: 'b', effort: 'high' });
    storageApi.updateProviderPreference('a', { model: 'b', effort: 'high' });

    process.chdir(projectB);
    expect(storageApi.readLastUsedConfig()).toEqual({});
    expect(storageApi.readProviderPreference('a')).toEqual({});
    storageApi.updateLastUsedConfig({ provider: 'a', model: 'b', effort: 'low' });
    storageApi.updateProviderPreference('a', { model: 'b', effort: 'low' });

    process.chdir(projectA);
    expect(storageApi.readLastUsedConfig()).toMatchObject({ provider: 'a', model: 'b', effort: 'high' });
    expect(storageApi.readProviderPreference('a')).toEqual({ model: 'b', effort: 'high' });

    process.chdir(projectB);
    expect(storageApi.readLastUsedConfig()).toMatchObject({ provider: 'a', model: 'b', effort: 'low' });
    expect(storageApi.readProviderPreference('a')).toEqual({ model: 'b', effort: 'low' });

    process.chdir(projectC);
    expect(storageApi.readLastUsedConfig()).toEqual({});
    expect(storageApi.readProviderPreference('a')).toEqual({});

    const persisted = JSON.parse(readFileSync(storageApi.MICA_STORAGE_PATH, 'utf-8')) as {
      lastUsed?: Record<string, unknown>;
      lastUsedByDirectory?: Record<string, unknown>;
    };
    expect(persisted.lastUsed).toBeUndefined();
    expect(Object.keys(persisted.lastUsedByDirectory ?? {}).sort()).toEqual(
      [realpathSync(projectA), realpathSync(projectB)].sort(),
    );
  });
});
