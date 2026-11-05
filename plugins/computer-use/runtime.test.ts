import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type SpawnResult = { status: number; stdout?: string; stderr?: string };
type SpawnCall = { bin: string; argv: string[]; options: { env?: Record<string, string> } };

const DEFAULT_HELPER_OUTPUT = '{"x":1,"y":2,"before":{"x":0,"y":0}}';

type HarnessOptions = {
  env?: Record<string, string>;
  files?: Record<string, string>;
  spawn?: (bin: string, argv: string[]) => SpawnResult | undefined;
};

function runtimeHarness(args: string[], options: HarnessOptions = {}) {
  const source = readFileSync(new URL('./runtime/scripts/desktop.mjs', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '')
    .replace('import.meta.url', JSON.stringify('file:///isolated/scripts/desktop.mjs'))
    .replace('main().catch((e) => fail(e?.message || String(e)));', 'globalThis.run = main;');
  const files: Record<string, string> = { ...(options.files || {}) };
  const calls: SpawnCall[] = [];
  const spawnSync = vi.fn((bin: string, argv: string[], spawnOptions?: SpawnCall['options']) => {
    calls.push({ bin, argv, options: spawnOptions || {} });
    const custom = options.spawn?.(bin, argv);
    if (custom) return custom;
    return { status: 0, stdout: DEFAULT_HELPER_OUTPUT, stderr: '' };
  });
  const stdout: string[] = [];
  const context = {
    process: {
      argv: ['node', 'desktop.mjs', ...args],
      env: { ...(options.env || {}) },
      stdout: { write: (line: string) => void stdout.push(String(line)) },
      stderr: { write: vi.fn() },
      exit: (code: number) => {
        throw new Error(`exit ${code}`);
      },
    },
    spawnSync,
    setTimeout: (done: () => void) => queueMicrotask(done),
    existsSync: () => true,
    mkdirSync: () => {},
    statSync: () => ({ mtimeMs: 1, size: 1024 }),
    readFileSync: (path: string) => {
      if (files[path] === undefined) throw new Error(`ENOENT ${path}`);
      return files[path];
    },
    writeFileSync: (path: string, data: string) => {
      files[path] = String(data);
    },
    dirname: () => '/isolated/scripts',
    resolve: (...parts: string[]) => parts.join('/'),
    fileURLToPath: (url: string) => url,
    tmpdir: () => '/tmp',
    console: { error: vi.fn() },
    run: async () => {},
  };
  runInNewContext(source, context);
  return { run: context.run, spawnSync, calls, files, stdout: () => stdout.join('') };
}

const permit = (entries: string[], expiresAt = Date.now() + 60_000) => ({
  v: 1,
  createdAt: Date.now(),
  expiresAt,
  entries: entries.map((key) => ({ key, used: false })),
});

const permitPath = '/tmp/mica-computer-use-test/permit.json';

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
    const { run, spawnSync } = runtimeHarness(args, {
      env: { MICA_COMPUTER_USE_APPROVAL: permitPath },
      files: { [permitPath]: JSON.stringify(permit([JSON.stringify(args)])) },
    });
    await expect(run()).rejects.toThrow('exit 1');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('moves and verifies the pointer in one native helper invocation', async () => {
    const { run, spawnSync } = runtimeHarness(['move', '1', '2'], {
      env: { MICA_COMPUTER_USE_APPROVAL: permitPath },
      files: { [permitPath]: JSON.stringify(permit([JSON.stringify(['move', '1', '2'])])) },
    });
    await run();
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0]).toEqual([
      expect.stringContaining('/bin/helper'),
      ['move', '1', '2'],
      expect.anything(),
    ]);
  });

  it('still allows a click at the current mouse position when both coordinates are omitted', async () => {
    const { run, spawnSync } = runtimeHarness(['click'], {
      env: { MICA_COMPUTER_USE_APPROVAL: permitPath },
      files: { [permitPath]: JSON.stringify(permit([JSON.stringify(['click'])])) },
    });
    await run();
    expect(spawnSync).toHaveBeenCalledWith(
      expect.stringContaining('/bin/helper'),
      ['click', '--button', 'left', '--count', '1'],
      expect.anything(),
    );
  });
});

