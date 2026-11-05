import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserDataRoot, findBrowser } from './chrome/profiles.js';
import { deriveSafeStorageKey } from './chrome/cookieCodec.js';
import { applyChromeWrite, readChromeCookies } from './chrome/cookiesDb.js';
import { execScript } from './chrome/sqlite.js';
import type { MicaBrowserClient } from './micaBrowser.js';
import type { SyncCookie } from './cookies.js';
import { SyncFailure, locateChrome, performSync, resolveSyncOptions, summarize } from './run.js';

const sqliteAvailable = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).status === 0;
const SECRET = 'test-secret';
const KEY = deriveSafeStorageKey(SECRET);
const chrome = findBrowser('chrome');

const SCHEMA = `
CREATE TABLE cookies (
  creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL,
  name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL DEFAULT X'',
  path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL DEFAULT 0,
  is_httponly INTEGER NOT NULL DEFAULT 0, last_access_utc INTEGER NOT NULL,
  has_expires INTEGER NOT NULL DEFAULT 1, is_persistent INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 1, samesite INTEGER NOT NULL DEFAULT -1,
  source_scheme INTEGER NOT NULL DEFAULT 0, source_port INTEGER NOT NULL DEFAULT -1,
  last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL DEFAULT 0,
  has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, name, path);
`;

const cookie = (patch: Partial<SyncCookie> = {}): SyncCookie => ({
  host: 'example.com',
  hostOnly: true,
  name: 'sid',
  path: '/',
  value: 'chrome-value',
  expiresAt: 1_767_225_600,
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  ...patch
});

/** 一个内存版受控浏览器，行为与真实服务的三个端点一致（含服务端规范化后的回读）。 */
function fakeBrowser(initial: SyncCookie[] = []): MicaBrowserClient & { cookies: SyncCookie[] } {
  const state = { cookies: [...initial] };
  const keyOf = (entry: SyncCookie) => `${entry.host}\u0000${entry.path}\u0000${entry.name}`;
  return {
    get cookies() {
      return state.cookies;
    },
    available: true,
    async listAll() {
      return { cookies: [...state.cookies], total: state.cookies.length, truncated: false };
    },
    async setCookies(cookies) {
      for (const entry of cookies) {
        state.cookies = state.cookies.filter((existing) => keyOf(existing) !== keyOf(entry));
        state.cookies.push(entry);
      }
      return cookies.length;
    },
    async removeCookies(cookies) {
      for (const entry of cookies) {
        state.cookies = state.cookies.filter((existing) => keyOf(existing) !== keyOf(entry));
      }
      return cookies.length;
    }
  };
}

let home = '';
let db = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mica-cookie-sync-'));
  const root = browserDataRoot(chrome, home);
  mkdirSync(join(root, 'Default', 'Network'), { recursive: true });
  writeFileSync(
    join(root, 'Local State'),
    JSON.stringify({ profile: { info_cache: { Default: { name: '个人', user_name: 'me@example.com' } }, last_used: 'Default' } })
  );
  db = join(root, 'Default', 'Network', 'Cookies');
  execScript(db, SCHEMA);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** 每次用最新的 `home`：`beforeEach` 才建目录，模块级常量会拿到空串。 */
const baseDeps = () => ({
  home,
  readSecret: () => ({ secret: SECRET, cached: true }),
  listRunning: () => false
});

const options = resolveSyncOptions({});

