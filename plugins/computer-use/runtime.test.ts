import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function runtimeHarness(args: string[]) {
  const source = readFileSync(new URL('./runtime/scripts/desktop.mjs', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '')
    .replace('import.meta.url', JSON.stringify('file:///isolated/scripts/desktop.mjs'))
    .replace('main().catch((e) => fail(e?.message || String(e)));', 'globalThis.run = main;');
  const spawnSync = vi.fn(() => ({ status: 0, stdout: '{"x":1,"y":2,"before":{"x":0,"y":0}}', stderr: '' }));
  const context = {
    process: {
      argv: ['node', 'desktop.mjs', ...args],
      env: {},
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      exit: (code: number) => {
        throw new Error(`exit ${code}`);
      },
    },
    spawnSync,
    setTimeout: (done: () => void) => queueMicrotask(done),
    existsSync: () => true,
    statSync: () => ({ mtimeMs: 1 }),
    dirname: () => '/isolated/scripts',
    resolve: (...parts: string[]) => parts.join('/'),
    fileURLToPath: (url: string) => url,
    console: { error: vi.fn() },
    run: async () => {},
  };
  runInNewContext(source, context);
  return { run: context.run, spawnSync };
}

describe('desktop runtime argument validation', () => {
  it.each([
    ['click', '100'],
    ['dclick', '100'],
    ['rclick', '100'],
    ['move', '100'],
    ['drag'],
    ['drag', '1', '2', '3'],
    ['drag', '1', '2', '3', '4', 'invalid'],
    ['highlight', '1', '2', '3'],
    ['highlight', '1', '2', '0', '10'],
    ['move', '', '2'],
    ['drag', '1', '2', '3', '4', ' '],
    ['wait', '-1'],
    ['wait', '2147483648'],
    ['wait-el', 'App', 'Button', '-1'],
  ])('rejects incomplete or invalid coordinates without invoking native tools: %j', async (...args) => {
    const { run, spawnSync } = runtimeHarness(args);
    await expect(run()).rejects.toThrow('exit 1');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('moves and verifies the pointer in one native helper invocation', async () => {
    const { run, spawnSync } = runtimeHarness(['move', '1', '2']);
    await run();
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0]).toEqual([
      expect.stringContaining('/bin/helper'),
      ['move', '1', '2'],
      expect.anything(),
    ]);
  });

  it('still allows a click at the current mouse position when both coordinates are omitted', async () => {
    const { run, spawnSync } = runtimeHarness(['click']);
    await run();
    expect(spawnSync).toHaveBeenCalledWith(
      expect.stringContaining('/bin/helper'),
      ['click', '--button', 'left', '--count', '1'],
      expect.anything(),
    );
  });
});