describe('desktop runtime write guard', () => {
  it('refuses a write command when no approval was granted', async () => {
    const { run, spawnSync } = runtimeHarness(['tap', 'Calculator', '乘']);
    await expect(run()).rejects.toThrow('exit 6');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    ['expired permit', { ...permit([JSON.stringify(['type', 'hi'])], Date.now() - 1000) }],
    ['permit for a different command', permit([JSON.stringify(['key', 'esc'])])],
    ['permit already used', { v: 1, entries: [{ key: JSON.stringify(['type', 'hi']), used: true }] }],
  ])('refuses when the permit does not cover this exact command (%s)', async (_label, body) => {
    const { run, spawnSync } = runtimeHarness(['type', 'hi'], {
      env: { MICA_COMPUTER_USE_APPROVAL: permitPath },
      files: { [permitPath]: JSON.stringify(body) },
    });
    await expect(run()).rejects.toThrow('exit 6');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('consumes the permit entry so the same approval cannot run twice', async () => {
    const { run, files, spawnSync } = runtimeHarness(['type', 'hi'], {
      env: { MICA_COMPUTER_USE_APPROVAL: permitPath },
      files: { [permitPath]: JSON.stringify(permit([JSON.stringify(['type', 'hi'])])) },
    });
    await run();
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(files[permitPath]!);
    expect(stored.entries[0].used).toBe(true);

    const replay = runtimeHarness(['type', 'hi'], {
      env: { MICA_COMPUTER_USE_APPROVAL: permitPath },
      files: { [permitPath]: files[permitPath]! },
    });
    await expect(replay.run()).rejects.toThrow('exit 6');
  });

  it('lets read-only commands through untouched', async () => {
    const { run, spawnSync } = runtimeHarness(['screens']);
    await run();
    expect(spawnSync).toHaveBeenCalledWith(expect.stringContaining('/bin/helper'), ['screens'], expect.anything());
  });
});

describe('desktop runtime screenshots', () => {
  const TWO_DISPLAYS = JSON.stringify({
    ok: true,
    count: 2,
    union: { x: 0, y: 0, w: 2878, h: 1185 },
    displays: [
      { index: 0, id: 1, main: true, front: false, x: 0, y: 0, w: 1512, h: 982, pixelWidth: 3024, pixelHeight: 1964, scale: 2 },
      { index: 1, id: 30, main: false, front: true, x: 1512, y: 161, w: 1366, h: 1024, pixelWidth: 2732, pixelHeight: 2048, scale: 2 },
    ],
    frontWindow: { id: 48988, pid: 100, app: 'Safari', title: '', x: 1600, y: 200, w: 800, h: 600, displayIndex: 1 },
  });

  const withScreens = (bin: string, argv: string[]) =>
    bin.includes('/bin/helper') && argv[0] === 'screens' ? { status: 0, stdout: TWO_DISPLAYS } : undefined;

  const captures = (calls: SpawnCall[]) => calls.filter((call) => call.bin === '/usr/sbin/screencapture');

  it('captures the display with the front window first, then every other display', async () => {
    const { run, calls } = runtimeHarness(['shot', '/tmp/x.png'], { spawn: withScreens });
    await run();
    const shots = captures(calls);
    expect(shots.map((call) => call.argv)).toEqual([
      ['-x', '-R', '1512,161,1366,1024', '/tmp/x.png'],
      ['-x', '-R', '0,0,1512,982', '/tmp/x-d1.png'],
    ]);
  });

  it('captures a single display with --display', async () => {
    const { run, calls } = runtimeHarness(['shot', '/tmp/y.png', '--display', '0'], { spawn: withScreens });
    await run();
    expect(captures(calls).map((call) => call.argv)).toEqual([['-x', '-R', '0,0,1512,982', '/tmp/y.png']]);
  });

  it('keeps an explicit region as one capture across displays', async () => {
    const { run, calls } = runtimeHarness(['shot', '/tmp/z.png', '1512,161,200,100'], { spawn: withScreens });
    await run();
    expect(captures(calls).map((call) => call.argv)).toEqual([['-x', '-R', '1512,161,200,100', '/tmp/z.png']]);
  });

  it('resolves an app name to its frontmost window for winshot', async () => {
    const { run, calls } = runtimeHarness(['winshot', '/tmp/w.png', 'Safari'], {
      spawn: (bin, argv) =>
        bin.includes('/bin/helper') && argv[0] === 'winlist'
          ? { status: 0, stdout: '[{"id":48988,"title":"","x":0,"y":0,"w":1,"h":1}]' }
          : undefined,
    });
    await run();
    expect(captures(calls).map((call) => call.argv)).toEqual([['-x', '-l', '48988', '/tmp/w.png']]);
  });
});
