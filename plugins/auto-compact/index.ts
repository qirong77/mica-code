import type { MicaPlugin, PluginAgentHandle, PluginContext } from '@packages/mica-plugin/index.js';
import {
  EMPTY_COUNTERS,
  decideAutoCompactStep,
  normalizeCounters,
  settingsFromValues,
  shouldCompactOnReturn,
  shouldEscalateToModel,
  type AutoCompactCounters,
  type AutoCompactStep,
} from './policy.js';

const PLUGIN_ID = 'auto-compact';

/**
 * 自动压缩：每完成一次模型请求就检查一次上下文占用，超过阈值就在「这次请求已经结束、
 * 下一次请求还没发出」的间隙把历史压小，而不是等整个 turn 跑完——长任务里 turn 可能
 * 还要跑几十次请求，等到结束再压缩等于整段都在为膨胀的上下文付费。
 *
 * 四条规则：
 * - 快速压缩：ctx ≥ quickThresholdK 且次数没用完，本地把工具结果 / 工具参数正文 /
 *   媒体块换成占位符（不调用模型、不丢轮次）。
 * - 模型压缩：本地清理后仍 ≥ modelThresholdK 且次数没用完，调用模型生成 checkpoint 摘要。
 * - 节流：两次压缩之间至少间隔 minIntervalMinutes，免得同一段上下文被反复触发。唯一
 *   的例外是同一次触发里「快速 →（清不掉）模型」的升级：它在同一次调用里发生，算一次。
 * - 空闲回来：会话空闲超过 idleMinutes、用户又在输入框里重新敲字时，先压一次快速压缩。
 *   这一条不看阈值——它抢的是「下一轮请求马上就到」的提前量，把压缩从请求里挪到间隙里。
 *
 * 计数存在**会话快照的插件状态**里（`ctx.sessionState`），不是宿主的一张全局表：
 * 一条会话压过几次，是这条会话自己的事实，resume / fork 都该跟着走。设置的默认值在
 * `plugin.json` 里声明，配置页写入 `$MICA_HOME/plugin-settings/auto-compact.json`，
 * 改完立刻生效（读盘带 mtime 缓存），不需要重开会话。
 *
 * 一次性运行（`mica exec`）不压缩：那里没有第二轮，改历史只会改变这一次的开销与结果。
 */
const plugin: MicaPlugin = {
  id: PLUGIN_ID,
  name: 'Auto Compact',
  version: '1.0.0',
  priority: 100,
  required: false,

  setup(ctx: PluginContext) {
    // 清单里 `requires: ["agent"]`，宿主没有这个能力会被 manager 跳过，所以这里必定存在。
    const agentApi = ctx.agent;
    if (!agentApi) throw new Error('auto-compact 需要宿主提供 agent 能力');
    // 启动即校验一次：配置残缺时用户应该马上在插件页看到「待配置」，而不是等到
    // 第一次压缩才发现插件其实没法工作。
    readSettings(ctx);
    // 这条会话最后一次活动的时间：「空闲了多久」就靠它。轮次开始/结束也算活动——
    // 一轮跑了半小时之后紧接着敲字，不该被当成离开了很久。
    let lastActivityAt = seedLastActivity(ctx);

    const registration = agentApi.onIterationRewrite(async (messages, agent) => {
      if (agent.mode === 'one-shot') return null;
      const usage = agent.lastUsage();
      if (!usage) return null;

      const settings = readSettings(ctx);
      if (!settings.enabled) return null;

      const counters = normalizeCounters(agent.getState<AutoCompactCounters>());
      let ctxTokens = usage.inputTokens;
      let step = decideAutoCompactStep({ settings, counters, ctxTokens });
      if (!step) return null;

      let next = messages;
      if (step === 'quick') {
        const quick = await tryCompact(ctx, agent, messages, 'quick', counters);
        if (quick) {
          next = quick.messages;
          ctxTokens = Math.max(0, ctxTokens - quick.savedTokens);
        }
        // 快速压缩失败或没清出东西时 ctx 不变，这里按原 ctx 判定——不会因为它没生效
        // 就把这次模型压缩吞掉。
        step = shouldEscalateToModel({ settings, counters, ctxTokens }) ? 'model' : null;
      }
      if (step === 'model') {
        const model = await tryCompact(ctx, agent, next, 'model', counters);
        if (model) next = model.messages;
      }

      if (next !== messages) agent.setState(counters);
      return next === messages ? null : next;
    });
    ctx.onDispose(() => registration.dispose());

    // 空闲后重新输入。只有「宿主能独占写会话文件 + 有会话级状态」时才成立：`mica exec`
    // 不落盘，TUI 的压缩走 `/compact`。缺这条通路时连订阅都不建，免得每敲一次字都白算。
    if (ctx.sessionState && agentApi.compactIdleHistory) {
      const markActivity = (at: number) => {
        lastActivityAt = at;
        persistState(ctx, {
          ...normalizeCounters(ctx.sessionState!.get()),
          lastActivityAt: new Date(at).toISOString(),
        });
      };
      const events = ctx.events.on('event', (event) => {
        if (event.type !== 'input:activity') return;
        const now = Date.now();
        const idleMs = now - lastActivityAt;
        lastActivityAt = now;
        void compactOnReturn(ctx, agentApi, idleMs, now);
      });
      const turnBefore = ctx.hooks.on('turn:before', () => markActivity(Date.now()));
      const turnAfter = ctx.hooks.on('turn:after', () => markActivity(Date.now()));
      ctx.onDispose(() => {
        events.dispose();
        turnBefore.dispose();
        turnAfter.dispose();
      });
    }

    if (ctx.settings.validate().length === 0) {
      ctx.health.report({ level: 'ok', message: '自动压缩已就绪' });
    }
  },
};

