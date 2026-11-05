import { describe, expect, it } from 'vitest';
import {
  cookieFingerprint,
  cookieKey,
  fromMicaCookie,
  hostMatches,
  normalizeHost,
  sameSiteFromChrome,
  sameSiteToChrome,
  toMicaPayload,
  type SyncCookie
} from './cookies.js';

const cookie = (patch: Partial<SyncCookie> = {}): SyncCookie => ({
  host: 'example.com',
  hostOnly: true,
  name: 'sid',
  path: '/',
  value: 'v1',
  expiresAt: 1_767_225_600,
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  ...patch
});

describe('cookie identity', () => {
  it('keys a cookie by host + path + name, which is Chrome’s own unique index', () => {
    expect(cookieKey({ host: 'example.com', name: 'sid' })).toBe('example.com\u0000/\u0000sid');
    expect(cookieKey(cookie({ path: '/admin' }))).not.toBe(cookieKey(cookie()));
  });

  it('normalizes the leading dot and case of a domain', () => {
    expect(normalizeHost('.Example.COM')).toBe('example.com');
    expect(normalizeHost('example.com.')).toBe('example.com.');
    expect(normalizeHost('')).toBe('');
  });

  it('matches subdomains only when the scope is a real parent', () => {
    expect(hostMatches('a.example.com', 'example.com')).toBe(true);
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    expect(hostMatches('notexample.com', 'example.com')).toBe(false);
    expect(hostMatches('anything.test', '')).toBe(true);
  });
});

describe('content fingerprint', () => {
  it('ignores nothing that matters and stays stable across reads', () => {
    expect(cookieFingerprint(cookie())).toBe(cookieFingerprint({ ...cookie() }));
    expect(cookieFingerprint(cookie({ value: 'v2' }))).not.toBe(cookieFingerprint(cookie()));
    expect(cookieFingerprint(cookie({ expiresAt: null }))).not.toBe(cookieFingerprint(cookie()));
    expect(cookieFingerprint(cookie({ httpOnly: false }))).not.toBe(cookieFingerprint(cookie()));
    expect(cookieFingerprint(cookie({ sameSite: 'strict' }))).not.toBe(cookieFingerprint(cookie()));
    expect(cookieFingerprint(cookie({ hostOnly: false }))).not.toBe(cookieFingerprint(cookie()));
  });

  it('rounds the expiry so a fractional second does not look like a change', () => {
    expect(cookieFingerprint(cookie({ expiresAt: 1_767_225_600.4 }))).toBe(
      cookieFingerprint(cookie({ expiresAt: 1_767_225_600 }))
    );
  });
});

describe('side mappings', () => {
  it('maps Chrome samesite integers both ways', () => {
    expect(sameSiteFromChrome(-1)).toBe('unspecified');
    expect(sameSiteFromChrome(0)).toBe('no_restriction');
    expect(sameSiteFromChrome(1)).toBe('lax');
    expect(sameSiteFromChrome(2)).toBe('strict');
    expect(sameSiteFromChrome(undefined)).toBe('unspecified');
    expect(sameSiteToChrome('strict')).toBe(2);
    expect(sameSiteToChrome('unspecified')).toBe(-1);
  });

  it('reads the controlled browser’s cookie, keeping host-only vs domain cookies apart', () => {
    const hostOnly = fromMicaCookie({
      name: 'sid',
      value: 'v',
      domain: 'example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      hostOnly: true,
      expirationDate: 1767225600
    });
    expect(hostOnly).toMatchObject({ host: 'example.com', hostOnly: true, expiresAt: 1767225600 });

    const domain = fromMicaCookie({ name: 'sid', value: 'v', domain: '.example.com', path: '/' });
    expect(domain).toMatchObject({ host: 'example.com', hostOnly: false });

    expect(fromMicaCookie({ name: 'sid', value: 'v', domain: 'example.com', session: true })).toMatchObject({
      expiresAt: null
    });
    expect(fromMicaCookie({ value: 'v', domain: 'example.com' })).toBeNull();
  });

  it('writes the leading dot back for domain cookies and omits the expiry for session cookies', () => {
    expect(toMicaPayload(cookie({ hostOnly: false }))).toMatchObject({ domain: '.example.com' });
    expect(toMicaPayload(cookie({ hostOnly: true }))).toMatchObject({ domain: 'example.com' });
    expect(toMicaPayload(cookie({ expiresAt: null }))).not.toHaveProperty('expirationDate');
    expect(toMicaPayload(cookie())).toMatchObject({ expirationDate: 1767225600 });
  });
});
