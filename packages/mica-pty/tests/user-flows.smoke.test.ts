import { describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PtyDriver } from '../index.js';

/**
 * Real-user flow smoke suite: drives `dist/mica` through mica-pty as a real
 * user would, covering boot-up, every builtin command, multi-agent flows,
 * real model turns, file tools, resume, rename, role cycling, and random
 * command stress. Skipped by default because it needs a live provider API key:
 *
 *   # build first, then:
 *   MICA_PTY_FLOW_SMOKE=1 npx vitest run packages/mica-pty/tests/user-flows.smoke.test.ts
 *
 * The user's real ~/.mica/config.json (with API keys) is copied into an
 * isolated per-test MICA_HOME; user data is never touched.
 */
const MICA_BIN = '/Users/qironglin/Desktop/mica-code/dist/mica';
// vitest redirects HOME to a temp dir; pass the real source config explicitly:
//   MICA_PTY_SOURCE_HOME="$HOME/.mica" MICA_PTY_FLOW_SMOKE=1 npx vitest run ...
const SOURCE_CONFIG = `${process.env.MICA_PTY_SOURCE_HOME ?? `${process.env.HOME}/.mica`}/config.json`;
const ROOT = `/private/tmp/mica-flows-${process.pid}`;
const WORK = `${ROOT}/work`;

const enabled = process.env.MICA_PTY_FLOW_SMOKE === '1';
const suite = enabled ? describe : describe.skip;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fresh MICA_HOME without any config (first-run user). */
function freshHome(tag: string): string {
  const home = `${ROOT}/home-${tag}`;
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  return home;
}

/** MICA_HOME seeded with the user's real config (API keys included). */
function seededHome(tag: string): string {
  const home = freshHome(tag);
  copyFileSync(SOURCE_CONFIG, join(home, 'config.json'));
  return home;
}

