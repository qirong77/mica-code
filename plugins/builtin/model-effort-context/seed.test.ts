import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { modelsDevSeedBase64 } from './seed/models-dev.seed.js';

type SeedEntry = {
  version: number;
  fetchedAt: number;
  payload: Record<string, { models: Record<string, unknown> }>;
};

function decodeSeed(): SeedEntry {
  const entry = JSON.parse(gunzipSync(Buffer.from(modelsDevSeedBase64, 'base64')).toString('utf8')) as SeedEntry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('seed must be an object');
  return entry;
}

describe('models.dev bundled seed', () => {
  it('decodes to a valid cache entry (gzip -> base64 -> JSON)', () => {
    const entry = decodeSeed();
    expect(entry.version).toBe(1);
    expect(Number.isFinite(entry.fetchedAt)).toBe(true);
    expect(entry.fetchedAt).toBeGreaterThan(0);
    expect(Object.keys(entry.payload).length).toBeGreaterThan(0);
  });

  it('contains known provider/model metadata', () => {
    const entry = decodeSeed();
    const matches: string[] = [];
    for (const provider of Object.values(entry.payload)) {
      for (const key of Object.keys(provider?.models ?? {})) {
        if (key.includes('deepseek-v4-flash')) matches.push(key);
      }
    }
    expect(matches.length).toBeGreaterThan(0);
  });
});
