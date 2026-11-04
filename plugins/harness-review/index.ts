import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { AgentObservationEvent, PluginContext } from '@packages/mica-plugin/index.js';
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
  const root = join(ctx.paths?.config ?? resolveMicaHome(), 'plugin-data', ctx.pluginId);
  const state = readState(root);
  const mode = ctx.agent?.mode === 'one-shot' ? 'one-shot' : 'session';
  const recorder = new HarnessRecorder(
    root,
    (error) => {
      // Do not put the error's potentially sensitive payload into health/log files.
      ctx.logger.error('harness-review:storage-failed', { name: error instanceof Error ? error.name : 'Error' });
      ctx.health.report({ level: 'error', message: '运行记录读写失败', hint: `检查目录权限和磁盘空间：${root}` });
    },
    // 运行来自哪个宿主：桌面端 spawn 的 app-server 才有 desktop 能力。
    { mode, host: ctx.desktop ? 'desktop' : 'cli' },
  );
  const currentCwd = () => ctx.session?.describe()?.cwd ?? process.cwd();

  let refreshing = false;
  const refreshStatus = async (): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    try {
      writeStatus(root, await recorder.review(currentCwd()), state);
    } catch (error) {
      ctx.logger.warn('harness-review:status-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      refreshing = false;
    }
  };

  let rebuilding = false;
  const rebuildIfRulesChanged = async (): Promise<void> => {
    // 一次性宿主（`mica exec`）活几秒，扫全量历史只是白花时间；它记下的运行
    // 会由下一次常驻宿主启动时一起重算。
    if (rebuilding || mode === 'one-shot' || state.classifierVersion === CLASSIFIER_VERSION) return;
    rebuilding = true;
    try {
      await recorder.rebuild();
      state.classifierVersion = CLASSIFIER_VERSION;
      state.lastRebuildAt = new Date().toISOString();
      writeState(root, state);
      // 重算之后页面上的数字与提示点必须立刻跟着变，不能等下一次轮次。
      await refreshStatus();
    } catch (error) {
      ctx.logger.warn('harness-review:rebuild-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      rebuilding = false;
    }
  };
  // 规则变了就重算一次历史：派生数据不该因为改了一行分类就永久失真。
  void rebuildIfRulesChanged();
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
  ctx.onDispose(() => recorder.dispose());

  // 复盘一直没人打开过：`decisions/` 空着就是证据。把状态写进 data.json，
  // 有重复出现又没人处理的问题时在侧栏 Plugins 上点一枚提示点。
  const turnHook = ctx.hooks.on(
    'turn:after',
    () => {
      void rebuildIfRulesChanged();
      // `mica exec` 是一次性运行：复盘扫描是纯开销，那儿只采集。
      if (mode === 'one-shot') return;
      if (Date.now() - (state.lastStatusAt ?? 0) < STATUS_REFRESH_MS) return;
      state.lastStatusAt = Date.now();
      writeState(root, state);
      void refreshStatus();
    },
    { pluginId: ctx.pluginId },
  );
  ctx.onDispose(() => turnHook.dispose());

  ctx.actions?.register('open-review', () => ({
    // 复盘要读报告、挑条目、讲判断——一串要判断的动作交给 agent 做，
    // 这里只把提示词放进输入框，发不发由用户决定。
    newSession: {
      prompt:
        '看一下 harness-review 的运行复盘：先用 harness_review 工具 action=list 读当前工作区的运行指标与问题条目，' +
        '挑出最值得处理的几项，逐项说明证据（哪次运行、哪次调用）、影响和你的判断；' +
        '需要完整证据时用 action=report 导出报告。结论给我，先不要改任何代码。',
      cwd: currentCwd(),
      send: false,
    },
  }));

  const execute = async (input: ToolInput): Promise<unknown> => {
    const action = input.action ?? 'list';
    const cwd = currentCwd();
    if (action === 'list') {
      const report = await recorder.review(cwd);
      // Keep an accumulated review usable inside a model context. The full
      // evidence and all selected runs remain available in the exported report.
      return {
        ...report,
        totalRuns: report.runs.length,
        totalFindings: report.findings.length,
        runs: report.runs.slice(0, 20).map(({ findings: _findings, ...summary }) => summary),
        findings: report.findings.slice(0, 20).map((finding) => ({
          ...finding,
          evidence: finding.evidence.slice(0, 5),
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
      const result = await recorder.prune({ olderThanDays: days, cwd });
      return {
        ...result,
        freedMb: Math.round((result.freedBytes / 1_048_576) * 10) / 10,
        olderThanDays: days,
        displayLimit: `已删除 ${result.deletedRuns} 次运行记录；仍在运行的记录不会删除。人工评估结论保留。`,
      };
    }
    if (action === 'rebuild') {
      // Findings are derived from traces, so a classification fix can be applied
      // to runs recorded before it. Counters and outcomes stay untouched.
      const result = await recorder.rebuild({ cwd });
      return {
        ...result,
        displayLimit: '已按当前规则从轨迹重算历史运行的问题条目；运行指标与人工评估结论不变。',
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
      await recorder.decide(input.id, input.status as ReviewStatus, input.note);
      return { id: input.id, status: input.status, recorded: true };
    }
    throw new Error('action 必须是 list / report / prune / rebuild / assess');
  };

  const tool = ctx.tools!.register(new HarnessReviewTool(execute));
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
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // 状态只是加速，写不进去不影响记录。
  }
}

/**
 * 配置页插件详情读的那份 `data.json`：随时可读的状态 + 只在「点一下就能变好」时的提示点。
 *
 * 只有跨多轮重复出现、且还没人处理过的问题才打扰人——单次失败是噪声，
 * 而一枚点不动的提示点比没有提示更糟。
 */
function writeStatus(root: string, report: ReviewReport, state: PluginState): void {
  const open = report.findings.filter((finding) => finding.status === 'open');
  const recurring = open.filter(
    (finding) => finding.occurrences >= 2 || new Set(finding.evidence.map((item) => item.runId)).size >= 2,
  );
  const lastRun = report.runs.reduce<string | null>(
    (latest, run) => (latest === null || run.startedAt > latest ? run.startedAt : latest),
    null,
  );
  const data: Record<string, unknown> = {
    runs: `${report.runs.length} 次`,
    openFindings: open.length === 0 ? '没有待复盘的问题' : `${open.length} 项`,
    lastRun: lastRun ? `${lastRun} 起` : '尚未记录',
    rebuilt: state.lastRebuildAt ? state.lastRebuildAt : '尚未重算',
  };
  if (recurring.length > 0) {
    data.attention = {
      text: `${recurring.length} 项问题在多轮里重复出现、还没有人复盘`,
      tone: 'warn',
      action: 'open-review',
    };
  }
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'data.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch {
    // 上报失败只影响配置页显示。
  }
}
