import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { PtyDriver } from '../index.js';

/**
 * End-to-end check: drive the real `dist/mica` TUI via mica-pty, send 3 short
 * real turns, then verify the session auto-title subagent renamed the
 * persisted session (titleSource === 'auto').
 *
 * Uses short task-style turns so model replies stay small and do not contain
 * status keywords that would confuse waitTurnCompleted. Completion is detected
 * by polling the persisted session file's turnState instead of UI text.
 *
 * Skipped by default because it needs a live provider API key (same as
 * mica.smoke.test.ts):
 *
 *   MICA_PTY_TITLE_SMOKE=1 npx vitest run packages/mica-pty/tests/auto-title.smoke.test.ts
 */
const MICA_BIN = '/Users/qironglin/Desktop/mica-code/dist/mica';
const HOME = '/private/tmp/mica-pty-title-home';
const CWD = '/private/tmp/mica-pty-title-wd';
const SESSIONS_DIR = `${HOME}/sessions`;
const LOG = `/private/tmp/mica-pty-title-${process.pid}.raw`;

const enabled = process.env.MICA_PTY_TITLE_SMOKE === '1';
const suite = enabled ? describe : describe.skip;

const TURNS = [
  'create a file hello.txt containing hello world',
  'append goodbye to hello.txt',
  'read hello.txt and reply with its content',
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSessionTitles(): Array<{ id: string; title: string; titleSource?: string; turnState?: string; msgs: number }> {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(`${SESSIONS_DIR}/${f}`, 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((s) => ({
      id: s.id,
      title: s.title,
      titleSource: s.titleSource,
      turnState: s.turnState,
      msgs: s.snapshot?.conversationMessages?.length ?? 0,
    }));
}

async function waitForSession(
  predicate: (s: NonNullable<ReturnType<typeof readSessionTitles>[number]>) => boolean,
  timeoutMs: number,
  label: string,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const all = readSessionTitles();
    if (all.some(predicate)) {
      console.log(`[${label}] OK after ${Date.now() - start}ms:`, JSON.stringify(all));
      return true;
    }
    await sleep(1500);
  }
  console.log(`[${label}] TIMEOUT after ${timeoutMs}ms, last state:`, JSON.stringify(readSessionTitles()));
  return false;
}

suite('mica-pty: session auto-title end-to-end', () => {
  it('auto-renames the persisted session after 3 real short turns', async () => {
    const driver = PtyDriver.spawn([MICA_BIN], {
      cols: 140,
      rows: 40,
      cwd: CWD,
      env: { MICA_HOME: HOME, MICA_NO_DAEMON: '1' },
      logPath: LOG,
    });
    try {
      // Boot screen strips to "❯TypesomethingandpressEnter..." (spaces are
      // consumed by the renderer), so match loosely; probe showed 8s is enough
      // for input to work.
      await sleep(8000);
      expect(driver.text().length).toBeGreaterThan(0);

      const turnStages = [
        { turnIndex: 0, minMsgs: 2, label: 'turn1' },
        { turnIndex: 1, minMsgs: 4, label: 'turn2' },
        { turnIndex: 2, minMsgs: 6, label: 'turn3' },
      ];
      for (const { turnIndex, minMsgs, label } of turnStages) {
        await driver.typeText(TURNS[turnIndex], 8);
        driver.enter();
        const ok = await waitForSession((s) => s.turnState === 'completed' && s.msgs >= minMsgs, 240_000, label);
        expect(ok).toBe(true);
      }

      // Auto-title runs fire-and-forget after turn:after of the 3rd turn.
      const sawAuto = await waitForSession((s) => s.titleSource === 'auto', 120_000, 'auto-title');
      expect(sawAuto).toBe(true);
    } finally {
      await driver.close('SIGTERM', 3_000);
    }
  }, 600_000);
});
