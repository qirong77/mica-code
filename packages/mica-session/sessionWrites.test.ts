import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSessionWrites, recordSessionWrite, sessionWritesPath } from './sessionWrites.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mica-writes-'));
  dirs.push(dir);
  mkdirSync(resolve(dir, '.turn-locks'), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session write ledger', () => {
  it('records absolute paths per session and reads them back in order', () => {
    const sessionDir = tempDir();
    recordSessionWrite('sess-a', ['/repo/a.ts', '/repo/b.ts'], { sessionDir });
    recordSessionWrite('sess-a', ['/repo/a.ts'], { sessionDir });

    const records = readSessionWrites('sess-a', { sessionDir });
    expect(records.map((record) => record.path)).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/a.ts']);
    // Different session is a different ledger: attribution must never leak across them.
    expect(readSessionWrites('sess-b', { sessionDir })).toEqual([]);
  });

  it('keeps path order but drops duplicates inside one call', () => {
    const sessionDir = tempDir();
    recordSessionWrite('sess-a', ['/repo/a.ts', '/repo/a.ts', ''], { sessionDir });
    expect(readSessionWrites('sess-a', { sessionDir }).map((record) => record.path)).toEqual(['/repo/a.ts']);
  });

  it('filters by time so a peer turn only sees what it wrote after it started', () => {
    const sessionDir = tempDir();
    recordSessionWrite('sess-a', ['/repo/old.ts'], { sessionDir, at: new Date('2026-11-05T01:00:00Z') });
    recordSessionWrite('sess-a', ['/repo/new.ts'], { sessionDir, at: new Date('2026-11-05T03:00:00Z') });

    const recent = readSessionWrites('sess-a', { sessionDir, since: new Date('2026-11-05T02:00:00Z') });
    expect(recent.map((record) => record.path)).toEqual(['/repo/new.ts']);
  });

  it('keeps only the newest entries when a limit is given', () => {
    const sessionDir = tempDir();
    for (const name of ['a', 'b', 'c']) recordSessionWrite('sess-a', [`/repo/${name}.ts`], { sessionDir });
    expect(readSessionWrites('sess-a', { sessionDir, limit: 2 }).map((record) => record.path)).toEqual([
      '/repo/b.ts',
      '/repo/c.ts',
    ]);
  });

  it('skips a half-written trailing line instead of losing the whole ledger', () => {
    const sessionDir = tempDir();
    recordSessionWrite('sess-a', ['/repo/a.ts'], { sessionDir });
    const path = sessionWritesPath('sess-a', sessionDir);
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"path":"/repo/half`, 'utf8');

    expect(readSessionWrites('sess-a', { sessionDir }).map((record) => record.path)).toEqual(['/repo/a.ts']);
  });

  it('never throws when the ledger cannot be written', () => {
    const sessionDir = resolve(tempDir(), 'read-only-file');
    writeFileSync(sessionDir, 'not a directory', 'utf8');
    expect(() => recordSessionWrite('sess-a', ['/repo/a.ts'], { sessionDir })).not.toThrow();
    expect(readSessionWrites('sess-a', { sessionDir })).toEqual([]);
  });
});
