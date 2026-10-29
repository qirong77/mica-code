import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNTIME_NAME, resolveLogDir } from './brand.js';

const originalLogDir = process.env.MICA_LOG_DIR;

afterEach(() => {
  if (originalLogDir === undefined) delete process.env.MICA_LOG_DIR;
  else process.env.MICA_LOG_DIR = originalLogDir;
});

describe('resolveLogDir', () => {
  it('honours MICA_LOG_DIR over the platform default', () => {
    process.env.MICA_LOG_DIR = '/tmp/mica-log-override';
    expect(resolveLogDir()).toBe(resolve('/tmp/mica-log-override'));
  });

  it('keeps logs under the user home, not the system temp dir', () => {
    delete process.env.MICA_LOG_DIR;
    const dir = resolveLogDir();
    expect(dir.startsWith(resolve(homedir()))).toBe(true);
    expect(dir.includes(RUNTIME_NAME)).toBe(true);
    if (process.platform === 'darwin') {
      expect(dir).toBe(join(homedir(), 'Library', 'Logs', RUNTIME_NAME));
    }
  });
});
