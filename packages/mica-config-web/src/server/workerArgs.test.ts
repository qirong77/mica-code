import { describe, expect, it } from 'vitest';
import { getConfigWebWorkerToken } from './workerArgs.js';

describe('getConfigWebWorkerToken', () => {
  it('reads the worker token from bun source argv', () => {
    expect(getConfigWebWorkerToken(['/path/to/bun', '/repo/src/index.ts', '--config-web-worker', 'token-source'])).toBe(
      'token-source',
    );
  });

  it('reads the worker token from compiled binary argv', () => {
    expect(getConfigWebWorkerToken(['/Users/me/.local/bin/mica', '--config-web-worker', 'token-binary'])).toBe(
      'token-binary',
    );
  });

  it('returns null when the current process is not a config web worker', () => {
    expect(getConfigWebWorkerToken(['/Users/me/.local/bin/mica'])).toBeNull();
  });

  it('requires a token after the worker flag', () => {
    expect(() => getConfigWebWorkerToken(['/Users/me/.local/bin/mica', '--config-web-worker'])).toThrow(
      'Missing config web token',
    );
  });
});
