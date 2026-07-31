import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ptyServerSource } from '../src/ptyServerSource.js';

const serverFile = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

describe('ptyServerSource', () => {
  it('is in sync with src/server.mjs (the source of truth)', () => {
    const src = readFileSync(serverFile, 'utf8');
    expect(src).toBe(ptyServerSource);
  });
});
