import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { deletePassword, readPassword, SECRETS_FILE, storePassword } from './Secrets.js';

const injected = vi.hoisted(() => ({ file: '', code: '' }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    if (injected.code && String(args[0]) === injected.file) throw Object.assign(new Error('PRIVATE-SECRET-CANARY'), { code: injected.code });
    return Reflect.apply(fs.readFileSync, fs, args);
  } };
});
let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mica-secret-store-')); file = join(dir, SECRETS_FILE); });
afterEach(() => { injected.code = ''; injected.file = ''; rmSync(dir, { recursive: true, force: true }); });

describe('SSH secret storage fail-closed mutations', () => {
  it.each(['{PRIVATE-SECRET-CANARY', 'null', '[]', '23', '{"prod":23}'])('preserves unsupported bytes %s', (raw) => {
    writeFileSync(file, raw);
    expect(() => readPassword('prod', dir)).toThrow(/口令文件/);
    expect(() => storePassword('prod', 'new', dir)).toThrow(/口令文件/);
    expect(() => deletePassword('prod', dir)).toThrow(/口令文件/);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });
  it.each(['EACCES', 'EIO'])('does not overwrite after %s or expose the read error content', (code) => {
    writeFileSync(file, '{"prod":"original"}');
    injected.file = file; injected.code = code;
    expect(() => storePassword('other', 'new', dir)).toThrow('读取 SSH 口令失败，原文件未更改');
    injected.code = '';
    expect(readFileSync(file, 'utf8')).toBe('{"prod":"original"}');
  });
  it('initializes only a missing file, serializes writers and preserves other hosts at 0600', () => {
    expect(readPassword('prod', dir)).toBeNull();
    storePassword('prod', 'one', dir);
    const release = acquireProcessLock(`${file}.lock`)!;
    try { expect(() => storePassword('test', 'two', dir)).toThrow('正在保存'); }
    finally { release(); }
    storePassword('test', 'two', dir);
    expect(readPassword('prod', dir)).toBe('one');
    expect(readPassword('test', dir)).toBe('two');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    deletePassword('test', dir);
    expect(readPassword('prod', dir)).toBe('one');
    expect(readPassword('test', dir)).toBeNull();
  });
});
