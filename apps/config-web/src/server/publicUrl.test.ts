import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { resolveConfigWebAdvertisedUrl, resolveConfigWebBindHost } from './publicUrl.js';

describe('config web public address', () => {
  it('binds to loopback by default and accepts an explicit bind host', () => {
    expect(resolveConfigWebBindHost(undefined)).toBe('127.0.0.1');
    expect(resolveConfigWebBindHost(' 192.0.2.10 ')).toBe('192.0.2.10');
  });

  it('uses MICA_CONFIG_WEB_PUBLIC_URL verbatim and supports a port placeholder', () => {
    expect(resolveConfigWebAdvertisedUrl(13987, { publicUrl: 'https://config.example.test' })).toBe(
      'https://config.example.test',
    );
    expect(resolveConfigWebAdvertisedUrl(13987, { publicUrl: 'http://config.example.test:{port}/' })).toBe(
      'http://config.example.test:13987',
    );
    expect(() => resolveConfigWebAdvertisedUrl(13987, { publicUrl: 'http://127.0.0.1:13987' })).toThrow(
      'must not use a loopback host',
    );
  });

  it('advertises loopback URL when bind host is loopback (mica interactive mode)', () => {
    expect(resolveConfigWebAdvertisedUrl(13987, { publicUrl: '', interfaces: {} })).toBe(
      'http://127.0.0.1:13987',
    );
    const internal = interfaceInfo('127.0.0.1', true);
    const external = interfaceInfo('192.0.2.44', false);
    expect(
      resolveConfigWebAdvertisedUrl(13987, {
        publicUrl: '',
        interfaces: { lo0: [internal], en0: [external] },
      }),
    ).toBe('http://127.0.0.1:13987');
  });

  it('advertises external IP when bind host is 0.0.0.0', () => {
    const previousHost = process.env.MICA_CONFIG_WEB_HOST;
    process.env.MICA_CONFIG_WEB_HOST = '0.0.0.0';
    try {
      const internal = interfaceInfo('127.0.0.1', true);
      const external = interfaceInfo('192.0.2.44', false);
      expect(
        resolveConfigWebAdvertisedUrl(13987, {
          publicUrl: '',
          interfaces: { lo0: [internal], en0: [external] },
        }),
      ).toBe('http://192.0.2.44:13987');

      expect(resolveConfigWebAdvertisedUrl(13987, { publicUrl: '', interfaces: {} })).toBe(
        'http://0.0.0.0:13987',
      );
    } finally {
      if (previousHost === undefined) delete process.env.MICA_CONFIG_WEB_HOST;
      else process.env.MICA_CONFIG_WEB_HOST = previousHost;
    }
  });
});

function interfaceInfo(address: string, internal: boolean): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}
