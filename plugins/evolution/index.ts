import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { DATA_MIGRATIONS } from './data/index.js';
import { MIGRATIONS } from './migrations.js';
import { runEvolution, type EvolutionRunResult } from './run.js';
import { formatStatusTime, writeEvolutionStatus } from './state.js';

/** 启动那一轮还有没洗完的会话时（有宿主正在跑轮次 / 超过单轮上限），5 秒后续跑。 */
const CONTINUE_SOON_MS = 5_000;
/** 续跑轮数上限（约一分钟）：够把一个正常大小的会话目录洗完，又不会变成常驻轮询。 */
const MAX_STARTUP_ROUNDS = 12;

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
 * - **每个进程只洗一次（启动时）**：清洗是「升级之后把旧数据改成当前形态」，不是常驻
 *   轮询。启动后洗完就停——否则一个开着好几天的窗口会定期重扫会话目录，而这些会话早已
 *   由宿主按当前形态写过；更糟的是它会在别的宿主读着同一条会话时改写文件。
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
  // 默认不备份：整份拷贝会让会话目录翻一倍（实测 713MB 备份 / 599MB 会话），而迁移是
  // 幂等的纯函数且有单测。要回滚某次改动时再在设置里临时打开。
  const backup = () => readSwitch(ctx.settings.get().backup, false);
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
      const dataChanged = result.dataFiles.reduce((sum, item) => sum + item.changed, 0);
      writeEvolutionStatus(statusPath, {
        lastRun: formatStatusTime(result.finishedAt),
        cleaned:
          result.migratedFiles > 0 || dataChanged > 0
            ? [
                result.migratedFiles > 0 ? `${result.migratedFiles} 个会话 · ${result.migratedRecords} 条记录` : '',
                dataChanged > 0 ? `${dataChanged} 份数据` : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : '没有需要改写的旧数据',
        pending: `${result.pending} 个会话`,
        migrations: `会话 ${MIGRATIONS.length} 条 · 数据 ${DATA_MIGRATIONS.length} 条`,
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

  let attempts = 0;
  let task: { dispose(): void } | undefined;
  task = ctx.background?.register({
    id: 'startup',
    // 只有「上一轮还没处理完」时才会被再次调度；洗完 / 到达轮数上限就 dispose，
    // 这个进程里不再有第二次定时扫描。
    every: CONTINUE_SOON_MS,
    immediate: true,
    run: async () => {
      if (!enabled()) {
        task?.dispose();
        return;
      }
      attempts += 1;
      const result = await clean('startup');
      if (result?.pending === 0 || attempts >= MAX_STARTUP_ROUNDS) task?.dispose();
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
        ctx.ui?.showMessage(describeStatus(lastResult), 8000);
        return { ok: true };
      }
      if (action === 'run') {
        const result = await clean('command');
        if (!result) {
          ctx.ui?.showMessage('清洗没有开始：上一轮还在跑，或另一个 mica 进程正在处理。');
          return { ok: false, error: new Error('evolution run skipped') };
        }
        const dataChanged = result.dataFiles.reduce((sum, item) => sum + item.changed, 0);
        const parts = [
          result.migratedFiles > 0
            ? `已清洗 ${result.migratedFiles} 个会话，补上 ${result.migratedRecords} 条记录`
            : '',
          dataChanged > 0 ? `改写 ${dataChanged} 份插件数据` : '',
          result.pending > 0 ? `还有 ${result.pending} 个会话等下一轮` : '',
        ].filter(Boolean);
        ctx.ui?.showMessage(
          parts.length > 0 ? `${parts.join('；')}。` : `没有需要改写的旧数据（检查了 ${result.scanned} 个会话）。`,
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

function describeStatus(result: EvolutionRunResult | null): string {
  const lines = [
    '会话迁移：',
    ...MIGRATIONS.map((migration) => `  ${migration.id}：${migration.description}`),
    '数据迁移（每次启动跑一遍）：',
    ...DATA_MIGRATIONS.map((migration) => `  ${migration.id}：${migration.description}`),
  ];
  if (!result) {
    lines.push('本轮进程还没跑过清洗');
  } else {
    const dataChanged = result.dataFiles.reduce((sum, item) => sum + item.changed, 0);
    lines.push(
      `最近检查：${formatStatusTime(result.finishedAt)}（${result.scanned} 个会话）`,
      `最近清洗：${result.migratedFiles} 个会话 · ${result.migratedRecords} 条记录 · ${dataChanged} 份数据`,
      `待清洗：${result.pending} 个会话${result.busyFiles > 0 ? `（${result.busyFiles} 个正在跑轮次）` : ''}`,
      `解析不了：${result.brokenFiles} 个会话`,
    );
  }
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
