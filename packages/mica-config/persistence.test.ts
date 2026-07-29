import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPersistedConfig } from './persistence.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('config persistence', () => {
  it('does not replace an invalid existing config with defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-persistence-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'config.json');
    const invalidConfig = '{"providers": [';
    writeFileSync(configPath, invalidConfig, 'utf-8');

    expect(() => readPersistedConfig(configPath)).toThrow(`Failed to read config ${configPath}`);
    expect(readFileSync(configPath, 'utf-8')).toBe(invalidConfig);
  });
});