describe.runIf(sqliteAvailable)('performSync', () => {
  it('copies Chrome cookies into the controlled browser and records the baseline', async () => {
    applyChromeWrite(db, { upsert: [cookie()], remove: [] }, { key: KEY });
    const browser = fakeBrowser();
    const outcome = await performSync({ options, baseline: {}, client: browser, deps: baseDeps() });

    expect(outcome.lastRun.counts).toMatchObject({ chrome: 1, toMica: 1, conflicts: 0 });
    expect(browser.cookies.map((entry) => entry.value)).toEqual(['chrome-value']);
    expect(outcome.message).toContain('Chrome · Default');
    // 基线只存指纹：整份 JSON 里不该出现 cookie 的值
    expect(JSON.stringify(outcome.baseline)).not.toContain('chrome-value');
  });

  it('copies a controlled-browser cookie back into the Chrome database', async () => {
    applyChromeWrite(db, { upsert: [], remove: [] }, { key: KEY });
    const browser = fakeBrowser([cookie({ value: 'mica-value', name: 'from-mica' })]);
    const outcome = await performSync({ options, baseline: {}, client: browser, deps: baseDeps() });

    expect(outcome.lastRun.counts).toMatchObject({ toChrome: 1 });
    const stored = readChromeCookies({ dbPath: db, key: KEY }).cookies;
    expect(stored.map((entry) => entry.name)).toEqual(['from-mica']);
    expect(stored[0]?.value).toBe('mica-value');
  });

  it('runs a second time without touching anything, then pushes a one-sided change', async () => {
    applyChromeWrite(db, { upsert: [cookie()], remove: [] }, { key: KEY });
    const browser = fakeBrowser();
    const first = await performSync({ options, baseline: {}, client: browser, deps: baseDeps() });
    expect(first.lastRun.counts.toMica).toBe(1);

    const second = await performSync({ options, baseline: first.baseline, client: browser, deps: baseDeps() });
    expect(second.lastRun.counts).toMatchObject({ toChrome: 0, toMica: 0, conflicts: 0, unchanged: 1 });

    // 受控浏览器那边改一条：这一轮应当写回 Chrome
    await browser.setCookies([cookie({ value: 'changed-in-mica' })]);
    const third = await performSync({ options, baseline: second.baseline, client: browser, deps: baseDeps() });
    expect(third.lastRun.counts.toChrome).toBe(1);
    expect(readChromeCookies({ dbPath: db, key: KEY }).cookies[0]?.value).toBe('changed-in-mica');
  });

  it('reports a conflict instead of overwriting an account someone changed on both sides', async () => {
    applyChromeWrite(db, { upsert: [cookie()], remove: [] }, { key: KEY });
    const browser = fakeBrowser();
    const first = await performSync({ options, baseline: {}, client: browser, deps: baseDeps() });

    applyChromeWrite(db, { upsert: [cookie({ value: 'chrome-account' })], remove: [] }, { key: KEY });
    await browser.setCookies([cookie({ value: 'mica-account' })]);
    const second = await performSync({ options, baseline: first.baseline, client: browser, deps: baseDeps() });

    expect(second.lastRun.counts.conflicts).toBe(1);
    expect(second.lastRun.conflicts[0]).toMatchObject({ host: 'example.com', name: 'sid' });
    expect(readChromeCookies({ dbPath: db, key: KEY }).cookies[0]?.value).toBe('chrome-account');
    expect(browser.cookies[0]?.value).toBe('mica-account');
    expect(second.lastRun.notes.join(' ')).toContain('冲突');
  });

  it('lets the user pick a side for one conflict', async () => {
    applyChromeWrite(db, { upsert: [cookie({ value: 'a' })], remove: [] }, { key: KEY });
    const browser = fakeBrowser([cookie({ value: 'b' })]);
    const first = await performSync({ options, baseline: {}, client: browser, deps: baseDeps() });
    const key = first.lastRun.conflicts[0]!.key;

    await performSync({
      options: { ...options, toChrome: true },
      baseline: first.baseline,
      client: browser,
      resolve: { key, side: 'mica' },
      deps: baseDeps()
    });
    expect(readChromeCookies({ dbPath: db, key: KEY }).cookies[0]?.value).toBe('b');
  });

  it('only previews when asked, writing neither side', async () => {
    applyChromeWrite(db, { upsert: [cookie()], remove: [] }, { key: KEY });
    const browser = fakeBrowser();
    const outcome = await performSync({ options, baseline: {}, client: browser, dryRun: true, deps: baseDeps() });
    expect(outcome.lastRun.dryRun).toBe(true);
    expect(outcome.lastRun.counts.toMica).toBe(1);
    expect(browser.cookies).toHaveLength(0);
    expect(outcome.message.startsWith('试算：')).toBe(true);
  });

  it('refuses to write Chrome while it is running unless the user said so', async () => {
    const browser = fakeBrowser([cookie({ name: 'from-mica' })]);
    const outcome = await performSync({
      options,
      baseline: {},
      client: browser,
      deps: { ...baseDeps(), listRunning: () => true }
    });
    expect(outcome.lastRun.counts.toChrome).toBe(0);
    expect(outcome.lastRun.notes.join(' ')).toContain('Chrome 正开着');
    expect(readChromeCookies({ dbPath: db, key: KEY }).cookies).toHaveLength(0);
    // 基线沿用上一份：Chrome 关掉之后再同步，这条差异还在
    expect(outcome.baseline).toEqual({});
  });

  it('writes Chrome anyway when the user allowed it, and says a restart is needed', async () => {
    const browser = fakeBrowser([cookie({ name: 'from-mica' })]);
    const outcome = await performSync({
      options: { ...options, writeWhileRunning: true },
      baseline: {},
      client: browser,
      deps: { ...baseDeps(), listRunning: () => true }
    });
    expect(outcome.lastRun.counts.toChrome).toBe(1);
    expect(outcome.lastRun.notes.join(' ')).toContain('重启');
    expect(readChromeCookies({ dbPath: db, key: KEY }).cookies).toHaveLength(1);
  });

  it('explains a missing Chrome profile instead of failing with an empty message', async () => {
    const empty = await performSync({
      options,
      baseline: {},
      client: fakeBrowser(),
      deps: { ...baseDeps(), home: mkdtempSync(join(tmpdir(), 'mica-empty-')) }
    }).catch((error: unknown) => error);
    expect(empty).toBeInstanceOf(SyncFailure);
    expect((empty as SyncFailure).code).toBe('no-profile');
    expect((empty as SyncFailure).hint).toContain('配置文件');
  });

  it('blocks with no-mica when the host has no controlled browser', async () => {
    const outcome = await performSync({
      options,
      baseline: {},
      client: { ...fakeBrowser(), available: false },
      deps: baseDeps()
    }).catch((error: unknown) => error);
    expect((outcome as SyncFailure).code).toBe('no-mica');
  });
});

