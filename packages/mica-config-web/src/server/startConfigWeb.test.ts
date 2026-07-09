import { describe, expect, it } from 'vitest';
import { resolveConfigWebWorkerCommand } from './startConfigWeb.js';

describe('resolveConfigWebWorkerCommand', () => {
  it('spawns Bun with the source entry in dev mode', () => {
    expect(
      resolveConfigWebWorkerCommand(
        ['/opt/homebrew/bin/bun', '/repo/src/index.ts'],
        '/opt/homebrew/bin/bun',
      ),
    ).toEqual({
      executable: '/opt/homebrew/bin/bun',
      entryArgs: ['/repo/src/index.ts'],
    });
  });

  it('spawns the compiled binary without Bun virtual entry args', () => {
    expect(
      resolveConfigWebWorkerCommand(
        ['bun', '/$bunfs/root/mica'],
        '/Users/me/.local/bin/mica',
      ),
    ).toEqual({
      executable: '/Users/me/.local/bin/mica',
      entryArgs: [],
    });
  });

  it('passes user args through when they are real entry args', () => {
    expect(
      resolveConfigWebWorkerCommand(
        ['/Users/me/bin/custom-runner', '/repo/src/index.ts', '--flag'],
        '/Users/me/bin/custom-runner',
      ),
    ).toEqual({
      executable: '/Users/me/bin/custom-runner',
      entryArgs: ['/repo/src/index.ts'],
    });
  });
});
