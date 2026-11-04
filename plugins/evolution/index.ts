import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { MIGRATIONS } from './migrations.js';
import { runEvolution, type EvolutionRunResult } from './run.js';
import { formatStatusTime, writeEvolutionStatus } from './state.js';

/** 默认 30 分钟查一次；有剩余待处理时 5 秒后续跑。 */
const DEFAULT_INTERVAL_MINUTES = 30;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 1440;
const CONTINUE_SOON_MS = 5_000;

/**
 * `evolution`：随版本自动清洗旧数据。
 *
 * mica 的数据形态一直在变（会话字段、用量记录、插件数据布局），运行时代码按要求不为旧形态
 * 保留兼容分支。旧数据因此需要有人就地改写成当前形态——就是这里。
 *
 * 几条刻意的取舍：
 *
 * - **每台机器跑自己那份**：账本在 `$MICA_HOME/plugin-data/evolution/`，不依赖任何远端，
 *   所以另一台装着 mica 的机器升级后不会因为这边已经清洗过而被跳过。
 * - **只读变过的文件**：账本按文件签名（size+mtime）记，日常一轮只是 stat 几百个文件。
 * - **拿到 turn lease 才动文件**：正在跑轮次的会话留给下一轮，绝不和正在写它的进程抢。
 * - **迁移是纯函数**：`migrations.ts` 不碰 IO，因此可以对着固定样本单测；执行、备份、
 *   原子写、分批让出事件循环都在 `run.ts`。
 */
export default function setup(ctx: PluginContext): void {
  // `mica exec` 是一次性运行，没有「下次启动」可言，也不该在别人的一次问答里改写数据。
  if (ctx.agent?.mode === 'one-shot') return;

  const home = ctx.paths?.config ?? resolveMicaHome();
  const dataDir = join(home, 'plugin-data', ctx.pluginId);
  const statusPath = join(dataDir, 'data.json');

  let lastResult: EvolutionRunResult | null = null;
  let running = false;
  /** 「清洗失败」只上报一次，成功一轮就恢复成 ok，不必每轮都写同一句话。 */
  let failureReported = false;

  const enabled = () => readSwitch(ctx.settings.get().enabled, true);
  const backup = () => readSwitch(ctx.settings.get().backup, true);
  const intervalMs = () => {
    const minutes = Number(ctx.settings.get().intervalMinutes);
    if (!Number.isFinite(minutes)) return DEFAULT_INTERVAL_MINUTES * 60_000;
    const clamped = Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, minutes));
    return clamped * 60_000;
  };

  const clean = async (reason: string): Promise<EvolutionRunResult | null> => {
    if (running) return null;
    running = true;
    try {
      const result = await runEvolution({
        home,
        backup: backup(),
        log: (event, detail) => ctx.logger.info(event, { reason, ...detail }),
      });
      if (result.outcome === 'busy') {
        ctx.logger.info('evolution:busy', { reason });
        return null;
      }
      lastResult = result;
      writeEvolutionStatus(statusPath, {
        lastRun: formatStatusTime(result.finishedAt),
        cleaned:
          result.migratedFiles > 0
            ? `${result.migratedFiles} 个会话 · ${result.migratedRecords} 条记录`
            : '没有需要改写的旧数据',
        pending: `${result.pending} 个会话`,
        migrations: `${MIGRATIONS.length} 条规则`,
      });
      if (result.brokenFiles > 0) {
        ctx.logger.warn('evolution:broken', { reason, count: result.brokenFiles });
      }
      if (result.migratedFiles > 0) {
        ctx.logger.info('evolution:cleaned', {
          reason,
          files: result.migratedFiles,
          records: result.migratedRecords,
        });
      }
      if (failureReported) {
        failureReported = false;
        ctx.health.report({ level: 'ok', message: '旧数据清洗恢复正常' });
      }
      return result;
    } catch (error) {
      const message = errorMessage(error);
      ctx.logger.error('evolution:failed', { reason, error: message });
      if (!failureReported) {
        failureReported = true;
        ctx.health.report({
          level: 'error',
          message: `旧数据清洗失败：${message}`,
          hint: '数据没有被改动，下一轮会重试。',
        });
      }
      return null;
    } finally {
      running = false;
    }
  };

  ctx.background?.register({
    id: 'clean',
    // 上一轮还有没处理完的会话时快速续跑，否则按用户的检查间隔。
    every: () => (lastResult && lastResult.pending > 0 ? CONTINUE_SOON_MS : intervalMs()),
    immediate: true,
    run: async () => {
      if (!enabled()) return;
      await clean('background');
    },
  });

  const command = ctx.commands.register({
    name: 'evolution',
    description: '查看旧数据清洗状态，或立刻清洗一次',
    completionItems: [
      { arg: 'status', description: '上次检查时间、待清洗会话与迁移规则' },
      { arg: 'run', description: '立刻把所有会话的旧数据清洗一遍' },
    ],
    scope: 'local-only',
    allowDuringTurn: false,
    pluginId: ctx.pluginId,
    handler: async (_commandCtx, args) => {
      const action = args.trim().toLowerCase();
      if (!action || action === 'status') {
        ctx.ui?.showMessage(describeStatus(lastResult, intervalMs()), 8000);
        return { ok: true };
      }
      if (action === 'run') {
        const result = await clean('command');
        if (!result) {
          ctx.ui?.showMessage('清洗没有开始：上一轮还在跑，或另一个 mica 进程正在处理。');
          return { ok: false, error: new Error('evolution run skipped') };
        }
        ctx.ui?.showMessage(
          result.migratedFiles > 0
            ? `已清洗 ${result.migratedFiles} 个会话，补上 ${result.migratedRecords} 条记录${
                result.pending > 0 ? `；还有 ${result.pending} 个会话等下一轮` : ''
              }。`
            : `没有需要改写的旧数据（检查了 ${result.scanned} 个会话）。`,
          8000,
        );
        return { ok: true };
      }
      ctx.ui?.showMessage('Usage: /evolution [status|run]');
      return { ok: true };
    },
  });
  ctx.onDispose(() => command.dispose());
}

function readSwitch(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value !== 'false';
}

function describeStatus(result: EvolutionRunResult | null, interval: number): string {
  const lines = [
    `迁移规则：${MIGRATIONS.map((migration) => `${migration.id}（${migration.description}）`).join('\n')}`,
    `检查间隔：${Math.round(interval / 60_000)} 分钟`,
  ];
  if (!result) {
    lines.push('本轮进程还没跑过清洗');
  } else {
    lines.push(
      `最近检查：${formatStatusTime(result.finishedAt)}（${result.scanned} 个会话）`,
      `最近清洗：${result.migratedFiles} 个会话 · ${result.migratedRecords} 条记录`,
      `待清洗：${result.pending} 个会话${result.busyFiles > 0 ? `（${result.busyFiles} 个正在跑轮次）` : ''}`,
      `解析不了：${result.brokenFiles} 个会话`,
    );
  }
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
