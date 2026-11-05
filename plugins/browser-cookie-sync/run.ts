import { deriveSafeStorageKey } from './chrome/cookieCodec.js';
import { applyChromeWrite, readChromeCookies } from './chrome/cookiesDb.js';
import { KeychainDenied, readSafeStorageSecret } from './chrome/keychain.js';
import {
  cookiesPathFor,
  findBrowser,
  isBrowserRunning,
  scanProfiles,
  type ChromeProfile,
  type ChromiumBrowser
} from './chrome/profiles.js';
import { createMicaBrowserClient, type MicaBrowserClient } from './micaBrowser.js';
import { planMerge, type Baseline } from './merge.js';
import { runSync, type SyncSide } from './sync.js';
import type { LastRun } from './state.js';
import type { SyncCookie } from './cookies.js';

/**
 * 一轮同步真正要做的事：把「设置」翻译成两边的读写句柄，跑 `runSync`，把结果整理成
 * 用户能照着做的一两句话。
 *
 * 失败在这里分成可以行动的五类（没授权、没钥匙串、没配置文件、没受控浏览器、数据目录
 * 不存在），调用方据此写健康状态与 attention —— 「同步失败」这四个字对用户没有用。
 */

export type SyncOptions = {
  browserId: string;
  /** 配置文件目录名；空串 = 用浏览器上次用的那个。 */
  profileDir: string;
  toMica: boolean;
  toChrome: boolean;
  writeWhileRunning: boolean;
};

export type SyncFailureCode =
  | 'no-browser'
  | 'no-profile'
  | 'no-access'
  | 'no-keychain'
  | 'no-mica'
  | 'busy'
  | 'unknown';

export class SyncFailure extends Error {
  readonly code: SyncFailureCode;
  readonly hint: string;

