import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { AgentObservationEvent, PluginContext, PluginObservationEvent } from '@packages/mica-plugin/index.js';
import { MicaTool, type ToolInput } from '@packages/mica-tools/index.js';
import { CLASSIFIER_VERSION, HarnessRecorder, type CaptureOptions, type ReviewReport } from './engine.js';

const STATUSES = ['open', 'accepted', 'dismissed', 'validated', 'regressed'] as const;
const DEFAULT_CAPTURE: CaptureOptions = { captureContent: true, maxEventChars: 4000, maxEventsPerRun: 2000 };
/** 复盘页面不是每次任务结束都会被打开，状态与提示点按这个间隔对齐一次。 */
const STATUS_REFRESH_MS = 30 * 60 * 1000;
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
    return {
      newSession: {
        prompt:
          '看一下 harness-review 的运行复盘：先用 harness_review 工具 action=list 读当前工作区的运行指标与问题候选，' +
          '挑出最值得处理的几项，逐项说明证据（哪次运行、哪次调用）、影响和你的判断；' +
          '需要完整证据时用 action=report 导出报告。结论给我，先不要改任何代码，也不要代我登记 assess 决定。',
        cwd,
        send: false,
      },
    };
  });
  if (action) ctx.onDispose(() => action.dispose());
  if (!ctx.tools || !ctx.session) return;

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
    const task = maintenance.then(() => withStatusLock(root, work));
    maintenance = task.then(
      () => {},
      () => {},
    );
    return task;
  };
  const refreshStatus = async (): Promise<void> => {
    writeStatus(root, await recorder.review(), readState(root));
  };

  const updateStatus = async (afterTurn = false): Promise<void> => {
    if (mode === 'one-shot') return;
    try {
      await maintain(async () => {
        const state = readState(root);
        let changed = false;
        if (state.classifierVersion !== CLASSIFIER_VERSION) {
          await recorder.rebuild();
          state.classifierVersion = CLASSIFIER_VERSION;
          state.lastRebuildAt = new Date().toISOString();
          changed = true;
        }
        if (!afterTurn && !hasGlobalStatus(root)) changed = true;
        if (afterTurn && Date.now() - (state.lastStatusAt ?? 0) >= STATUS_REFRESH_MS) {
          state.lastStatusAt = Date.now();
          changed = true;
        }
        if (!changed) return;
        writeStatus(root, await recorder.review(), state);
        writeState(root, state);
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

  const execute = async (input: ToolInput): Promise<unknown> => {
    const action = input.action ?? 'list';
    const cwd = currentCwd();
    if (!cwd) throw new Error('无法确定复盘工作区，请从工作区会话中打开复盘。');
    if (action === 'list') {
      const report = await recorder.review(cwd);
      // Keep an accumulated review usable inside a model context. The full
      // evidence and all selected runs remain available in the exported report.
      // helper 运行（起标题、压缩摘要）跟着每一轮都发生：混进「最近 20 次」会把真正的一轮
      // 挤出去，它们已经由 report.helpers 按来源汇总。
      const userRuns = report.runs.filter((run) => !run.helper);
      return {
        ...report,
        totalRuns: userRuns.length,
        totalFindings: report.findings.length,
        runs: userRuns.slice(0, 20).map(({ findings: _findings, ...summary }) => summary),
        // 52 个工具一次全塞进上下文没有意义：按失败率排过序，前 15 个就是要看的那些。
        toolHealth: report.toolHealth.slice(0, 15),
        findings: report.findings.slice(0, 20).map((finding) => ({
          ...finding,
          evidence: finding.evidence.slice(0, 5),
          ...(finding.assessments
            ? {
                assessmentCount: finding.assessments.length,
                assessments: finding.assessments.slice(-3),
              }
            : {}),
        })),
        displayLimit: '最多显示最近 20 次运行与 20 项问题，每项 5 条证据；report 导出完整复盘。',
      };
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
        writeState(root, { ...readState(root), lastRebuildAt: new Date().toISOString() });
        await refreshStatus();
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

  const tool = ctx.tools.register(new HarnessReviewTool(execute));
  ctx.onDispose(() => tool.dispose());
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

export class HarnessReviewTool extends MicaTool {
  constructor(private readonly run: (input: ToolInput) => Promise<unknown>) {
    super(
      'harness_review',
      '按用户要求查看当前工作区的 agent 运行复盘。list 返回运行指标与有证据的问题候选；report 导出 Markdown 报告；assess 记录用户的 review 或外部评估结论（需要 id、status、note）。accepted 仅代表认可建议；validated/regressed 需要在 note 写明实际验证证据。记录和聚合自动完成，无需任务结束后调用。不会修改 system prompt、工具、记忆或执行任何评测。',
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'report', 'prune', 'rebuild', 'assess'],
            description: '默认 list',
          },
          id: { type: 'string', description: 'assess：问题条目 id' },
          status: { type: 'string', enum: [...STATUSES] },
          note: { type: 'string', description: 'assess：用户判断依据，或实际评估方法与结果' },
          days: { type: 'number', description: 'prune：保留最近多少天的运行记录，默认 30' },
        },
      },
    );
  }

  async execute(input: ToolInput): Promise<string> {
    try {
      return JSON.stringify(await this.run(input), null, 2);
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '复盘操作失败' });
    }
  }

  onToolUseDisplayText(input: ToolInput): string {
    return `Harness review: ${String(input.action ?? 'list')}`;
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

function hasGlobalStatus(root: string): boolean {
  try {
    const data = JSON.parse(readFileSync(join(root, 'data.json'), 'utf8')) as Record<string, unknown>;
    return data.scope === '所有工作区';
  } catch {
    return false;
  }
}

async function withStatusLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const release = acquireProcessLock(join(root, 'status.lock'));
    if (release) {
      try {
        return await work();
      } finally {
        release();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('复盘状态正在由其他宿主更新，请稍后重试。');
}

/**
 * 配置页插件详情读的那份 `data.json`：随时可读的状态 + 只在「点一下就能变好」时的提示点。
 *
 * 只有跨多轮重复出现、且尚未登记评估的问题候选才打扰人——单次失败是噪声，
 * 而一枚点不动的提示点比没有提示更糟。
 */
function writeStatus(root: string, report: ReviewReport, state: PluginState): void {
  const open = report.findings.filter((finding) => finding.status === 'open');
  const recurring = open.filter(
    (finding) => finding.occurrences >= 2 || new Set(finding.evidence.map((item) => item.runId)).size >= 2,
  );
  const followups = report.findings.filter((finding) => finding.reviewNeeded || finding.status === 'regressed');
  // 「已记录运行」与「最近运行」只数用户的一轮：helper（起标题、压缩摘要）跟着每一轮
  // 都会发生、委派子代理也是同一次请求派出去的，算进去会把「跑了 100 次」说成 200 次。
  const userRuns = report.runs.filter((run) => !run.helper && !run.delegation);
  const lastRun = userRuns.reduce<string | null>(
    (latest, run) => (latest === null || run.startedAt > latest ? run.startedAt : latest),
    null,
  );
  const data: Record<string, unknown> = {
    scope: '所有工作区',
    runs: `${userRuns.length} 次`,
    openFindings: open.length + followups.length === 0 ? '没有待复盘的问题' : `${open.length + followups.length} 项`,
    lastRun: lastRun ? `${lastRun} 起` : '尚未记录',
    rebuilt: state.lastRebuildAt ? state.lastRebuildAt : '尚未重算',
  };
  if (recurring.length > 0 || followups.length > 0) {
    data.attention = {
      text:
        followups.length > 0
          ? `${followups.length} 项已有评估的问题待复核（新证据、历史基线缺失或人工标记回归）`
          : `${recurring.length} 项问题候选重复出现、尚未登记评估`,
      tone: 'warn',
      action: 'open-review',
    };
  }
  writeTextFileAtomic(join(root, 'data.json'), `${JSON.stringify(data, null, 2)}\n`);
}