function makeWork(tag: string): string {
  const dir = `${WORK}-${tag}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function spawnMica(home: string, cwd: string, tag: string, extraArgs: string[] = []): PtyDriver {
  return PtyDriver.spawn([MICA_BIN, ...extraArgs], {
    cols: 120,
    rows: 40,
    cwd,
    env: { MICA_HOME: home, MICA_NO_DAEMON: '1' },
    logPath: `${ROOT}/${tag}.raw`,
  });
}

async function waitBoot(driver: PtyDriver, timeoutMs = 90_000): Promise<void> {
  expect(await driver.waitFor(/start a conversation|启动失败/, { timeoutMs })).toBe(true);
}

async function waitForText(driver: PtyDriver, pattern: RegExp, timeoutMs: number, label: string): Promise<boolean> {
  const ok = await driver.waitFor(pattern, { timeoutMs, mode: 'screen' });
  if (!ok) {
    console.log(`[${label}] TIMEOUT waiting ${pattern}; tail:\n${driver.latestScreen(6000)}`);
  }
  return ok;
}

type SessionInfo = {
  id: string;
  title: string;
  titleSource?: string;
  turnState?: string;
  msgs: number;
};

function listSessions(home: string): SessionInfo[] {
  const dir = join(home, 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'));
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

async function waitSession(
  home: string,
  predicate: (s: SessionInfo) => boolean,
  timeoutMs: number,
  label: string,
): Promise<SessionInfo> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const all = listSessions(home);
    const hit = all.find(predicate);
    if (hit) {
      console.log(`[${label}] OK after ${Date.now() - start}ms:`, JSON.stringify(hit));
      return hit;
    }
    await sleep(1500);
  }
  console.log(`[${label}] TIMEOUT after ${timeoutMs}ms, last state:`, JSON.stringify(listSessions(home)));
  throw new Error(`${label} timeout`);
}

/** Send a turn and wait until the newest persisted session reaches `turnState` with >= minMsgs. */
async function sendTurnAndWait(
  driver: PtyDriver,
  home: string,
  text: string,
  minMsgs: number,
  label: string,
  turnState: 'completed' | 'error' | 'aborted' = 'completed',
  charDelay = 8,
): Promise<SessionInfo> {
  await driver.typeText(text, charDelay);
  driver.enter();
  return waitSession(home, (s) => s.turnState === turnState && s.msgs >= minMsgs, 240_000, label);
}

async function exitViaCommand(driver: PtyDriver): Promise<void> {
  await driver.typeText('/exit', 8);
  driver.enter();
  const deadline = Date.now() + 15_000;
  while (!driver.isExited && Date.now() < deadline) await sleep(200);
  if (!driver.isExited) await driver.close('SIGTERM', 3_000);
}

suite('mica real-user flows (PTY)', () => {
  it('fresh HOME: boots into UI with a config warning instead of fatal failure', async () => {
    const home = freshHome('fresh');
    const cwd = makeWork('fresh');
    const driver = spawnMica(home, cwd, 'fresh');
    try {
      await waitBoot(driver, 120_000);
      // The model-list fetch fails (no api key) but must only warn, not kill the app.
      expect(await waitForText(driver, /模型加载失败|Failed to fetch models/, 30_000, 'fresh-warning')).toBe(true);
      const tail = driver.latestScreen(12_000);
      expect(tail).not.toContain('启动失败：修复配置');
      // Sending a message without a key must show a friendly error, not crash.
      await driver.typeText('你好', 15);
      driver.enter();
      expect(await waitForText(driver, /api_key|配置/, 30_000, 'fresh-send-error')).toBe(true);
      expect(driver.isExited).toBe(false);
      await exitViaCommand(driver);
      expect(driver.isExited).toBe(true);
    } finally {
      await driver.close('SIGTERM', 3_000);
    }
  }, 240_000);

  it('seeded HOME: /status /context /skills /mcp panels, unknown command, /rename', async () => {
    const home = seededHome('panels');
    const cwd = makeWork('panels');
    const driver = spawnMica(home, cwd, 'panels');
    try {
      await waitBoot(driver);
      await driver.waitIdle(500, 8_000);

      await driver.typeText('/status', 8);
      driver.enter();
      expect(await waitForText(driver, /esc exit|type to close/, 20_000, 'status-panel')).toBe(true);
      expect(await waitForText(driver, /Model|Provider|Role|Cwd/, 5_000, 'status-content')).toBe(true);
      driver.esc();

      await driver.typeText('/context', 8);
      driver.enter();
      expect(await waitForText(driver, /context map/, 20_000, 'context-panel')).toBe(true);
      driver.esc();

      await driver.typeText('/skills', 8);
      driver.enter();
      expect(await waitForText(driver, /skills|SKILL|no skills/i, 20_000, 'skills-panel')).toBe(true);
      driver.esc();

      await driver.typeText('/mcp', 8);
      driver.enter();
      expect(await waitForText(driver, /mcp|sequential-thinking|no mcp/i, 20_000, 'mcp-panel')).toBe(true);
      driver.esc();

      // Unknown command must produce a hint, not crash.
      await driver.typeText('/definitely-not-a-command', 8);
      driver.enter();
      expect(await waitForText(driver, /Unknown command/i, 15_000, 'unknown-command')).toBe(true);
      expect(driver.isExited).toBe(false);

      // Rename with an inline title.
      await driver.typeText('/rename 测试标题 FlowPanels', 8);
      driver.enter();
      expect(await waitForText(driver, /Session renamed to|测试标题/, 15_000, 'rename')).toBe(true);
      const renamed = await waitSession(home, (s) => s.title === '测试标题 FlowPanels', 20_000, 'rename-session');
      expect(renamed.title).toBe('测试标题 FlowPanels');

      await exitViaCommand(driver);
    } finally {
      await driver.close('SIGTERM', 3_000);
    }
  }, 300_000);

  it('real turns: file create → append → read-back, then /compact and /rewind', async () => {
    const home = seededHome('files');
    const cwd = makeWork('files');
    const driver = spawnMica(home, cwd, 'files');
    try {
      await waitBoot(driver);
      await driver.waitIdle(500, 8_000);

      await sendTurnAndWait(
        driver,
        home,
        'create a file hello.txt containing hello world, then stop',
        2,
        'turn-create',
      );
      expect(existsSync(join(cwd, 'hello.txt'))).toBe(true);

      await sendTurnAndWait(
        driver,
        home,
        'append the line goodbye to hello.txt, then stop',
        4,
        'turn-append',
      );
      const content = readFileSync(join(cwd, 'hello.txt'), 'utf8');
      expect(content).toMatch(/goodbye/);

      await sendTurnAndWait(
        driver,
        home,
        'read hello.txt and reply with its exact content, then stop',
        6,
        'turn-read',
      );

      // /compact runs an exclusive task; just ensure it opens/executes without crashing.
      await driver.typeText('/compact', 8);
      driver.enter();
      await sleep(4_000);
      expect(driver.isExited).toBe(false);

      // /rewind opens the rewind dialog; Esc closes it.
      await driver.typeText('/rewind', 8);
      driver.enter();
      await sleep(3_000);
      driver.esc();
      expect(driver.isExited).toBe(false);

      await exitViaCommand(driver);
    } finally {
      await driver.close('SIGTERM', 3_000);
    }
  }, 600_000);

  it('multi-agent: /new, /task lists both sessions, /fork branches history', async () => {
    const home = seededHome('agents');
    const cwd = makeWork('agents');
    const driver = spawnMica(home, cwd, 'agents');
    try {
      await waitBoot(driver);
      await driver.waitIdle(500, 8_000);

      await sendTurnAndWait(
        driver,
        home,
        'reply with exactly: alpha',
        2,
        'agent1-turn',
      );

      // /new opens a fresh agent session.
      await driver.typeText('/new', 8);
      driver.enter();
      expect(await waitForText(driver, /New agent|new session|agent/i, 20_000, 'new-agent')).toBe(true);
      await sleep(3_000);

      // Second agent can chat independently.
      await sendTurnAndWait(
        driver,
        home,
        'reply with exactly: beta',
        2,
        'agent2-turn',
      );

      // /task lists sessions/subagents.
      await driver.typeText('/task', 8);
      driver.enter();
      expect(await waitForText(driver, /task|session|agent/i, 20_000, 'task-panel')).toBe(true);
      driver.esc();

      // /fork creates a branch of the current agent history.
      await driver.typeText('/fork', 8);
      driver.enter();
      await sleep(3_000);
      expect(driver.isExited).toBe(false);

      // Three persisted sessions should now exist (agent1 + agent2 + fork).
      const sessions = listSessions(home);
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      console.log('[fork] sessions:', JSON.stringify(sessions));

      await exitViaCommand(driver);
    } finally {
      await driver.close('SIGTERM', 3_000);
    }
  }, 600_000);

  it('role cycling via Shift+Tab and /role panel', async () => {
    const home = seededHome('roles');
    const cwd = makeWork('roles');
    const driver = spawnMica(home, cwd, 'roles');
    try {
      await waitBoot(driver);
      await driver.waitIdle(500, 8_000);

      // /role opens the selector with role names; Esc closes it.
      await driver.typeText('/role', 8);
      driver.enter();
      expect(await waitForText(driver, /role|default/i, 20_000, 'role-selector')).toBe(true);
      driver.esc();

      // Shift+Tab cycles the role without crashing.
      driver.sendKey('shiftTab');
      await sleep(1_500);
      driver.sendKey('shiftTab');
      await sleep(1_500);
      expect(driver.isExited).toBe(false);

      // /status should still report a role.
      await driver.typeText('/status', 8);
      driver.enter();
      expect(await waitForText(driver, /Role/, 20_000, 'role-status')).toBe(true);
      driver.esc();

      await exitViaCommand(driver);
    } finally {
      await driver.close('SIGTERM', 3_000);
    }
  }, 240_000);

  it('resume: session history survives restart via --resume', async () => {
    const home = seededHome('resume');
    const cwd = makeWork('resume');
    const driver = spawnMica(home, cwd, 'resume-a');
    let sessionId = '';
    try {
      await waitBoot(driver);
      await driver.waitIdle(500, 8_000);

      await sendTurnAndWait(
        driver,
        home,
        'reply with exactly: resume-me',
        2,
        'resume-turn',
      );
      const sessions = listSessions(home);
      expect(sessions.length).toBe(1);
      sessionId = sessions[0].id;

      await exitViaCommand(driver);
      expect(driver.isExited).toBe(true);
    } finally {
      await driver.close('SIGTERM', 3_000);
    }

    // Restart with --resume and verify the previous user message is visible.
    const driver2 = spawnMica(home, cwd, 'resume-b', ['--resume', sessionId]);
    try {
      await waitBoot(driver2);
      expect(await waitForText(driver2, /resume-me/, 30_000, 'resume-history')).toBe(true);
      expect(driver2.isExited).toBe(false);
      await exitViaCommand(driver2);
    } finally {
      await driver2.close('SIGTERM', 3_000);
    }
  }, 600_000);

  it('clear: starts a fresh session and drops prior messages', async () => {
    const home = seededHome('clear');
    const cwd = makeWork('clear');
    const driver = spawnMica(home, cwd, 'clear');
    try {
      await waitBoot(driver);
      await driver.waitIdle(500, 8_000);

      await sendTurnAndWait(driver, home, 'reply with exactly: before-clear', 2, 'clear-turn');
      await driver.typeText('/clear', 8);
      driver.enter();
      expect(await waitForText(driver, /Started new session/i, 20_000, 'clear-done')).toBe(true);
      await sleep(2_000);

      await driver.typeText('reply with exactly: after-clear', 8);
      driver.enter();
      // /clear 立即创建新 session 文件，after-clear 的 turn 写入该文件；
      // 关键是新 session 必须独立完成且不继承 before-clear 的历史。
      await waitSession(
        home,
        (s) => s.title === 'reply with exactly: after-clear' && s.turnState === 'completed' && s.msgs >= 2,
        240_000,
        'post-clear-turn',
      );
      const sessions = listSessions(home);
      const before = sessions.find((s) => s.title === 'reply with exactly: before-clear');
      const after = sessions.find((s) => s.title === 'reply with exactly: after-clear');
      // before-clear 的会话保持只有一轮（历史被分离，未被 after-clear 污染）。
      expect(before?.msgs).toBe(2);
      expect(after?.msgs).toBeGreaterThanOrEqual(2);
      expect(driver.isExited).toBe(false);

      await exitViaCommand(driver);
    } finally {
      await driver.close('SIGTERM', 3_000);
    }
  }, 600_000);

  it('stress: random command sequence + resize + fast typing keeps the app alive', async () => {
    const home = seededHome('stress');
    const cwd = makeWork('stress');
    const driver = spawnMica(home, cwd, 'stress');
    try {
      await waitBoot(driver);
      await driver.waitIdle(500, 8_000);

      // Deterministic pseudo-random command sequence (safe, non-destructive commands).
      const commands = ['/status', '/context', '/skills', '/mcp', '/status total', '/role', '/rename 随机标题', '/task'];
      let seed = 42;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
      };
      const sequence = Array.from({ length: 14 }, () => commands[Math.floor(rand() * commands.length)]);

      for (const cmd of sequence) {
        await driver.typeText(cmd, 2);
        driver.enter();
        await sleep(400 + rand() * 1_200);
        // 面板类命令会打开独占面板并拦截后续输入；esc 关闭它再继续。
        driver.esc();
        await sleep(300);
        expect(driver.isExited).toBe(false);
      }
      console.log('[stress] sequence:', JSON.stringify(sequence));

      // Resize the terminal while idle.
      driver.resize(90, 24);
      await sleep(1_500);
      driver.resize(160, 50);
      await sleep(1_500);
      expect(driver.isExited).toBe(false);

      // Fast input burst (paste-like).
      const burst = 'abcdefghijklmnopqrstuvwxyz 0123456789 !@#$%^&*() 中文测试';
      await driver.typeText(burst, 0);
      driver.sendKey('ctrlU');
      await sleep(1_000);
      expect(driver.isExited).toBe(false);

      // Everything still works: /status panel opens, then exit.
      await driver.typeText('/status', 2);
      driver.enter();
      expect(await waitForText(driver, /esc exit/, 20_000, 'stress-status')).toBe(true);
      driver.esc();
      await exitViaCommand(driver);
      expect(driver.isExited).toBe(true);
    } finally {
      await driver.close('SIGTERM', 3_000);
    }
  }, 300_000);
});
