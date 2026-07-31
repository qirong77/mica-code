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
 *   npx vitest run packages/mica-pty/tests/auto-title.smoke.test.ts
 */
const MICA_BIN = '/Users/qironglin/Desktop/mica-code/dist/mica';
const HOME = '/private/tmp/mica-pty-title-home';
const CWD = '/private/tmp/mica-pty-title-wd';
const SESSIONS_DIR = `${HOME}/sessions`;

const TURNS = [
  '在 hello.txt 里写入一行：hello world',
  '再往 hello.txt 追加一行：goodbye',
  '把 hello.txt 的内容读出来并逐行回复',
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

describe('mica-pty: session auto-title end-to-end', () => {
  it('auto-renames the persisted session after 3 real short turns', async () => {
    const driver = PtyDriver.spawn([MICA_BIN], {
      cols: 140,
      rows: 40,
      cwd: CWD,
      env: { MICA_HOME: HOME },
      logPath: '/private/tmp/mica-pty-title.raw',
    });
    try {
      expect(await driver.waitFor(/Type a message|start a conversation/, { timeoutMs: 90_000 })).toBe(true);
      await driver.waitIdle(1000, 15_000);

      // Turn 1: any persisted session with turnState === 'completed' counts.
      const turn1Ok = await waitForSession((s) => s.turnState === 'completed' && s.msgs >= 2, 240_000, 'turn1');
      expect(turn1Ok).toBe(true);

      const turn2Ok = await waitForSession((s) => s.turnState === 'completed' && s.msgs >= 4, 240_000, 'turn2');
      expect(turn2Ok).toBe(true);

      const turn3Ok = await waitForSession((s) => s.turnState === 'completed' && s.msgs >= 6, 240_000, 'turn3');
      expect(turn3Ok).toBe(true);

      // Auto-title runs fire-and-forget after turn:after of the 3rd turn.
      const sawAuto = await waitForSession((s) => s.titleSource === 'auto', 120_000, 'auto-title');
      expect(sawAuto).toBe(true);
    } finally {
      await driver.close('SIGTERM', 3_000);
    }
  }, 600_000);
});
