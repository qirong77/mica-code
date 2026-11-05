import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LastRun, SyncState } from './state.js';

/**
 * `plugin-data/browser-cookie-sync/data.json`：配置页「运行状态」那几行 + 面板要用的缓存。
 *
 * 面板刷新时必须只看这个文件、不去碰文件系统：它每打开一次、每切一次分区都会取一次视图，
 * 在那里读 Chrome 的 `Local State`、问钥匙串，等于让「看一眼」变成一次探测。真正的探测
 * 只在同步那一下做，结果顺手缓存进来（配置文件清单就是为面板的下拉框缓存的那份）。
 */

export const DATA_FILE = 'data.json';

export type StatusTone = 'ok' | 'warn' | 'error';

export type CachedProfile = { dir: string; name: string };

export type Attention = { text: string; tone: 'warn' | 'error'; action?: string } | null;

export type PluginData = {
  /** 正在同步的是哪个浏览器与配置文件。 */
  target?: { text: string; tone?: StatusTone };
  /** 上一次同步的时间与结论。 */
  lastRun?: { text: string; tone?: StatusTone };
  /** 四个方向的计数。 */
  counts?: { text: string; tone?: StatusTone };
  /** 全磁盘访问 / 钥匙串的状态。 */
  access?: { text: string; tone?: StatusTone };
  /** 面板下拉框用的配置文件清单（上次探测的结果）。 */
  profiles?: CachedProfile[];
  /** 面板与侧栏红点读的冲突清单（按 key 定位，不含 cookie 值）。 */
  conflicts?: LastRun['conflicts'];
  /** 上次同步的完整结果（`notes` 在面板里按行显示）。 */
  notes?: string[];
  /** 得有人点一下才会好的事（钥匙串被拒）；能自己好起来的（Chrome 开着）不写这里。 */
  attention?: Attention;
  /** 面板开关的取值：与设置文件同源，读不到设置时用它兜底。 */
  options?: Record<string, string>;
};

export function dataFilePath(dataDir: string): string {
  return join(dataDir, DATA_FILE);
}

export function readPluginData(dataDir: string): PluginData {
  try {
    const parsed = JSON.parse(readFileSync(dataFilePath(dataDir), 'utf8')) as PluginData;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writePluginData(dataDir: string, next: PluginData): void {
  const file = dataFilePath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** 读改写一次：两个入口（面板动作与后台那一轮）都会写它。 */
export function updatePluginData(dataDir: string, patch: Partial<PluginData>): PluginData {
  const next = { ...readPluginData(dataDir), ...patch };
  writePluginData(dataDir, next);
  return next;
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 上一次同步 → 状态行上的那一句话。 */
export function describeLastRun(state: SyncState): { text: string; tone: StatusTone } {
  const run = state.lastRun;
  if (!run) return { text: '还没同步过', tone: 'warn' };
  const { counts } = run;
  const moved = counts.toChrome + counts.toMica + counts.removedFromChrome + counts.removedFromMica;
  const tone: StatusTone = counts.conflicts > 0 ? 'warn' : moved > 0 ? 'ok' : 'ok';
  const head = `${clock(run.at)} ${run.dryRun ? '试算' : '同步'}`;
  return {
    text:
      `${head}：写 Chrome ${counts.toChrome}、写受控浏览器 ${counts.toMica}、` +
      `删 ${counts.removedFromChrome + counts.removedFromMica}、冲突 ${counts.conflicts}`,
    tone
  };
}

export function describeCounts(state: SyncState): { text: string; tone: StatusTone } {
  const run = state.lastRun;
  if (!run) return { text: '—', tone: 'warn' };
  return {
    text: `Chrome ${run.counts.chrome} 条 · 受控浏览器 ${run.counts.mica} 条 · 一致 ${run.counts.unchanged} 条`,
    tone: 'ok'
  };
}
