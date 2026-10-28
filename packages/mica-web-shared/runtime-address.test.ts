import { describe, expect, it } from 'vitest';
import { isLoopbackRuntime, isSameRuntime, normalizeRuntimeAddress, runtimeLabel } from './runtime-address.js';

describe('normalizeRuntimeAddress', () => {
  it('fills in the runtime port when the user only types a host', () => {
    expect(normalizeRuntimeAddress('192.168.1.5')).toBe('http://192.168.1.5:8787');
    expect(normalizeRuntimeAddress('mica.local:9000')).toBe('http://mica.local:9000');
  });

  it('keeps an explicit port, protocol and drops path, query and hash', () => {
    expect(normalizeRuntimeAddress('https://example.com:443/share?x=1#top')).toBe('https://example.com:443');
    expect(normalizeRuntimeAddress('  http://10.0.0.2:8787/mica-web  ')).toBe('http://10.0.0.2:8787');
  });

  it('brackets bare IPv6 hosts instead of producing [[::1]]', () => {
    expect(normalizeRuntimeAddress('::1')).toBe('http://[::1]:8787');
    expect(normalizeRuntimeAddress('[::1]:8787')).toBe('http://[::1]:8787');
  });

  it('rejects what is obviously not an address', () => {
    expect(normalizeRuntimeAddress('')).toBeNull();
    expect(normalizeRuntimeAddress('http://')).toBeNull();
    expect(normalizeRuntimeAddress('http://:8787')).toBeNull();
    expect(normalizeRuntimeAddress('ftp://10.0.0.2:21')).toBeNull();
    expect(normalizeRuntimeAddress(undefined)).toBeNull();
  });
});

describe('runtime identity helpers', () => {
  it('recognises loopback spellings', () => {
    expect(isLoopbackRuntime('http://127.0.0.1:8787')).toBe(true);
    expect(isLoopbackRuntime('http://localhost:8787')).toBe(true);
    expect(isLoopbackRuntime('http://[::1]:8787')).toBe(true);
    expect(isLoopbackRuntime('http://192.168.1.5:8787')).toBe(false);
    expect(isLoopbackRuntime('nonsense')).toBe(false);
  });

  it('compares addresses by host and port only', () => {
    expect(isSameRuntime('http://10.0.0.2:8787', 'http://10.0.0.2:8787/')).toBe(true);
    expect(isSameRuntime('http://10.0.0.2:8787', 'http://10.0.0.2:9000')).toBe(false);
    expect(isSameRuntime('nonsense', 'http://10.0.0.2:8787')).toBe(false);
  });

  it('labels loopback as 本机 and everything else by host:port', () => {
    expect(runtimeLabel('http://127.0.0.1:8787')).toBe('Local');
    expect(runtimeLabel('http://10.0.0.2:9102')).toBe('10.0.0.2:9102');
    // 认不出来的串原样返回：一行空白比原串更难排查
    expect(runtimeLabel('nonsense')).toBe('nonsense');
  });
});
