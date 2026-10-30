import { describe, expect, it } from 'vitest';
import {
  isLoopbackRuntime,
  isSameRuntime,
  normalizeEntryAddress,
  normalizeRuntimeAddress,
  relayTokenOf,
  runtimeLabel,
} from './runtime-address.js';

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

// 中转机链接（`https://host/?t=…&session=…`）是「要打开的那一页」，不是运行时 origin：
// 用 normalizeRuntimeAddress 处理会补成 `:8787` 并把凭据抹掉，那是一个打不开的地址。
describe('entry addresses', () => {
  const link = 'https://mica.qirong77.com/?t=90843bfaa98d07e22ba537d172adccf54d76&session=20261028T145320Z-we1k8x';

  it('keeps the query string and does not add the runtime port', () => {
    expect(normalizeEntryAddress(link)).toBe(link);
    // 缺协议时按主机名猜：公网域名走 https，内网地址走 http
    expect(normalizeEntryAddress('mica.qirong77.com/?t=abc')).toBe('https://mica.qirong77.com/?t=abc');
    expect(normalizeEntryAddress('192.168.1.5:8787')).toBe('http://192.168.1.5:8787/');
  });

  it('reads the relay token only when the link carries one', () => {
    expect(relayTokenOf(link)).toBe('90843bfaa98d07e22ba537d172adccf54d76');
    expect(relayTokenOf('https://mica.qirong77.com/?t=abc')).toBe('abc');
    expect(relayTokenOf('https://mica.qirong77.com/')).toBeNull();
    expect(relayTokenOf('https://mica.qirong77.com/?t=')).toBeNull();
    // 直连地址里偶然有个 t 参数不算凭据：它得是真能解析出来的地址
    expect(relayTokenOf('not a host?t=abc')).toBeNull();
  });

  it('refuses what is not an address at all', () => {
    expect(normalizeEntryAddress('')).toBeNull();
    expect(normalizeEntryAddress('https://')).toBeNull();
    expect(normalizeEntryAddress('ftp://example.com')).toBeNull();
  });
});