function readSettings(ctx: PluginContext) {
  // 宿主没给会话设置这一面时整插件本该被跳过（`requires: ['sessionSettings']`），
  // 走到这里说明宿主接线漏了：报一次可见的故障，别拿默认值假装正常。
  if (!ctx.sessionSettings) {
    ctx.health.report({
      level: 'error',
      message: '宿主没有提供会话级插件设置，自动压缩按全局默认值工作',
      hint: '这是宿主能力缺失，升级 Mica 后重开会话；会话内的调整不会生效。',
    });
    return settingsFromValues(ctx.settings.get());
  }
  // 读的是本会话生效的值：会话里改过的项覆盖全局设置，其余跟随默认值。
  const settings = settingsFromValues(ctx.sessionSettings.get());
  const issues = ctx.settings.validate();
  if (issues.length > 0) {
    ctx.health.report({
      level: 'warn',
      message: `配置不完整：${issues.map((issue) => `${issue.label} ${issue.message}`).join('；')}`,
      hint: '在配置页的 Plugins → Auto Compact 里补齐。',
    });
  }
  return settings;
}

/**
 * 会话状态里没有活动时间（第一次跑这条会话、或者从更早的版本升上来）时当成「刚刚
 * 活动过」：少压一次无害，把一条刚打开的会话当成空闲三天反而会平白多写一次盘。
 */
function seedLastActivity(ctx: PluginContext): number {
  const parsed = Date.parse(normalizeCounters(ctx.sessionState?.get()).lastActivityAt ?? '');
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function persistState(ctx: PluginContext, value: AutoCompactCounters): void {
  ctx.sessionState?.set(value);
}

/**
 * 用户回来了：会话空闲够久就先做一次快速压缩，让接下来那一轮请求按压小的历史发出。
 *
 * 宿主返回 `null` 表示这次没压成（会话正忙、别的进程持锁、没有可清理的内容），
 * 那也不消耗次数——下一次请求仍按阈值判断。
 */
async function compactOnReturn(
  ctx: PluginContext,
  agentApi: NonNullable<PluginContext['agent']>,
  idleMs: number,
  nowMs: number,
): Promise<void> {
  const compact = agentApi.compactIdleHistory;
  if (!compact) return;
  const settings = readSettings(ctx);
  const counters = normalizeCounters(ctx.sessionState?.get());
  if (!shouldCompactOnReturn({ settings, counters, idleMs, nowMs })) return;

  try {
    const result = await compact();
    if (!result) {
      ctx.logger.info('auto-compact:idle-skipped', { idleMs });
      return;
    }
    // 重新读一次而不是复用上面那份：压缩本身会改会话状态（计数也在里面），
    // 按最新的合并才不会把谁的写入抹掉。
    const next = normalizeCounters(ctx.sessionState?.get());
    next.quickRuns += 1;
    next.lastKind = 'quick';
    next.lastRunAt = new Date(nowMs).toISOString();
    next.lastSavedTokens = result.savedTokens;
    next.lastActivityAt = new Date(nowMs).toISOString();
    persistState(ctx, next);
    ctx.logger.info('auto-compact:idle-applied', { idleMs, savedTokens: result.savedTokens });
    ctx.health.report({
      level: 'ok',
      message: `空闲 ${Math.round(idleMs / 60_000)} 分钟后重新输入，快速压缩省下约 ${result.savedTokens} tokens`,
    });
  } catch (error) {
    // 提前量失败不该影响用户说话：记日志 + 一条可见但不打断的状态。
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('auto-compact:idle-failed', { error: message });
    ctx.health.report({
      level: 'warn',
      message: `空闲后的快速压缩未能生效：${message}`,
      hint: '会话下次请求时仍会按阈值自动压缩；持续出现请查看插件日志。',
    });
  }
}

async function tryCompact(
  ctx: PluginContext,
  agent: PluginAgentHandle,
  messages: unknown[],
  mode: AutoCompactStep,
  counters: AutoCompactCounters,
): Promise<{ messages: unknown[]; savedTokens: number } | null> {
  try {
    const result = await agent.compact(messages, { mode });
    if (mode === 'quick') counters.quickRuns += 1;
    else counters.modelRuns += 1;
    counters.lastKind = mode;
    counters.lastRunAt = new Date().toISOString();
    counters.lastSavedTokens = Math.max(0, Math.round(result.savedTokens) || 0);
    ctx.logger.info('auto-compact:applied', {
      mode,
      savedTokens: counters.lastSavedTokens,
      quickRuns: counters.quickRuns,
      modelRuns: counters.modelRuns,
    });
    ctx.health.report({
      level: 'ok',
      message: `最近一次${{ quick: '快速', model: '模型' }[mode]}压缩省下约 ${counters.lastSavedTokens} tokens`,
    });
    return result;
  } catch (error) {
    // 「没有可清理内容」不是错误，也不消耗次数：下一条请求仍可能清出东西。
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('auto-compact:skipped', { mode, error: message });
    ctx.health.report({
      level: 'warn',
      message: `${mode === 'quick' ? '快速' : '模型'}压缩未能生效：${message}`,
      hint: '次数用尽或上下文里没有可清理的内容时会这样；持续出现请查看插件日志。',
    });
    return null;
  }
}

export { EMPTY_COUNTERS };
export type { AutoCompactCounters, AutoCompactStep };

export default function setup(ctx: PluginContext): void {
  plugin.setup(ctx);
}
