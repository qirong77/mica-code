import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { AgentObservationEvent, PluginContext } from '@packages/mica-plugin/index.js';
import { MicaTool, type ToolInput } from '@packages/mica-tools/index.js';
import { HarnessRecorder, type CaptureOptions } from './engine.js';

const STATUSES = ['open', 'accepted', 'dismissed', 'validated', 'regressed'] as const;
type ReviewStatus = (typeof STATUSES)[number];

/** Recording is driven by runtime hooks; it never asks the task model to remember to reflect. */
export default function setup(ctx: PluginContext): void {
  const root = join(ctx.paths?.config ?? resolveMicaHome(), 'plugin-data', ctx.pluginId);
  const recorder = new HarnessRecorder(root, (error) => {
    // Do not put the error's potentially sensitive payload into health/log files.
    ctx.logger.error('harness-review:storage-failed', { name: error instanceof Error ? error.name : 'Error' });
    ctx.health.report({ level: 'error', message: '运行记录读写失败', hint: `检查目录权限和磁盘空间：${root}` });
  });
  const currentCwd = () => ctx.session?.describe()?.cwd ?? process.cwd();
  const hook = ctx.hooks.on<AgentObservationEvent>(
    'agent:observe',
    (event) => {
      const values = ctx.settings.get();
      // A setting change takes effect on the next run. The recorder retains a run's initial options.
      if (event.type === 'run:start' && values.enabled === 'false') return;
      const options: CaptureOptions = {
        captureContent: values.captureContent !== 'false',
        maxEventChars: count(values.maxEventChars, 4000, 200, 20000),
        maxEventsPerRun: count(values.maxEventsPerRun, 2000, 20, 10000),
      };
      recorder.observe(event, ctx.session?.describe(event.owner) ?? null, options);
    },
    { pluginId: ctx.pluginId },
  );
  ctx.onDispose(() => hook.dispose());
  ctx.onDispose(() => recorder.dispose());

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
      return JSON.stringify({ error: error instanceof Error ? error.message : '复盘操作失败' });
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
