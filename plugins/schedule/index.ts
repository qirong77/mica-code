import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { createDwsRunner, resolveDws } from './dws.js';
import { pruneEdits } from './edits.js';
import { mergeRefreshedGroups, refreshSchedules, type RefreshOutcome } from './refresh.js';
import { emptySnapshot, normalizeSnapshot, SCHEDULE_VERSION, type ScheduleSnapshot } from './snapshot.js';

/**
 * `schedule`：把群公告里的开发排期整理成一条时间线，摆在桌面端侧栏里。
 *
 * 数据只在两个时机产生——用户点一下、或者会话在跑时每隔几小时看一眼——因为拿数据的代价
 * 是每个群一次消息导出（一个群 3～4 秒）。所以：
 *
 * - 结果整份写进 `plugin-data/schedule/data.json`，卡片和配置页读同一份；
 * - 多个进程（每个会话一个 app-server）可能同时想整理，靠一个锁文件互斥；
 * - 失败按插件健康状态上报，不静默——「什么都没显示」和「没读到公告」是两件事。
 */

const AUTO_TICK_MS = 10 * 60_000;
const FIRST_TICK_DELAY_MS = 30_000;
const LOCK_STALE_MS = 10 * 60_000;
const MAX_ERRORS = 8;

function settingInt(values: Record<string, string>, key: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(values[key] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 设置里的群清单：一行一个，`#` 开头的行当注释。 */
function parseTargets(value: string | undefined): string[] {
  return (value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function labelTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function readSnapshot(file: string): ScheduleSnapshot {
  try {
    return normalizeSnapshot(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return emptySnapshot();
  }
}

/** 先写临时文件再 rename：卡片随时在读，不能让它读到半份 JSON。 */
function writeSnapshot(file: string, snapshot: ScheduleSnapshot): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * 同一时刻只让一个进程整理。
 *
 * 每个会话各有一个 app-server，后台任务互不相识；没有这把锁，开三个窗口就会把同一批群
 * 导出三遍。锁过期（上一轮崩了）由 `LOCK_STALE_MS` 兜住。
 */
function acquireLock(file: string): boolean {
  mkdirSync(dirname(file), { recursive: true });
  const take = (): boolean => {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };
  if (take()) return true;
  try {
    if (Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS) {
      rmSync(file, { force: true });
      return take();
    }
  } catch {
    // 文件刚好被别人删了：再抢一次
    return take();
  }
  return false;
}

export default function setup(ctx: PluginContext): void {
  const root = join(ctx.paths?.config ?? resolveMicaHome(), 'plugin-data', ctx.pluginId);
  const dataFile = join(root, 'data.json');
  const lockFile = join(root, 'refresh.lock');
  const cacheDir = join(root, 'cache');

  const runRefresh = async (reason: 'manual' | 'auto'): Promise<{ ok: boolean; message: string }> => {
    const values = ctx.settings.get() as Record<string, string>;
    const command = resolveDws(values.dwsPath);
    if (!command) {
      const message = '没找到 dws（D-Chat 命令行）';
      ctx.health.report({
        level: 'error',
        message,
        hint: '在插件设置里填 dws 脚本的绝对路径，或者把 dws 装到 PATH 上。',
      });
      return { ok: false, message };
    }
    if (!acquireLock(lockFile)) {
      return { ok: false, message: '另一个进程正在整理排期，稍后再点' };
    }

    const started = Date.now();
    try {
      mkdirSync(cacheDir, { recursive: true });
      const days = settingInt(values, 'days', 14, 1, 30);
      const outcome: RefreshOutcome = await refreshSchedules({
        run: createDwsRunner(command),
        cacheDir,
        now: new Date(),
        targets: parseTargets(values.groups),
        days,
        activeDays: 7,
        concurrency: 4,
        // 手动那一次要给配置页的按钮留出返回时间（那边 120 秒超时），跑不完就交部分结果；
        // 后台没有这个约束，可以给足时间。
        budgetMs: reason === 'manual' ? 100_000 : 240_000,
      });

      if (outcome.planned === 0 && outcome.errors.length > 0) {
        throw new Error(outcome.errors.map((error) => `${error.name}：${error.message}`).join('；'));
      }
      const scanned = outcome.scanned;
      const release = acquireProcessLock(`${dataFile}.lock`);
      if (!release) throw new Error('排期正在其他窗口保存，请稍后重新整理');
      let snapshot: ScheduleSnapshot;
      try {
        const previous = readSnapshot(dataFile);
        const groups = mergeRefreshedGroups(previous.groups, outcome);
        snapshot = {
          version: SCHEDULE_VERSION,
          updatedAtMs: Date.now(),
          updatedAt: labelTime(new Date()),
          coverage: `扫了 ${scanned} 个群 · ${outcome.groups.length} 个有排期`,
          me: outcome.me,
          scope: { days, scanned, total: outcome.planned, partial: outcome.partial },
          groups,
          errors: outcome.errors.slice(0, MAX_ERRORS),
          // 与页面的版本写入使用同一把锁，读取修订到原子落盘期间不能丢掉另一窗口的修改。
          edits: pruneEdits(groups, previous.edits, previous.groups),
        };
        writeSnapshot(dataFile, snapshot);
      } finally {
        release();
      }
      ctx.logger.info('schedule:refreshed', {
        reason,
        scanned,
        groups: outcome.groups.length,
        errors: outcome.errors.length,
        ms: Date.now() - started,
      });

      if (outcome.errors.length > 0) {
        ctx.health.report({
          level: 'warn',
          message: `${outcome.errors.length} 个群没扫成：${outcome.errors[0]!.name}`,
          hint: '多半是群名写错或那个群没有权限；改完设置再整理一次。',
        });
      } else if (outcome.partial) {
        ctx.health.report({
          level: 'warn',
          message: '本次没扫全，未更新的群保留上次结果',
          hint: '再次刷新可继续检查群公告。',
        });
      } else {
        ctx.health.report({ level: 'ok', message: snapshot.coverage });
      }

      const partial = outcome.partial ? '（时间不够，没扫全）' : '';
      return {
        ok: true,
        message: `${snapshot.coverage}${partial}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error('schedule:refresh-failed', { reason, message });
      ctx.health.report({
        level: 'error',
        message: `整理排期失败：${message}`,
        hint: '确认 D-Chat 客户端在运行、dws 能正常查询群消息。',
      });
      return { ok: false, message };
    } finally {
      rmSync(lockFile, { force: true });
    }
  };

  // 侧栏卡片的「刷新」与配置页的按钮走同一个动作：它不需要会话，所以由一次性进程也能跑。
  ctx.actions?.register('refresh', async () => {
    const result = await runRefresh('manual');
    if (!result.ok) throw new Error(result.message);
    return { message: result.message };
  });

  ctx.background?.register({
    id: 'refresh',
    every: () => AUTO_TICK_MS,
    delay: FIRST_TICK_DELAY_MS,
    run: async () => {
      const values = ctx.settings.get() as Record<string, string>;
      const hours = settingInt(values, 'autoRefreshHours', 6, 0, 168);
      if (hours <= 0) return;
      const snapshot = readSnapshot(dataFile);
      if (snapshot.updatedAtMs > 0 && Date.now() - snapshot.updatedAtMs < hours * 3_600_000) return;
      await runRefresh('auto');
    },
  });

  ctx.logger.info('schedule:ready', { root });
}
