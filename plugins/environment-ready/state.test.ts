import { describe, expect, it } from 'vitest';
import { intervalMs, normalizeState, parseTarget, parseTargets } from './state.js';

const http = { id: 'web', label: 'Web', kind: 'http', url: 'http://localhost:3000/health' };

describe('environment target boundaries and saved state', () => {
  it('pins localhost, accepts numeric loopback v4/v6, strips fragments', () => {
    expect(parseTarget({ ...http, url: `${http.url}#section` })).toMatchObject({ url: 'http://127.0.0.1:3000/health' });
    expect(parseTarget({ ...http, url: 'https://[::1]:4000/ready' })).toMatchObject({
      url: 'https://[::1]:4000/ready',
    });
    expect(parseTarget({ id: 'db', label: 'DB', kind: 'tcp', host: 'LOCALHOST', port: 5432 })).toMatchObject({
      host: '127.0.0.1',
    });
    expect(parseTarget({ ...http, url: 'http://127.12.1.2/' })).toMatchObject({ url: 'http://127.12.1.2/' });
  });
  it.each([
    'https://example.com',
    'http://192.168.1.1',
    'http://0.0.0.0',
    'http://[::]',
    'http://localhost.evil.test',
    'http://[::ffff:127.0.0.1]',
    'file:///tmp/a',
    'http://user:pass@127.0.0.1',
    'http://@127.0.0.1',
  ])('rejects unsupported URL %s', (url) => {
    expect(() => parseTarget({ ...http, url })).toThrow();
  });
  it.each(['example.com', '192.168.0.1', '0.0.0.0', '::', 'localhost.', '127.0.0.1.evil', '::ffff:127.0.0.1'])(
    'rejects unsupported TCP host %s',
    (host) => {
      expect(() => parseTarget({ id: 'db', label: 'DB', kind: 'tcp', host, port: 5432 })).toThrow();
    },
  );
  it('validates labels, ports, uniqueness and the six-target task limit atomically', () => {
    expect(() => parseTarget({ ...http, label: 'a\nb' })).toThrow();
    expect(() => parseTarget({ ...http, id: '../web' })).toThrow();
    for (const port of [0, 65536, 1.2, '5432'])
      expect(() => parseTarget({ id: 'db', label: 'DB', kind: 'tcp', host: '::1', port })).toThrow();
    expect(() => parseTargets([http, http])).toThrow();
    expect(() => parseTargets(Array.from({ length: 7 }, (_, i) => ({ ...http, id: `service-${i}` })))).toThrow();
    expect(parseTargets([])).toEqual([]);
  });
  it('drops malformed or remote persisted rows and unbounded/invalid timestamps', () => {
    const state = normalizeState({
      version: 1,
      revision: '../../bad',
      targets: [null, http, http, { ...http, id: 'remote', url: 'http://external.test' }],
      statuses: { web: { checkedAt: NaN, reachable: true } },
    });
    expect(state.targets).toHaveLength(1);
    expect(state.statuses).toEqual({});
    expect(state.revision).toMatch(/^[a-f0-9]{24}$/);
    expect(normalizeState({ version: 9, targets: [http] }).targets).toEqual([]);
  });
  it('derives HTTP health from status codes and retains only declared status metadata', () => {
    const state = normalizeState({
      version: 1,
      revision: 'config-1',
      dismissedRevision: 'config-1',
      targets: [http],
      statuses: {
        web: {
          checkedAt: 10,
          reachable: true,
          healthy: true,
          statusCode: 503,
          error: 'secret raw exception',
          url: 'secret',
        },
      },
    });
    expect(state.statuses.web).toEqual({ checkedAt: 10, reachable: true, healthy: false, statusCode: 503 });
    expect(state.dismissedRevision).toBe('config-1');
    expect(normalizeState({ ...state, revision: 'config-2' }).dismissedRevision).toBeUndefined();
  });
  it('bounds string settings with a conservative default', () => {
    expect(intervalMs(undefined)).toBe(30_000);
    expect(intervalMs('invalid')).toBe(30_000);
    expect(intervalMs('')).toBe(30_000);
    expect(intervalMs('5')).toBe(10_000);
    expect(intervalMs('999')).toBe(300_000);
    expect(intervalMs('45')).toBe(45_000);
  });
});