  constructor(code: SyncFailureCode, message: string, hint = '') {
    super(message);
    this.name = 'SyncFailure';
    this.code = code;
    this.hint = hint;
  }
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

export function resolveSyncOptions(values: Record<string, string | undefined> = {}): SyncOptions {
  return {
    browserId: String(values.browser || '').trim() || 'chrome',
    profileDir: String(values.profile || '').trim(),
    toMica: flag(values.toMica, true),
    toChrome: flag(values.toChrome, true),
    writeWhileRunning: flag(values.writeWhileRunning, false)
  };
}

export type ChromeTarget = {
  browser: ChromiumBrowser;
  profiles: ChromeProfile[];
  profileDir: string;
  cookiesPath: string;
  running: boolean;
  problem: string;
};

/**
 * 定位 Chrome 与它的 cookie 库。不读钥匙串（那一步可能弹系统授权），只做文件系统的事，
 * 所以面板刷新状态时也可以调它。
 */
export function locateChrome(
  options: SyncOptions,
  {
    home,
    exists,
    listRunning
  }: {
    home?: string;
    exists?: (path: string) => boolean;
    listRunning?: (input: { browser: ChromiumBrowser }) => boolean;
  } = {}
): ChromeTarget {
  const browser = findBrowser(options.browserId);
  const scan = scanProfiles({ browser, ...(home ? { home } : {}) });
  const profileDir = options.profileDir || scan.lastUsedDir;
  if (scan.problem) {
    return {
      browser,
      profiles: scan.profiles,
      profileDir,
      cookiesPath: '',
      running: false,
      problem: scan.problem
    };
  }
  if (!profileDir) {
    return {
      browser,
      profiles: scan.profiles,
      profileDir: '',
      cookiesPath: '',
      running: false,
      problem: `${browser.label} 里还没有任何配置文件`
    };
  }
  const cookiesPath = cookiesPathFor(scan.root, profileDir, exists);
  const running = listRunning ? listRunning({ browser }) : isBrowserRunning({ browser });
  if (!cookiesPath) {
    return {
      browser,
      profiles: scan.profiles,
      profileDir,
      cookiesPath: '',
      running,
      problem: `配置文件 ${profileDir} 里没有 cookie 库（Chrome 可能还没启动过）`
    };
  }
  return { browser, profiles: scan.profiles, profileDir, cookiesPath, running, problem: '' };
}

function chromeSide({ target, key }: { target: ChromeTarget; key: Buffer }): SyncSide {
  return {
    label: `${target.browser.label} · ${target.profileDir}`,
    async read() {
      const result = readChromeCookies({ dbPath: target.cookiesPath, key });
      return result.cookies;
    },
    async write(cookies: SyncCookie[]) {
      applyChromeWrite(target.cookiesPath, { upsert: cookies, remove: [] }, { key });
      return cookies.length;
    },
    async remove(cookies: SyncCookie[]) {
      applyChromeWrite(
        target.cookiesPath,
        { upsert: [], remove: cookies.map((cookie) => ({ host: cookie.host, name: cookie.name, path: cookie.path })) },
        { key }
      );
      return cookies.length;
    }
  };
}

function micaSide(client: MicaBrowserClient): SyncSide {
  return {
    label: '受控浏览器',
    async read() {
      return (await client.listAll()).cookies;
    },
    async write(cookies: SyncCookie[]) {
      return client.setCookies(cookies);
    },
    async remove(cookies: SyncCookie[]) {
      return client.removeCookies(cookies);
    }
  };
}

export type SyncOutcome = {
  dryRun: boolean;
  message: string;
  lastRun: LastRun;
  baseline: Baseline;
  /** 已定位到的 Chrome 目标（面板与状态行要显示它）。 */
  target: ChromeTarget;
  unreadable: number;
};

/**
 * 跑一轮。
 *
 * `resolve` 是面板上「以 Chrome / 以 Mica 为准」：先按选定的一侧写过去，再照常同步一轮
 * ——两件事是同一个动作，用户不必先点选边、再点同步。
 */
export async function performSync({
  options,
  baseline,
  dryRun = false,
  resolve,
  now = () => new Date(),
  client = createMicaBrowserClient(),
  deps = {}
}: {
  options: SyncOptions;
  baseline: Baseline;
  dryRun?: boolean;
  resolve?: { key: string; side: 'chrome' | 'mica' };
  now?: () => Date;
  client?: MicaBrowserClient;
  deps?: {
    home?: string;
    exists?: (path: string) => boolean;
    readSecret?: typeof readSafeStorageSecret;
    listRunning?: (input: { browser: ChromiumBrowser }) => boolean;
  };
}): Promise<SyncOutcome> {
  const target = locateChrome(options, {
    ...(deps.home === undefined ? {} : { home: deps.home }),
    ...(deps.exists === undefined ? {} : { exists: deps.exists }),
    ...(deps.listRunning === undefined ? {} : { listRunning: deps.listRunning })
  });
  if (!target.cookiesPath) {
    throw new SyncFailure(
      'no-profile',
      target.problem || '没有找到可同步的配置文件',
      '在设置里选一个 Chrome 配置文件，或者先打开 Chrome 用一次'
    );
  }
  if (!client.available) {
    throw new SyncFailure(
      'no-mica',
      '受控浏览器不可用：这个宿主里没有 MICA_BROWSER_URL',
      '在桌面应用里打开这个面板（CLI / TUI 没有受控浏览器）'
    );
  }

  const readSecret = deps.readSecret ?? readSafeStorageSecret;
  let key: Buffer;
  try {
    const { secret } = readSecret(target.browser.safeStorage);
    key = deriveSafeStorageKey(secret);
  } catch (error) {
    if (error instanceof KeychainDenied) {
      throw new SyncFailure('no-keychain', error.message, '在出现的钥匙串授权弹窗里点「允许」，或重试一次');
    }
    throw new SyncFailure(
      'no-access',
      error instanceof Error ? error.message : String(error),
      '确认 Chrome 至少登录过一个站点（这样才有这条钥匙串记录）'
    );
  }

  const chrome = chromeSide({ target, key });
  const mica = micaSide(client);

  let unreadable = 0;
  const chromeRead = async (): Promise<SyncCookie[]> => {
    const result = readChromeCookies({ dbPath: target.cookiesPath, key });
    unreadable = result.unreadable;
    return result.cookies;
  };

  const side: SyncSide = { ...chrome, read: chromeRead };

  if (resolve) {
    const [chromeCookies, micaCookies] = await Promise.all([side.read(), mica.read()]);
    const plan = planMerge({
      chrome: chromeCookies,
      mica: micaCookies,
      baseline,
      directions: { toChrome: true, toMica: true }
    });
    const conflict = plan.conflicts.find((entry) => entry.key === resolve.key);
    if (conflict) {
      if (resolve.side === 'chrome') await mica.write([conflict.chrome]);
      else await side.write([conflict.mica]);
    }
  }

  const chromeWritable = target.running
    ? options.writeWhileRunning
      ? { ok: true, note: '' }
      : { ok: false, note: 'Chrome 正开着：写它的 cookie 库要重启才生效，这一轮没有写' }
    : { ok: true, note: '' };

  const result = await runSync({
    chrome: side,
    mica,
    directions: { toChrome: options.toChrome, toMica: options.toMica },
    baseline,
    dryRun,
    chromeWritable,
    now
  });

  if (target.running && options.writeWhileRunning && result.plan.toChrome.length + result.plan.removeFromChrome.length > 0) {
    result.lastRun.notes.push('已写进 Chrome，但要重启 Chrome 才看得到（它把 cookie 常驻在内存里）');
  }
  if (unreadable > 0) {
    result.lastRun.notes.push(`${unreadable} 条 Chrome cookie 解不开（换了密钥或属于别的配置文件），没有参与同步`);
  }
  if (result.lastRun.counts.conflicts > 0) {
    result.lastRun.notes.push(`${result.lastRun.counts.conflicts} 条两边都变过：在「冲突」里选以谁为准`);
  }

  return {
    dryRun,
    message: summarize(result.lastRun, { dryRun, target }),
    lastRun: result.lastRun,
    baseline: result.baseline,
    target,
    unreadable
  };
}

/** 一句话结论：用户点完按钮就想知道「成了没、动了多少」。 */
export function summarize(
  lastRun: LastRun,
  { dryRun, target }: { dryRun: boolean; target?: ChromeTarget }
): string {
  const { counts } = lastRun;
  const scope = target ? `${target.browser.label} · ${target.profileDir}` : '';
  const head = dryRun ? '试算：' : '已同步：';
  const parts = [
    `写 Chrome ${counts.toChrome} 条`,
    `写受控浏览器 ${counts.toMica} 条`,
    `两边各有 ${counts.chrome} / ${counts.mica} 条`
  ];
  if (counts.removedFromChrome + counts.removedFromMica > 0) {
    parts.push(`删掉 ${counts.removedFromChrome + counts.removedFromMica} 条`);
  }
  if (counts.conflicts > 0) parts.push(`${counts.conflicts} 条冲突（未处理）`);
  return `${head}${scope}：${parts.join('，')}`;
}

