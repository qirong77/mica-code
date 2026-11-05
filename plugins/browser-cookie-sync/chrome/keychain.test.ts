import { describe, expect, it } from 'vitest';
import { KeychainDenied, readSafeStorageSecret, resetSafeStorageCache, type SecurityRunner } from './keychain.js';

const ok = (stdout: string): SecurityRunner => () => ({ status: 0, stdout, stderr: '' });

describe('readSafeStorageSecret', () => {
  it('asks security for the service + account the browser declares', () => {
    resetSafeStorageCache();
    const calls: string[][] = [];
    const result = readSafeStorageSecret(
      { service: 'Chrome Safe Storage', account: 'Chrome' },
      {
        run: (args) => {
          calls.push(args);
          return { status: 0, stdout: 'secret-value\n', stderr: '' };
        }
      }
    );
    expect(result).toEqual({ secret: 'secret-value', cached: false });
    expect(calls[0]).toEqual([
      'find-generic-password',
      '-w',
      '-s',
      'Chrome Safe Storage',
      '-a',
      'Chrome'
    ]);
  });

  it('caches the secret so a second sync does not re-prompt', () => {
    resetSafeStorageCache();
    const run = ok('cached-secret\n');
    expect(readSafeStorageSecret({ service: 'S', account: 'A' }, { run }).secret).toBe('cached-secret');
    expect(readSafeStorageSecret({ service: 'S', account: 'A' }, { run }).cached).toBe(true);
  });

  it('reports a missing keychain item as a plain error with the service name', () => {
    resetSafeStorageCache();
    expect(() =>
      readSafeStorageSecret(
        { service: 'Chrome Safe Storage', account: 'Chrome' },
        { run: () => ({ status: 44, stdout: '', stderr: 'security: The specified item could not be found in the keychain.' }) }
      )
    ).toThrow(/钥匙串里没有 Chrome Safe Storage/);
  });

  it('treats a denial as actionable and refuses to re-prompt for a while', () => {
    resetSafeStorageCache();
    let calls = 0;
    const denied: SecurityRunner = () => {
      calls += 1;
      return { status: 1, stdout: '', stderr: 'User interaction is not allowed.' };
    };
    expect(() => readSafeStorageSecret({ service: 'S', account: 'A' }, { run: denied })).toThrow(
      KeychainDenied
    );
    expect(() => readSafeStorageSecret({ service: 'S', account: 'A' }, { run: denied })).toThrow(
      KeychainDenied
    );
    expect(calls).toBe(1);

    // 过了冷却时间再试一次，用户可能已经在钥匙串里点了「始终允许」
    expect(() =>
      readSafeStorageSecret({ service: 'S', account: 'A' }, { run: denied, now: () => Date.now() + 120_000 })
    ).toThrow(KeychainDenied);
    expect(calls).toBe(2);
  });
});
