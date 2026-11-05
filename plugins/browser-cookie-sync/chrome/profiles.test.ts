import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  browserDataRoot,
  cookiesPathFor,
  findBrowser,
  isBrowserRunning,
  scanProfiles,
  type ChromiumBrowser
} from './profiles.js';

const chrome = findBrowser('chrome');

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mica-chrome-home-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seedProfile(dir: string, name: string, userName: string): void {
  const root = browserDataRoot(chrome, home);
  mkdirSync(join(root, dir, 'Network'), { recursive: true });
  writeFileSync(join(root, dir, 'Network', 'Cookies'), '');
  writeFileSync(
    join(root, 'Local State'),
    JSON.stringify({ profile: { info_cache: { [dir]: { name, user_name: userName } }, last_used: dir } })
  );
}

describe('browser registry', () => {
  it('resolves the Chrome channels and falls back to Chrome for an unknown id', () => {
    expect(chrome.dataDir).toBe('Google/Chrome');
    expect(chrome.safeStorage).toEqual({ service: 'Chrome Safe Storage', account: 'Chrome' });
    expect(findBrowser('chrome-dev').processName).toBe('Google Chrome Dev');
    expect(findBrowser('nope').id).toBe('chrome');
  });
});

describe('scanProfiles', () => {
  it('reads the profile list and which one was used last', () => {
    seedProfile('Default', '个人', 'me@example.com');
    const scan = scanProfiles({ browser: chrome, home });
    expect(scan.problem).toBe('');
    expect(scan.profiles).toEqual([
      { dir: 'Default', name: '个人', userName: 'me@example.com', lastUsed: true }
    ]);
    expect(scan.lastUsedDir).toBe('Default');
  });

  it('falls back to scanning directories when Local State is unreadable', () => {
    seedProfile('Default', 'x', 'y');
    const scan = scanProfiles({
      browser: chrome,
      home,
      readFile: () => {
        throw Object.assign(new Error('bad json'), { code: 'EBADF' });
      }
    });
    expect(scan.profiles.map((profile) => profile.dir)).toEqual(['Default']);
  });

  it('says what to do when the data directory is blocked by TCC', () => {
    mkdirSync(browserDataRoot(chrome, home), { recursive: true });
    const scan = scanProfiles({
      browser: chrome,
      home,
      listDir: () => {
        throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
      }
    });
    expect(scan.profiles).toEqual([]);
    expect(scan.problem).toContain('全磁盘访问');
  });

  it('reports a missing data directory instead of pretending there are profiles', () => {
    const scan = scanProfiles({ browser: findBrowser('chrome-canary'), home });
    expect(scan.profiles).toEqual([]);
    expect(scan.problem).toContain('没有找到');
  });
});

describe('cookiesPathFor', () => {
  it('prefers the Network subdirectory and accepts the old layout', () => {
    const root = browserDataRoot(chrome, home);
    expect(cookiesPathFor(root, 'Default', () => false)).toBe('');
    mkdirSync(join(root, 'Default'), { recursive: true });
    writeFileSync(join(root, 'Default', 'Cookies'), '');
    expect(cookiesPathFor(root, 'Default')).toBe(join(root, 'Default', 'Cookies'));
    mkdirSync(join(root, 'Default', 'Network'), { recursive: true });
    writeFileSync(join(root, 'Default', 'Network', 'Cookies'), '');
    expect(cookiesPathFor(root, 'Default')).toBe(join(root, 'Default', 'Network', 'Cookies'));
  });
});

describe('isBrowserRunning', () => {
  it('asks pgrep -x with the channel’s process name', () => {
    const seen: string[][] = [];
    const browser: ChromiumBrowser = findBrowser('chrome');
    expect(
      isBrowserRunning({
        browser,
        run: (command, args) => {
          seen.push([command, ...args]);
          return { status: 0 };
        }
      })
    ).toBe(true);
    expect(seen[0]).toEqual(['pgrep', '-x', 'Google Chrome']);
    expect(isBrowserRunning({ browser, run: () => ({ status: 1 }) })).toBe(false);
    expect(
      isBrowserRunning({
        browser,
        run: () => {
          throw new Error('pgrep missing');
        }
      })
    ).toBe(false);
  });
});
