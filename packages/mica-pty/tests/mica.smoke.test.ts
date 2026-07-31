import { describe, expect, it } from 'vitest';
import { PtyDriver } from '../index.js';

/**
 * End-to-end smoke test: drives the real `dist/mica` TUI through mica-pty +
 * node-pty. Skipped by default because it needs a live provider API key.
 *
 *   # build first, then:
 *   MICA_PTY_SMOKE=1 npx vitest run packages/mica-pty/tests/mica.smoke.test.ts
 *
 * Point MICA_BIN/HOME/CWD below at your binary and an isolated MICA_HOME that
 * has config.json + storage.json seeded (see temp/mica_pty.py for a template).
 */
const MICA_BIN = '/Users/qironglin/Desktop/mica-code/dist/mica';
const HOME = '/private/tmp/mica-pty-smoke-home';
const CWD = '/private/tmp/mica-pty-smoke-wd';

const enabled = process.env.MICA_PTY_SMOKE === '1';
const suite = enabled ? describe : describe.skip;

suite('mica-pty driving dist/mica', () => {
  it('boots the TUI, sends a turn and sees the model reply', async () => {
    const driver = PtyDriver.spawn([MICA_BIN], {
      cols: 120,
      rows: 40,
      cwd: CWD,
      env: { MICA_HOME: HOME },
      logPath: '/private/tmp/mica-pty-smoke.raw',
    });
    expect(await driver.waitFor(/Type a message|start a conversation/, { timeoutMs: 60_000 })).toBe(true);
    await driver.waitIdle(800, 10_000);

    const sendPos = driver.text().length;
    await driver.typeText('回复两个字：你好', 15);
    driver.enter();
    const result = await driver.waitTurnCompleted(sendPos, { timeoutMs: 180_000 });
    expect(result).toBe('completed');
    await driver.waitIdle(800, 10_000);

    const tail = driver.latestScreen(60_000);
    expect(tail).toContain('你好');
    await driver.close('SIGTERM', 3_000);
  }, 240_000);
});
