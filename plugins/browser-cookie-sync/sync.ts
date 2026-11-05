import type { SyncCookie } from './cookies.js';
import {
  describeConflict,
  holdChromeOperations,
  nextBaseline,
  planMerge,
  type Baseline,
  type MergePlan,
  type SyncDirections
} from './merge.js';
import type { LastRun } from './state.js';

/**
 * 一轮同步的编排：读两侧 → 三方合并 → 应用 → 回读 → 新基线。
 *
 * 两侧都通过 `SyncSide` 注入，所以这一层不认 Chrome 也不认 Electron：它只做「谁该写什么」。
 * 真正的错误处理留在调用方——读不到 Chrome（没全磁盘访问）、钥匙串被拒、受控浏览器没起来，
 * 三种都要给用户完全不同的下一步。
 */
export type SyncSide = {
  label: string;
  read(): Promise<SyncCookie[]>;
  write(cookies: SyncCookie[]): Promise<number>;
  remove(cookies: SyncCookie[]): Promise<number>;
};

export type RunSyncOptions = {
  chrome: SyncSide;
  mica: SyncSide;
  directions: SyncDirections;
  /** 上一份基线（没有就是空对象）。 */
  baseline: Baseline;
  dryRun?: boolean;
  /**
   * 写 Chrome 的前提条件。`ok: false` 时这一轮只做 Chrome → Mica 方向：
   * Chrome 开着的时候写它的库要重启才生效，还可能被它自己的下一次提交覆盖。
   */
  chromeWritable?: { ok: boolean; note: string };
  now?: () => Date;
};

export type RunSyncResult = {
  plan: MergePlan;
  lastRun: LastRun;
  baseline: Baseline;
};

export async function runSync({
  chrome,
  mica,
  directions,
  baseline,
  dryRun = false,
  chromeWritable = { ok: true, note: '' },
  now = () => new Date()
}: RunSyncOptions): Promise<RunSyncResult> {
  const chromeCookies = await chrome.read();
  const micaCookies = await mica.read();
  const plan = planMerge({ chrome: chromeCookies, mica: micaCookies, baseline, directions });

  const notes: string[] = [];
  if (!chromeWritable.ok) {
    holdChromeOperations(plan, chromeWritable.note || 'Chrome 正开着，这一轮不写它');
  }
  for (const entry of plan.deferred) {
    notes.push(`${entry.reason}（${entry.count} 条）`);
  }

  const counts = (current: MergePlan) => ({
    chrome: chromeCookies.length,
    mica: micaCookies.length,
    toChrome: current.toChrome.length,
    toMica: current.toMica.length,
    removedFromChrome: current.removeFromChrome.length,
    removedFromMica: current.removeFromMica.length,
    conflicts: current.conflicts.length,
    unchanged: current.unchanged
  });

  const base = {
    at: now().toISOString(),
    dryRun,
    counts: counts(plan),
    conflicts: plan.conflicts.map(describeConflict),
    notes
  } satisfies LastRun;

  if (dryRun) {
    return { plan, lastRun: base, baseline };
  }

  if (plan.toMica.length > 0) await mica.write(plan.toMica);
  if (plan.removeFromMica.length > 0) await mica.remove(plan.removeFromMica);
  if (plan.toChrome.length > 0) await chrome.write(plan.toChrome);
  if (plan.removeFromChrome.length > 0) await chrome.remove(plan.removeFromChrome);

  // 回读一遍再记基线：写进去的可能被规范化过（SameSite 大小写、过期时间精度），
  // 按「我们以为写成了什么」记基线，下一轮就会把这条判成「又被改过」。
  const afterChrome = await chrome.read();
  const afterMica = await mica.read();
  return {
    plan,
    lastRun: base,
    baseline: nextBaseline({ plan, chrome: afterChrome, mica: afterMica, previous: baseline })
  };
}

