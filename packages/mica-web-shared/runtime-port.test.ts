import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_PORT,
  DEFAULT_RUNTIME_URL,
  RUNTIME_PORT_ENV,
  loopbackRuntimeUrl,
  parseRuntimePort,
} from './runtime-port.js';

describe('DEFAULT_RUNTIME_PORT', () => {
  it('is the port the desktop runtime listens on', () => {
    expect(DEFAULT_RUNTIME_PORT).toBe(8787);
    expect(RUNTIME_PORT_ENV).toBe('MICA_DESKTOP_PORT');
    expect(DEFAULT_RUNTIME_URL).toBe('http://127.0.0.1:8787');
  });
});

describe('parseRuntimePort', () => {
  it('reads env-style strings and numbers', () => {
    expect(parseRuntimePort('9000')).toBe(9000);
    expect(parseRuntimePort(9000)).toBe(9000);
    expect(parseRuntimePort('  9000  ')).toBe(9000);
  });

  it('falls back on anything that is not a usable port', () => {
    const junk = ['', '   ', 'abc', '0', '-1', '70000', '12.5', '9000abc', '-0', null, undefined, {}];
    for (const value of junk) {
      expect(parseRuntimePort(value)).toBe(DEFAULT_RUNTIME_PORT);
    }
  });

  it('honours a caller-supplied fallback', () => {
    expect(parseRuntimePort('', 18787)).toBe(18787);
  });
});

describe('loopbackRuntimeUrl', () => {
  it('builds the loopback origin for a port', () => {
    expect(loopbackRuntimeUrl(9000)).toBe('http://127.0.0.1:9000');
    expect(loopbackRuntimeUrl('9000')).toBe('http://127.0.0.1:9000');
    expect(loopbackRuntimeUrl()).toBe('http://127.0.0.1:8787');
  });

  it('never produces a malformed origin', () => {
    expect(loopbackRuntimeUrl('nope')).toBe('http://127.0.0.1:8787');
  });
});