describe('locateChrome', () => {
  it('picks the profile the browser used last when none is configured', () => {
    const target = locateChrome(options, { home, listRunning: () => false });
    expect(target.profileDir).toBe('Default');
    expect(target.profiles.map((profile) => profile.name)).toEqual(['个人']);
    expect(target.problem).toBe('');
    expect(target.cookiesPath.endsWith(join('Network', 'Cookies'))).toBe(true);
  });

  it('says the chosen profile has no cookie store yet', () => {
    const target = locateChrome(
      { ...options, profileDir: 'Profile 9' },
      { home, exists: () => false, listRunning: () => false }
    );
    expect(target.cookiesPath).toBe('');
    expect(target.problem).toContain('Profile 9');
  });
});

describe('summarize', () => {
  it('states the four directions in one line', () => {
    const text = summarize(
      {
        at: '2026-11-05T10:00:00.000Z',
        dryRun: false,
        counts: {
          chrome: 10,
          mica: 8,
          toChrome: 2,
          toMica: 3,
          removedFromChrome: 0,
          removedFromMica: 1,
          conflicts: 4,
          unchanged: 3
        },
        conflicts: [],
        notes: []
      },
      { dryRun: false }
    );
    expect(text).toContain('受控浏览器 3 条');
    expect(text).toContain('Chrome 2 条');
    expect(text).toContain('删掉 1 条');
    expect(text).toContain('4 条冲突');
  });
});

describe('setting parsing', () => {
  it('defaults to full two-way sync when nothing is configured', () => {
    expect(resolveSyncOptions({})).toMatchObject({ browserId: 'chrome', toMica: true, toChrome: true });
  });

  it('honours the switches and the profile choice', () => {
    expect(
      resolveSyncOptions({ toChrome: 'false', browser: 'chrome-dev', profile: 'Profile 1' })
    ).toMatchObject({ toChrome: false, toMica: true, browserId: 'chrome-dev', profileDir: 'Profile 1' });
  });
});
