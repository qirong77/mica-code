import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PtyDriver } from '../index.js';

const MICA_BIN = '/Users/qironglin/Desktop/VsGo-Projects/mica-code/dist/mica';
const HOME = '/private/tmp/mica-gc-measure-home';
const enabled = process.env.MICA_PTY_MEASURE === '1';
const suite = enabled ? describe : describe.skip;

function rssKb(pid: number): number {
  try {
    const out = execSync(`ps -o rss= -p ${pid}`).toString().trim();
    return Number.parseInt(out, 10);
  } catch {
    return -1;
  }
}

/** Read array sizes from the most-recently-written, parseable session file. */
function readSessionArrays(): { id: string; usage: number; messages: number; conversation: number } | null {
  try {
    const sessionsDir = join(HOME, 'sessions');
    if (!existsSync(sessionsDir)) return null;
    const files = readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, mtime: statSync(join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8'));
        const snap = data.snapshot ?? {};
        if (!data.id) continue;
        return {
          id: data.id,
          usage: (snap.usageHistory ?? []).length,
          messages: (snap.messages ?? []).length,
          conversation: (snap.conversationMessages ?? []).length,
        };
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

suite('loop memory measurement', () => {
  it('runs a longer /loop, sampling RSS and persisted array sizes', async () => {
    const driver = PtyDriver.spawn([MICA_BIN], {
      cols: 120,
      rows: 40,
      cwd: '/private/tmp',
      env: { MICA_HOME: HOME },
      logPath: '/private/tmp/mica-gc-measure.raw',
    });

    expect(await driver.waitFor(/Type a message|start a conversation|mica/i, { timeoutMs: 60_000 })).toBe(true);
    await driver.waitIdle(800, 10_000);

    // Start a loop with a lightweight task, 10s interval.
    driver.typeText('/loop 10s 回复一个字：好', 6);
    driver.enter();
    await driver.waitIdle(500, 10_000);

    let micaPid = -1;
    try {
      micaPid = Number.parseInt(execSync(`pgrep -f "dist/mica" | head -1`).toString().trim(), 10);
    } catch {
      // ignore
    }

    const samples: Array<Record<string, number>> = [];
    const start = Date.now();
    const duration = 190_000; // ~18 loop rounds at 10s
    while (Date.now() - start < duration) {
      const art = readSessionArrays();
      samples.push({
        t: Math.round((Date.now() - start) / 1000),
        rssKb: rssKb(micaPid),
        usage: art?.usage ?? -1,
        messages: art?.messages ?? -1,
        conversation: art?.conversation ?? -1,
      });
      await new Promise((r) => setTimeout(r, 5_000));
    }

    // Stop the loop cleanly so the session persists its last arrays.
    driver.typeText('/loop stop', 6);
    driver.enter();
    await driver.waitIdle(600, 8_000);
    const finalArt = readSessionArrays();

    // eslint-disable-next-line no-console
    console.log('=== MEASURE_RESULT ===');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(samples, null, 2));
    // eslint-disable-next-line no-console
    console.log('=== FINAL_ARTIFACTS ===');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(finalArt));

    await driver.close('SIGTERM', 6_000);

    const lastRss = samples.filter((s) => s.rssKb > 0).at(-1)?.rssKb ?? -1;
    expect(lastRss).toBeGreaterThan(0);
  }, 320_000);
});
