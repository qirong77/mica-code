import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_WEB_PORT_ENV, DEFAULT_CONFIG_WEB_PORT } from '@packages/mica-web-shared/index.js';
import { readPreferredPort } from './server.js';

const original = process.env[CONFIG_WEB_PORT_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[CONFIG_WEB_PORT_ENV];
  else process.env[CONFIG_WEB_PORT_ENV] = original;
});

describe('readPreferredPort', () => {
  it('defaults the port to the shared constant', () => {
    expect(DEFAULT_CONFIG_WEB_PORT).toBe(13987);
  });

  it('returns undefined when the variable is not set', () => {
    delete process.env[CONFIG_WEB_PORT_ENV];
    expect(readPreferredPort()).toBeUndefined();
    process.env[CONFIG_WEB_PORT_ENV] = '   ';
    expect(readPreferredPort()).toBeUndefined();
  });

  it('reads an explicit port', () => {
    process.env[CONFIG_WEB_PORT_ENV] = '7';
    expect(readPreferredPort()).toBe(7);
  });

  it('rejects anything that is not a plain port number', () => {
    for (const raw of ['abc', '12.5', '9000abc', '0', '70000']) {
      process.env[CONFIG_WEB_PORT_ENV] = raw;
      expect(() => readPreferredPort(), raw).toThrow(/Invalid/);
    }
  });
});
