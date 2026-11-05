import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Chromium 系浏览器的数据目录与钥匙串项。
 *
 * 只登记**同一套 cookie 库格式**的几个：它们都用 `Network/Cookies` 这个 SQLite 库、
 * 同一种 `v10` 加密（密钥在登录钥匙串里），差别只有目录名、进程名与钥匙串项。
 * Chrome 的四个通道共用同一条钥匙串项（`Chrome Safe Storage` / `Chrome`）。
 */
export type ChromiumBrowser = {
  id: string;
  label: string;
  /** 相对 `~/Library/Application Support` 的目录。 */
  dataDir: string;
  /** 登录钥匙串里的通用密码：service / account 各是什么。 */
  safeStorage: { service: string; account: string };
  /** `pgrep -x` 用的进程名（判断它是不是开着）。 */
  processName: string;
};

export const CHROMIUM_BROWSERS: ChromiumBrowser[] = [
  {
    id: 'chrome',
    label: 'Chrome',
    dataDir: 'Google/Chrome',
    safeStorage: { service: 'Chrome Safe Storage', account: 'Chrome' },
    processName: 'Google Chrome'
  },
  {
    id: 'chrome-beta',
    label: 'Chrome Beta',
    dataDir: 'Google/Chrome Beta',
    safeStorage: { service: 'Chrome Safe Storage', account: 'Chrome' },
    processName: 'Google Chrome Beta'
  },
  {
    id: 'chrome-dev',
    label: 'Chrome Dev',
    dataDir: 'Google/Chrome Dev',
    safeStorage: { service: 'Chrome Safe Storage', account: 'Chrome' },
    processName: 'Google Chrome Dev'
  },
  {
    id: 'chrome-canary',
    label: 'Chrome Canary',
    dataDir: 'Google/Chrome Canary',
    safeStorage: { service: 'Chrome Safe Storage', account: 'Chrome' },
    processName: 'Google Chrome Canary'
  }
];

export const DEFAULT_BROWSER_ID = 'chrome';

export function findBrowser(id: string): ChromiumBrowser {
  const wanted = String(id || '').trim() || DEFAULT_BROWSER_ID;
  return CHROMIUM_BROWSERS.find((entry) => entry.id === wanted) ?? CHROMIUM_BROWSERS[0]!;
}

export function browserDataRoot(browser: ChromiumBrowser, home = homedir()): string {
  return join(home, 'Library', 'Application Support', browser.dataDir);
}

export type ChromeProfile = {
  /** 目录名：`Default` / `Profile 1` / … */
  dir: string;
  /** 界面上显示的名字（Chrome 里给它起的那个）。 */
  name: string;
  userName: string;
  /** Chrome 上一次用的那个配置文件。 */
  lastUsed: boolean;
};

export type ProfileScan = {
  root: string;
  profiles: ChromeProfile[];
  lastUsedDir: string;
  /** 数据目录在但一个配置文件都读不出来时的原因（权限、目录还没建）。 */
  problem: string;
};

const PROFILE_DIR = /^(Default|Profile \d+)$/;

/**
 * 从 `Local State` 读配置文件清单。
 *
 * 读不到时退化成扫目录（只认 `Default` 与 `Profile N`）：`Local State` 是 Chrome 自己
 * 维护的 JSON，偶尔会因为 Chrome 正在写而读不出半个文件，这时至少还能同步一个配置文件。
 * 全磁盘访问没给时这里会拿到 EPERM —— 原样报成 problem，让上面提示去授权。
 */
export function scanProfiles({
  browser,
  home = homedir(),
  readFile = (path: string) => readFileSync(path, 'utf8'),
  listDir = (path: string) => readdirSync(path, { withFileTypes: true }).map((entry) => entry.name),
  exists = existsSync
}: {
  browser: ChromiumBrowser;
  home?: string;
  readFile?: (path: string) => string;
  listDir?: (path: string) => string[];
  exists?: (path: string) => boolean;
}): ProfileScan {
  const root = browserDataRoot(browser, home);
  if (!exists(root)) {
    return {
      root,
      profiles: [],
      lastUsedDir: '',
      problem: `没有找到 ${browser.label} 的数据目录：${root}`
    };
  }

  let info: Record<string, { name?: string; user_name?: string }> = {};
  let lastUsedDir = '';
  try {
    const parsed = JSON.parse(readFile(join(root, 'Local State'))) as {
      profile?: { info_cache?: Record<string, { name?: string; user_name?: string }>; last_used?: string };
    };
    info = parsed?.profile?.info_cache ?? {};
    lastUsedDir = String(parsed?.profile?.last_used || '');
  } catch (error) {
    const code = String((error as { code?: string })?.code || '');
    if (code === 'EPERM' || code === 'EACCES') {
      return {
        root,
        profiles: [],
        lastUsedDir: '',
        problem: '读不到 Chrome 的数据目录（Operation not permitted）：给 Mica 打开「全磁盘访问」后重启应用'
      };
    }
    info = {};
  }

  let dirs = Object.keys(info);
  if (dirs.length === 0) {
    try {
      dirs = listDir(root).filter((name) => PROFILE_DIR.test(name));
    } catch (error) {
      const code = String((error as { code?: string })?.code || '');
      const reason =
        code === 'EPERM' || code === 'EACCES'
          ? '读不到 Chrome 的数据目录（Operation not permitted）：给 Mica 打开「全磁盘访问」后重启应用'
          : `读不出 ${browser.label} 的配置文件：${(error as Error)?.message || String(error)}`;
      return { root, profiles: [], lastUsedDir: '', problem: reason };
    }
  }

  const profiles = dirs
    .map((dir) => ({
      dir,
      name: String(info[dir]?.name || dir),
      userName: String(info[dir]?.user_name || ''),
      lastUsed: dir === lastUsedDir
    }))
    .sort((left, right) => Number(right.lastUsed) - Number(left.lastUsed) || left.dir.localeCompare(right.dir));

  return {
    root,
    profiles,
    lastUsedDir: lastUsedDir || profiles[0]?.dir || '',
    problem: profiles.length === 0 ? `${browser.label} 里还没有任何配置文件` : ''
  };
}

/**
 * 一个配置文件里 cookie 库的位置。
 *
 * Chrome 103 之后在 `Network/` 下面；更老的版本直接在配置文件根目录。两个都试，
 * 是因为用户机器上的 Chrome 什么时候升过级谁也说不准。
 */
export function cookiesPathFor(
  root: string,
  profileDir: string,
  exists: (path: string) => boolean = (path) => existsSync(path)
): string {
  if (!root || !profileDir) return '';
  const candidates = [
    join(root, profileDir, 'Network', 'Cookies'),
    join(root, profileDir, 'Cookies')
  ];
  return candidates.find((path) => exists(path)) ?? '';
}

/** 这个浏览器现在开着没有：Chrome 开着的时候写它的 cookie 库要另说（写入不生效、还要重启才看得到）。 */
export function isBrowserRunning({
  browser,
  run = (command: string, args: string[]) => spawnSync(command, args, { encoding: 'utf8' })
}: {
  browser: ChromiumBrowser;
  run?: (command: string, args: string[]) => { status: number | null; error?: unknown };
}): boolean {
  try {
    const result = run('pgrep', ['-x', browser.processName]);
    return result?.status === 0;
  } catch {
    return false;
  }
}
