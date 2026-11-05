import { describe, expect, it } from 'vitest';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import {
  SAFE_STORAGE_ITERATIONS,
  SAFE_STORAGE_SALT,
  chromeTimeToUnixSeconds,
  decryptCookieValue,
  deriveSafeStorageKey,
  encryptCookieValue,
  hostHash,
  unixSecondsToChromeTime
} from './cookieCodec.js';

const KEY = deriveSafeStorageKey('test-safe-storage-secret');
const HOST = '.example.com';

/** 按 Chrome 的写法加密，但明文不带 host 前缀（老库的形态）。 */
function encryptWithoutHostHash(value: string): Buffer {
  const cipher = createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10', 'latin1'), cipher.update(value, 'utf8'), cipher.final()]);
}

describe('safe storage key derivation', () => {
  it('matches the documented PBKDF2 parameters', () => {
    expect(SAFE_STORAGE_SALT).toBe('saltysalt');
    expect(SAFE_STORAGE_ITERATIONS).toBe(1003);
    expect(KEY).toHaveLength(16);
    expect(pbkdf2Sync('test-safe-storage-secret', 'saltysalt', 1003, 16, 'sha1').equals(KEY)).toBe(true);
  });

  it('gives a different key for a different password', () => {
    expect(deriveSafeStorageKey('another').equals(KEY)).toBe(false);
  });
});

describe('cookie value encryption', () => {
  it('round-trips a value through Chrome’s v10 form', () => {
    const encrypted = encryptCookieValue('plain-value-中文', HOST, KEY);
    expect(encrypted.subarray(0, 3).toString('latin1')).toBe('v10');
    expect(decryptCookieValue(encrypted, HOST, KEY)).toBe('plain-value-中文');
  });

  it('strips the host hash only when it is really there', () => {
    // 同一条 cookie 用别的 host 解密：前缀对不上，整段都当值
    expect(decryptCookieValue(encryptCookieValue('v', HOST, KEY), '.other.com', KEY)).not.toBe('v');
    expect(decryptCookieValue(encryptWithoutHostHash('legacy'), HOST, KEY)).toBe('legacy');
  });

  it('returns null for anything it cannot read instead of throwing', () => {
    expect(decryptCookieValue(Buffer.alloc(0), HOST, KEY)).toBeNull();
    expect(decryptCookieValue(Buffer.from('v10', 'latin1'), HOST, KEY)).toBeNull();
    expect(decryptCookieValue(Buffer.concat([Buffer.from('v12', 'latin1'), Buffer.alloc(16)]), HOST, KEY)).toBeNull();
    expect(decryptCookieValue(Buffer.concat([Buffer.from('v10', 'latin1'), Buffer.alloc(15)]), HOST, KEY)).toBeNull();
  });

  it('hashes the host key the same way Chrome does', () => {
    expect(hostHash(HOST)).toHaveLength(32);
    expect(hostHash(HOST).equals(hostHash('.EXAMPLE.com'))).toBe(false);
  });
});

describe('chrome time', () => {
  it('converts between Chrome microseconds and unix seconds', () => {
    const unix = 1_767_225_600;
    expect(chromeTimeToUnixSeconds(unixSecondsToChromeTime(unix))).toBe(unix);
  });

  it('treats zero as “no expiry” rather than 1601', () => {
    expect(chromeTimeToUnixSeconds(0)).toBeNull();
    expect(chromeTimeToUnixSeconds(undefined)).toBeNull();
    expect(chromeTimeToUnixSeconds(-5)).toBeNull();
  });
});
