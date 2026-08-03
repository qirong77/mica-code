import { afterEach, describe, expect, it } from 'vitest';
import { KEYS, PtyDriver, ctrl, key, stripAnsi } from '../index.js';

const SH = '/bin/sh';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const drivers: PtyDriver[] = [];

function spawn(argv: string[], options: Parameters<typeof PtyDriver.spawn>[1] = {}): PtyDriver {
  const driver = PtyDriver.spawn(argv, options);
  drivers.push(driver);
  return driver;
}

afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.close('SIGTERM', 1500);
});

describe('stripAnsi', () => {
  it('removes CSI sequences (colors, cursor moves, erase)', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('a\x1b[2Jb\x1b[1;1Hc')).toBe('abc');
  });

  it('removes OSC sequences (title/hyperlink)', () => {
    expect(stripAnsi('\x1b]0;title\x07body')).toBe('body');
    expect(stripAnsi('\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
  });

  it('keeps tab, CR and LF', () => {
    expect(stripAnsi('a\tb\r\nc')).toBe('a\tb\r\nc');
  });

  it('removes bare control bytes', () => {
    expect(stripAnsi('\x01\x02\x07\x1b[Kok')).toBe('ok');
  });
});

describe('keys', () => {
  it('maps key names to byte sequences', () => {
    expect(KEYS.enter).toBe('\r');
    expect(KEYS.esc).toBe('\x1b');
    expect(KEYS.up).toBe('\x1b[A');
    expect(key('tab')).toBe('\t');
  });

  it('builds Ctrl sequences', () => {
    expect(ctrl('c')).toBe('\x03');
    expect(ctrl('C')).toBe('\x03');
    expect(() => ctrl('1')).toThrow();
  });
});

describe('PtyDriver spawn & I/O', () => {
  it('captures echo output', async () => {
    const driver = spawn([SH], { cwd: '/tmp' });
    driver.send('echo hello-pty-one\n');
    expect(await driver.waitFor(/hello-pty-one/, { timeoutMs: 10_000 })).toBe(true);
    expect(driver.text()).toContain('hello-pty-one');
  }, 20_000);

  it('echoes typed input and strips the prompt ANSI', async () => {
    const driver = spawn([SH]);
    driver.send('echo abc-def\n');
    await driver.waitFor(/abc-def/, { timeoutMs: 10_000 });
    const text = driver.text();
    // Terminal prompts typically contain CSI sequences; stripped text must not.
    expect(text).not.toContain('\x1b[');
    expect(text).toContain('abc-def');
  }, 20_000);

  it('supports slow typeText + Enter (long input is not corrupted)', async () => {
    const driver = spawn([SH]);
    const payload = 'echo ' + 'x'.repeat(80);
    await driver.typeText(payload, 5);
    driver.enter();
    expect(await driver.waitFor(/x{80}/, { timeoutMs: 10_000 })).toBe(true);
    // The whole payload must have been submitted as one line, not split.
    const text = driver.text();
    const line = text.split('\n').find((l) => l.includes('echo x'));
    expect(line?.trim().endsWith(`echo ${'x'.repeat(80)}`)).toBe(true);
  }, 20_000);

  it('resizes the window', async () => {
    const driver = spawn([SH]);
    await driver.waitFor(/\$|#/, { timeoutMs: 10_000 });
    driver.resize(80, 24);
    driver.send('stty size\n');
    await driver.waitFor(/24 80/, { timeoutMs: 10_000 });
  }, 20_000);

  it('onData streams chunks and unsubscribe works', async () => {
    const driver = spawn([SH]);
    const seen: string[] = [];
    const off = driver.onData((d) => seen.push(d));
    driver.send('echo stream-check\n');
    await driver.waitFor(/stream-check/, { timeoutMs: 10_000 });
    expect(seen.join('')).toContain('stream-check');
    const count = seen.length;
    off();
    driver.send('echo after-off\n');
    await driver.waitFor(/after-off/, { timeoutMs: 10_000 });
    expect(seen.length).toBe(count);
  }, 20_000);

  it('waitIdle returns when output settles', async () => {
    const driver = spawn([SH]);
    driver.send('echo idle-check\n');
    await driver.waitFor(/idle-check/, { timeoutMs: 10_000 });
    expect(await driver.waitIdle(300, 10_000)).toBe(true);
  }, 20_000);

  it('does not return malformed Unicode when a screen tail cuts an emoji', async () => {
    const driver = spawn([process.execPath, '-e', "process.stdout.write('🤖')"]);
    await driver.waitFor(/🤖/, { timeoutMs: 10_000 });
    const screen = driver.latestScreen(1);
    expect(JSON.stringify(screen)).not.toContain('\\ud');
  }, 20_000);
});

describe('PtyDriver lifecycle', () => {
  it('reports process exit via onExit', async () => {
    const driver = spawn([SH, '-c', 'exit 0']);
    const exited = new Promise<number>((resolve) => driver.onExit((info) => resolve(info.exitCode)));
    expect(await exited).toBe(0);
    expect(driver.isExited).toBe(true);
  }, 15_000);

  it('close() kills a long-running child', async () => {
    const driver = spawn([SH, '-c', 'sleep 60']);
    await sleep(500);
    await driver.close('SIGTERM', 2_000);
    expect(driver.isExited).toBe(true);
  }, 15_000);

  it('ctrlD ends cat (EOF via control byte)', async () => {
    const driver = spawn([SH, '-c', 'cat']);
    driver.send('hello-eof\n');
    await driver.waitFor(/hello-eof/, { timeoutMs: 10_000 });
    const exited = new Promise<void>((resolve) => driver.onExit(() => resolve()));
    driver.sendKey('ctrlD');
    await exited;
  }, 15_000);
});

describe('waitTurnCompleted (mica-style status keywords)', () => {
  it('detects a completed turn after the send position', async () => {
    const driver = spawn([SH]);
    await driver.waitFor(/\$|#/, { timeoutMs: 10_000 });
    const sendPos = driver.text().length;
    driver.send('echo status-demo\n');
    // Simulate a status line the way mica renders it (active then completed).
    const result = await driver.waitTurnCompleted(sendPos, {
      activeRe: /echo status-demo/,
      endRe: /status-demo/,
      timeoutMs: 15_000,
      noActiveTimeoutMs: 5_000,
    });
    expect(result).toBe('completed');
  }, 25_000);

  it('returns "none" when no active status appears', async () => {
    const driver = spawn([SH]);
    await driver.waitFor(/\$|#/, { timeoutMs: 10_000 });
    const sendPos = driver.text().length;
    const result = await driver.waitTurnCompleted(sendPos, {
      activeRe: /NEVER-APPEARS/,
      endRe: /ALSO-NEVER/,
      timeoutMs: 30_000,
      noActiveTimeoutMs: 2_000,
    });
    expect(result).toBe('none');
  }, 35_000);
});
