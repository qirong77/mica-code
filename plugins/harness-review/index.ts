import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { AgentObservationEvent, PluginContext, PluginObservationEvent } from '@packages/mica-plugin/index.js';
import { CLASSIFIER_VERSION, HarnessRecorder, type CaptureOptions, type ReviewReport } from './engine.js';
import { summarizeProgress } from './progress.js';
import { summarizeList } from './list.js';
import { createConsoleSnapshot } from './console.js';
import { writeConsoleCache } from './console-cache.js';
import manifest from './plugin.json';

const STATUSES = ['open', 'accepted', 'dismissed', 'validated', 'regressed'] as const;
const DEFAULT_CAPTURE: CaptureOptions = { captureContent: true, maxEventChars: 4000, maxEventsPerRun: 2000 };
/** 复盘页面不是每次任务结束都会被打开，状态与提示点按这个间隔对齐一次。 */
const STATUS_REFRESH_MS = 30 * 60 * 1000;
/** Derived UI cache revision; does not change assessment history. */
const STATUS_VIEW_VERSION = 2;
type ReviewStatus = (typeof STATUSES)[number];

/** 插件自己的小状态：上次重算的规则版本、上次刷新状态的时间。 */
type PluginState = { classifierVersion?: number; lastRebuildAt?: string; lastStatusAt?: number };

/** Recording is driven by runtime hooks; it never asks the task model to remember to reflect. */
export default function setup(ctx: PluginContext): void {
  const currentCwd = () => ctx.session?.describe()?.cwd;
  const action = ctx.actions?.register('open-review', (input) => {
    let cwd = input.cwd;
    try {
      cwd ||= currentCwd();
    } catch {
      // A closed session is not a reason to open a review in the host's cwd.
    }
    if (!cwd) return { message: '无法确定复盘工作区，请从工作区会话中打开复盘。' };
    return buildReviewHandoff(ctx, cwd);
  });
  if (action) ctx.onDispose(() => action.dispose());
  if (!ctx.session) return;

  const configHome = ctx.paths?.config ?? resolveMicaHome();
  const root = join(configHome, 'plugin-data', ctx.pluginId);
  const mode = ctx.agent?.mode === 'one-shot' ? 'one-shot' : 'session';
  const recorder = new HarnessRecorder(
    root,
    (error) => {
      // Do not put the error's potentially sensitive payload into health/log files.
      ctx.logger.error('harness-review:storage-failed', { name: error instanceof Error ? error.name : 'Error' });
      ctx.health.report({ level: 'error', message: '运行记录读写失败', hint: `检查目录权限和磁盘空间：${root}` });
    },
    { mode, host: ctx.desktop ? 'desktop' : 'cli', pluginStatus: ctx.pluginStatus },
  );

  let maintenance = Promise.resolve();
  const maintain = <T>(work: () => Promise<T>): Promise<T> => {
    const task = maintenance.then(work);
    maintenance = task.then(
      () => {},
      () => {},
    );
    return task;
  };
  // Replay, scans and rebuilds never hold the short publication lock.
  const publishStatus = async (
    report: ReviewReport,
    patch: Partial<PluginState> = {},
    automatic = false,
  ): Promise<void> => {
    // Reuse the existing global maintenance scan. GET never writes this cache.
    const snapshot = await createConsoleSnapshot(
      {
        pluginId: ctx.pluginId,
        pluginVersion: manifest.version,
        paths: { config: configHome, data: root },
        settings: { get: () => ctx.settings.get() },
        catalog: [],
      },
      report,
      new AbortController().signal,
    );
    const cacheNote = '持久快照仅含已观察及最近装配的插件目录；当前清单和版本由后台只读刷新补齐。';
    if (snapshot.warnings.length < 40) snapshot.warnings.push(cacheNote);
    else snapshot.warnings[snapshot.warnings.length - 1] = cacheNote;
    snapshot.counts.warnings++;
    await withStatusLock(
      root,
      async () => {
        const state = { ...readState(root), ...patch };
        let latestAt = 0;
        try {
          latestAt = Date.parse(JSON.parse(readFileSync(join(root, 'data.json'), 'utf8')).generatedAt) || 0;
        } catch {
          /* absent */
        }
        if (latestAt <= Date.parse(report.generatedAt)) {
          writeStatus(root, report, state);
          try {
            await writeConsoleCache(root, snapshot);
          } catch {
            ctx.logger.warn('harness-review:console-cache-unavailable', { code: 'cache_write_failed' });
          }
        }
        writeState(root, state);
      },
      automatic,
    );
  };
  const refreshStatus = async (): Promise<void> => {
    await publishStatus(await recorder.review());
  };

  const updateStatus = async (afterTurn = false): Promise<void> => {
    if (mode === 'one-shot') return;
    try {
      await maintain(async () => {
        // Another host already does the optional work: skip, do not report a fault.
        const release = acquireProcessLock(join(root, 'refresh.lock'));
        if (!release) return;
        try {
          const state = readState(root);
          const patch: Partial<PluginState> = {};
          let changed = !hasCurrentStatus(root);
          if (state.classifierVersion !== CLASSIFIER_VERSION) {
            await recorder.rebuild();
            patch.classifierVersion = CLASSIFIER_VERSION;
            patch.lastRebuildAt = new Date().toISOString();
            changed = true;
          }
          if (afterTurn && Date.now() - (state.lastStatusAt ?? 0) >= STATUS_REFRESH_MS) changed = true;
          if (!changed) return;
          if (afterTurn) patch.lastStatusAt = Date.now();
          await publishStatus(await recorder.review(), patch, true);
        } finally {
          release();
        }
      });
    } catch (error) {
      ctx.logger.warn('harness-review:status-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  void updateStatus();
  const hook = ctx.hooks.on<AgentObservationEvent>(
    'agent:observe',
    (event) => {
      // Options and session metadata are frozen at run:start. Settings reads may
      // stat the filesystem, so keep them out of the per-event observation path.
      if (event.type !== 'run:start') {
        recorder.observe(event, null, DEFAULT_CAPTURE);
        return;
      }
      try {
        const values = ctx.settings.get();
        if (values.enabled === 'false') return;
        recorder.observe(event, ctx.session?.describe(event.owner) ?? null, {
          captureContent: values.captureContent !== 'false',
          maxEventChars: count(values.maxEventChars, 4000, 200, 20000),
          maxEventsPerRun: count(values.maxEventsPerRun, 2000, 20, 10000),
        });
      } catch {
        // Observing a task must never interrupt it, including settings/session failures.
      }
    },
    { pluginId: ctx.pluginId },
  );
  ctx.onDispose(() => hook.dispose());

  // 插件自己的常驻任务失败不挂在任何一条 run 上（它不在轮次里），但正是最容易「静默坏掉」
  // 的一类：健康状态只留最后一句话，看不出它已经坏了三百次。单独记一条事件流。
  const pluginHook = ctx.hooks.on<PluginObservationEvent>(
    'plugin:observe',
    (event) => recorder.notePluginEvent(event),
    { pluginId: ctx.pluginId },
  );
  ctx.onDispose(() => pluginHook.dispose());
  ctx.onDispose(async () => {
    await maintenance;
    await recorder.dispose();
  });

  // 用户动作是纠正证据，不单凭它判定回答质量；先落盘，再由下一次主运行消费。
  const events: PluginContext['events'] | undefined = ctx.events;
  if (events) {
    try {
      const corrections = events.on('event', (event) => {
        if (event.type !== 'input:corrected') return;
        let sessionId: string | undefined;
        try {
          sessionId = ctx.session?.describe(event.owner)?.id;
        } catch {
          // 会话已关掉 / 拿不到 owner：交给 recorder 判断能不能归属。
          sessionId = undefined;
        }
        recorder.noteCorrection({
          ...(sessionId ? { sessionId } : {}),
          kind: event.kind,
          ...(event.chars === undefined ? {} : { chars: event.chars }),
        });
      });
      ctx.onDispose(() => corrections.dispose());
    } catch (error) {
      // 少一路信号不影响采集与复盘：其余能力照常工作。
      ctx.logger.warn('harness-review:correction-subscription-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const turnHook = ctx.hooks.on(
    'turn:after',
    () => {
      void updateStatus(true);
    },
    { pluginId: ctx.pluginId },
  );
  ctx.onDispose(() => turnHook.dispose());

  const execute = async (input: Record<string, unknown>): Promise<unknown> => {
    const action = input.action ?? 'list';
    const cwd = currentCwd();
    if (!cwd) throw new Error('无法确定复盘工作区，请从工作区会话中打开复盘。');
    if (action === 'list') {
      const report = await recorder.review(cwd);
      // Export this exact snapshot once, not a second scan whose coverage may have moved.
      return summarizeList(report, await recorder.exportReport(cwd, report));
    }
    if (action === 'report') return { path: await recorder.exportReport(cwd) };
    if (action === 'prune') {
      // Manual only: nothing deletes runs on a schedule, and an active run is
      // never removed. Scoped to the current workspace so one project's cleanup
      // cannot drop another project's evidence.
      const days = count(input.days === undefined ? undefined : String(input.days), 30, 1, 3650);
      const result = await maintain(async () => {
        const result = await recorder.prune({ olderThanDays: days, cwd });
        await refreshStatus();
        return result;
      });
      return {
        ...result,
        freedMb: Math.round((result.freedBytes / 1_048_576) * 10) / 10,
        olderThanDays: days,
        displayLimit: `已删除 ${result.deletedRuns} 次运行记录；仍在运行的记录不会删除。人工评估结论保留。`,
      };
    }
    if (action === 'rebuild') {
      // Only derived error counts change; usage, timing and outcomes stay untouched.
      const result = await maintain(async () => {
        const result = await recorder.rebuild({ cwd });
        await publishStatus(await recorder.review(), { lastRebuildAt: new Date().toISOString() });
        return result;
      });
      return {
        ...result,
        displayLimit: '已按当前规则重算问题条目与工具错误/预期退出计数；用量、耗时、终态与人工评估历史不变。',
      };
    }
    if (action === 'assess') {
      if (typeof input.id !== 'string' || !input.id.trim()) throw new Error('assess 需要 review 条目的 id');
      if (!STATUSES.includes(input.status as ReviewStatus)) throw new Error(`status 必须是 ${STATUSES.join(' / ')}`);
      if (typeof input.note !== 'string' || !input.note.trim()) throw new Error('assess 需要人工判断或评估证据 note');
      // Keep mutation scoped to findings visible in the current workspace.
      const report = await recorder.review(cwd);
      if (!report.findings.some((finding) => finding.id === input.id))
        throw new Error('当前工作区没有这个 review 条目');
      await maintain(async () => {
        await recorder.decide(input.id as string, input.status as ReviewStatus, input.note as string, cwd);
        await refreshStatus();
      });
      return { id: input.id, status: input.status, recorded: true };
    }
    throw new Error('action 必须是 list / report / prune / rebuild / assess');
  };

  const command = ctx.commands.register({
    name: 'harness-review',
    description: '查看运行复盘、导出报告，或记录人工评估结论',
    completionItems: [
      { arg: 'list', description: '查看当前工作区的运行与问题条目' },
      { arg: 'report', description: '导出 Markdown 复盘报告' },
      { arg: 'prune', description: 'prune [天数]：删除早于若干天的运行记录（默认 30）' },
      { arg: 'rebuild', description: 'rebuild：按当前规则从轨迹重算历史问题条目' },
      { arg: 'assess', description: 'assess <id> <状态> <判断依据>：记录人工评估' },
    ],
    pluginId: ctx.pluginId,
    scope: 'local-only',
    allowDuringTurn: true,
    async handler(_commandCtx, args) {
      try {
        const [action = 'list', id, status, ...note] = args.trim().split(/\s+/).filter(Boolean);
        // `prune 7` passes the retention window as the first positional argument.
        const data = await execute(
          action === 'prune' ? { action, days: Number(id) } : { action, id, status, note: note.join(' ') },
        );
        const message = JSON.stringify(data, null, 2);
        ctx.ui?.showMessage(message, 12000);
        return { ok: true, message, data };
      } catch (error) {
        const message = error instanceof Error ? error.message : '复盘操作失败';
        ctx.ui?.showMessage(message, 8000);
        return { ok: false, error, message };
      }
    },
  });
  ctx.onDispose(() => command.dispose());
  ctx.logger.info('harness-review:ready', { root });
}

/** 配置页动作先导出一份快照，再把报告路径交给新会话用通用 read_file 阅读。 */
async function buildReviewHandoff(ctx: PluginContext, cwd: string): Promise<{
  newSession: { prompt: string; cwd: string; send: false };
}> {
  if (!ctx.session) {
    return {
      newSession: {
        prompt:
          '请打开 Harness Review 控制台查看当前工作区的运行复盘。使用通用 read_file 读取控制台导出的 Markdown；先检查覆盖范围与统计时间，再总结证据。不要修改代码，也不要代我登记评估结论。',
        cwd,
        send: false,
      },
    };
  }
  const configHome = ctx.paths?.config ?? resolveMicaHome();
  const root = join(configHome, 'plugin-data', 'harness-review');
  const recorder = new HarnessRecorder(root);
  try {
    const report = await recorder.review(cwd);
    const reportPath = await recorder.exportReport(cwd, report);
    return {
      newSession: {
        prompt:
          `复盘报告已经由 Harness Review 导出到：${reportPath}\n` +
          '请用通用的 read_file 工具读取这份 Markdown，先检查覆盖范围与统计时间，再总结近期重复候选、证据、影响和判断。不要修改代码，也不要代我登记评估结论。',
        cwd,
        send: false,
      },
    };
  } finally {
    await recorder.dispose();
  }
}

function count(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function readState(root: string): PluginState {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as PluginState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // 缺失或损坏都按「还没重算过」处理：重建一次不会丢数据。
    return {};
  }
}

function writeState(root: string, state: PluginState): void {
  writeTextFileAtomic(join(root, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

function hasCurrentStatus(root: string): boolean {
  try {
    const data = JSON.parse(readFileSync(join(root, 'data.json'), 'utf8')) as Record<string, unknown>;
    const generatedAt = typeof data.generatedAt === 'string' ? Date.parse(data.generatedAt) : NaN;
    const age = Date.now() - generatedAt;
    return (
      data.scope === '所有工作区' &&
      data.statusViewVersion === STATUS_VIEW_VERSION &&
      age >= 0 &&
      age < STATUS_REFRESH_MS
    );
  } catch {
    return false;
  }
}

async function withStatusLock<T>(root: string, work: () => Promise<T>, skipBusy = false): Promise<T | undefined> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const release = acquireProcessLock(join(root, 'status.lock'));
    if (release) {
      try {
        return await work();
      } finally {
        release();
      }
    }
    if (skipBusy) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('复盘状态正在由其他宿主更新，请稍后重试。');
}

/**
 * 配置页插件详情读的那份 `data.json`：随时可读的状态 + 只在「点一下就能变好」时的提示点。
 *
 * 近期重复与需要复核才提示；历史候选和评估进展仍可见，但不冒充当前故障。
 */
function writeStatus(root: string, report: ReviewReport, state: PluginState): void {
  const progress = summarizeProgress(report.findings);
  // 「已记录运行」与「最近运行」只数用户的一轮：helper（起标题、压缩摘要）跟着每一轮
  // 都会发生、委派子代理也是同一次请求派出去的，算进去会把「跑了 100 次」说成 200 次。
  const userRuns = report.runs.filter((run) => !run.helper && !run.delegation);
  const lastRun = userRuns.reduce<string | null>(
    (latest, run) => (latest === null || run.startedAt > latest ? run.startedAt : latest),
    null,
  );
  const data: Record<string, unknown> = {
    statusViewVersion: STATUS_VIEW_VERSION,
    generatedAt: report.generatedAt,
    scope: '所有工作区',
    runs: `${userRuns.length} 次`,
    openFindings: `${progress.recentRecurring + progress.recentSingle + progress.historicalPending + progress.timeUnknown + progress.needsReview} 项候选（含历史，不等于缺陷数）`,
    recent: `${progress.recentRecurring} 项重复候选；${progress.recentSingle} 项单次信号（最近24小时）`,
    historical: `${progress.historicalPending} 项历史待评估；${progress.timeUnknown} 项时间覆盖不足`,
    assessment: `已接受待验证 ${progress.acceptedPending} 项；已验证待观察 ${progress.validatedWatching} 项；已忽略 ${progress.dismissed} 项`,
    followups: `${progress.needsReview} 项待复核（新证据、基线缺失或人工标记回归）`,
    updated: report.generatedAt,
    window: `${report.coverage.windowStart} — ${report.coverage.windowEnd}`,
    coverage: {
      text: `运行目录 ${report.coverage.totalRunDirectories} 个，已扫描 ${report.coverage.scannedRunDirectories} 个，纳入 ${report.coverage.includedRuns} 条（含委派/helper）；${report.coverage.scanLimitReached || report.coverage.runLimitReached ? '已触及扫描/运行上限，统计不完整' : '未触及扫描/运行上限'}；摘要读取失败 ${report.coverage.unreadableSummaries} 条${report.coverage.directoryReadFailed ? '，运行目录读取失败' : ''}；工具健康排除 ${report.toolHealthCoverage.excludedRuns} 条；推导受限 ${report.derivationCoverage.limitedRuns} 条、覆盖未知 ${report.derivationCoverage.unknownRuns} 条。扫描范围内按真实开始时间选取，非完整历史。`,
      tone:
        report.coverage.scanLimitReached ||
        report.coverage.runLimitReached ||
        report.coverage.unreadableSummaries > 0 ||
        report.coverage.directoryReadFailed ||
        report.toolHealthCoverage.excludedRuns > 0 ||
        report.derivationCoverage.limitedRuns > 0 ||
        report.derivationCoverage.unknownRuns > 0
          ? 'warn'
          : 'ok',
    },
    progress,
    lastRun: lastRun ? `${lastRun} 起` : '尚未记录',
    rebuilt: state.lastRebuildAt ? state.lastRebuildAt : '尚未重算',
  };
  if (progress.recentRecurring > 0 || progress.needsReview > 0) {
    const messages: string[] = [];
    if (progress.recentRecurring > 0)
      messages.push(`最近24小时 ${progress.recentRecurring} 项候选重复出现、尚未登记评估`);
    if (progress.needsReview > 0) messages.push(`${progress.needsReview} 项已有评估的候选待复核`);
    data.attention = {
      text: messages.join('；'),
      tone: 'warn',
      action: 'open-review',
    };
  }
  writeTextFileAtomic(join(root, 'data.json'), `${JSON.stringify(data, null, 2)}\n`);
}
