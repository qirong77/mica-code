import type { MicaPlugin, PluginAgentHandle, PluginContext } from '@packages/mica-plugin/index.js';
import { formatTokenCount } from '@packages/mica-common/format.js';
import { isCompactionNotNeededError } from '@packages/mica-context/index.js';
import type { RuntimeTurnBeforeHookEvent, RuntimeTurnAfterHookEvent } from '@packages/mica-runtime/index.js';
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
 * 自动压缩：每次模型请求前按即将发送的历史检查，包括恢复会话后的首个请求。
 * 自动清理保留最近的消息和完整工具批次；摘要保留当前用户轮次，最终回答后不再额外压缩。
 *
 * 四条规则：
 * - 快速压缩：ctx ≥ quickThresholdK 且次数没用完，本地把工具结果 / 工具参数正文 /
 *   媒体块换成占位符（不调用模型、不丢轮次）。
 * - 模型压缩：本地清理后仍 ≥ modelThresholdK 且次数没用完，调用模型生成 checkpoint 摘要。
 * - 节流：**同一轮运行中**两次压缩至少间隔 minIntervalMinutes，免得同一段上下文被模型
 *   反复请求时来回压。跨轮不沿用这个冷却：上一轮压过、这一轮又超阈值就该马上压；空闲
 *   触发也不看它。唯一的例外是同一次触发里「快速 →（清不掉）模型」的升级算一次。
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
    const lifetime = new AbortController();
    ctx.onDispose(() => lifetime.abort());
    const registration = agentApi.onIterationRewrite(async (messages, agent) => {
      if (agent.mode === 'one-shot' || agent.signal?.aborted || lifetime.signal.aborted) return null;
      const settings = readSettings(ctx, agent.owner);
      if (!settings.enabled) return null;

      const counters = normalizeCounters(agent.getState<AutoCompactCounters>());
      let ctxTokens = agent.estimateTokens(messages);
      const beforeTokens = ctxTokens;
      const contextWindowSize = agent.contextWindowSize;
      let step = decideAutoCompactStep({ settings, counters, ctxTokens, contextWindowSize });
      if (!step) return null;
      counters.lastAttemptAt = new Date().toISOString();
      counters.lastAttemptTokens = ctxTokens;
      agent.setState({ ...counters });
      const signal = agent.signal ? AbortSignal.any([agent.signal, lifetime.signal]) : lifetime.signal;

      let next = messages;
      let modelAttempted = false;
      if (step === 'quick') {
        const quick = await tryCompact(ctx, agent, messages, 'quick', counters, signal);
        if (quick) {
          next = quick.messages;
          ctxTokens = agent.estimateTokens(next);
        }
        // 快速压缩失败或没清出东西时 ctx 不变，这里按原 ctx 判定——不会因为它没生效
        // 就把这次模型压缩吞掉。
        step = shouldEscalateToModel({ settings, counters, ctxTokens, contextWindowSize }) ? 'model' : null;
      }
      if (step === 'model' && !signal.aborted) {
        modelAttempted = true;
        ctx.ui?.notice('正在整理较早的上下文，当前任务和最新工具结果会保留…', {
          owner: agent.owner,
          command: 'auto-compact',
          status: 'running',
          surface: 'command_panel',
          variant: 'compact',
        });
        const model = await tryCompact(ctx, agent, next, 'model', counters, signal);
        if (model) next = model.messages;
      }

      if (signal.aborted) {
        if (modelAttempted && !lifetime.signal.aborted)
          ctx.ui?.notice('已取消自动压缩，保留原上下文', {
            owner: agent.owner,
            command: 'auto-compact',
            status: 'info',
            variant: 'compact',
          });
        return null;
      }
      if (next !== messages) {
        agent.setState({ ...counters });
        const afterTokens = agent.estimateTokens(next);
        ctx.ui?.notice(
          `自动压缩：${formatCompactGain(beforeTokens, afterTokens, beforeTokens - afterTokens)}，已保留最近上下文`,
          {
            owner: agent.owner,
            command: 'auto-compact',
            status: 'success',
            variant: 'compact',
          },
        );
      }
      if (modelAttempted && next === messages)
        ctx.ui?.notice('本次自动压缩未生效，继续使用原上下文', {
          owner: agent.owner,
          command: 'auto-compact',
          status: 'warning',
          variant: 'compact',
        });
      return next === messages ? null : next;
    });
    ctx.onDispose(() => registration.dispose());

    // 记录本轮起点：最小间隔只约束同一轮里的重复压缩。没有会话级状态时写不进去，
    // 压缩本身也就没有计数可用；一次性运行整条自动压缩都不生效。
    if (agentApi.mode !== 'one-shot' && ctx.sessionState) {
      const canCompactIdle = Boolean(agentApi.compactIdleHistory);
      const markTurnStart = (owner?: unknown) => {
        const now = Date.now();
        const counters = normalizeCounters(ctx.sessionState!.get(owner));
        counters.turnStartedAt = new Date(now).toISOString();
        // 活动时间只服务空闲触发；宿主没有这条通路时不必每轮多写一次。
        if (canCompactIdle) counters.lastActivityAt = new Date(now).toISOString();
        persistState(ctx, counters, owner);
      };
      const turnBefore = ctx.hooks.on<RuntimeTurnBeforeHookEvent>('turn:before', (event) =>
        markTurnStart(event?.owner),
      );
      const disposers: Array<() => void> = [() => turnBefore.dispose()];

      // 空闲后重新输入。只有「宿主能独占写会话文件」时才成立：`mica exec` 不落盘，
      // TUI 的压缩走 `/compact`。缺这条通路时连订阅都不建，免得每敲一次字都白算。
      if (canCompactIdle) {
        const markActivity = (at: number, owner?: unknown) => {
          persistState(
            ctx,
            {
              ...normalizeCounters(ctx.sessionState!.get(owner)),
              lastActivityAt: new Date(at).toISOString(),
            },
            owner,
          );
        };
        const events = ctx.events.on('event', (event) => {
          if (event.type !== 'input:activity') return;
          const now = Date.now();
          // setup 之后宿主才可能恢复会话，rewind 也会换掉状态；每次从当前快照读取。
          const idleMs = now - seedLastActivity(ctx, event.owner);
          markActivity(now, event.owner);
          void compactOnReturn(ctx, agentApi, idleMs, now, event.owner);
        });
        const turnAfter = ctx.hooks.on<RuntimeTurnAfterHookEvent>('turn:after', (event) =>
          markActivity(Date.now(), event?.owner),
        );
        disposers.push(
          () => events.dispose(),
          () => turnAfter.dispose(),
        );
      }
      ctx.onDispose(() => {
        for (const dispose of disposers) dispose();
      });
    }

    if (ctx.settings.validate().length === 0) {
      ctx.health.report({ level: 'ok', message: '自动压缩已就绪' });
    }
  },
};

function readSettings(ctx: PluginContext, owner?: unknown) {
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
  const settings = settingsFromValues(ctx.sessionSettings.get(owner));
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
function seedLastActivity(ctx: PluginContext, owner?: unknown): number {
  const parsed = Date.parse(normalizeCounters(ctx.sessionState?.get(owner)).lastActivityAt ?? '');
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function persistState(ctx: PluginContext, value: AutoCompactCounters, owner?: unknown): void {
  ctx.sessionState?.set(value, owner);
}

/** 空闲时长的说法：「22 分钟」「3.5 小时」比「1320 分钟」好读。 */
function formatIdle(idleMs: number): string {
  const minutes = idleMs / 60_000;
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  const hours = minutes / 60;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} 小时`;
}

/**
 * 「792.5K → 46.2K（省 94%）」：压缩的效果是「从多少降到多少」，只说省下多少没法判断
 * 这一压值不值——806469 这个数字本身也要换算成 k 才读得出量级。
 */
function formatCompactGain(beforeTokens: number, afterTokens: number, savedTokens: number): string {
  // 取整到 k：notice 是给人扫一眼的，「806K → 46K」比「806.5K → 46.2K」好读。
  const show = (tokens: number) => formatTokenCount(tokens, { roundedThousands: true });
  const drop = `${show(beforeTokens)} → ${show(afterTokens)}`;
  if (beforeTokens <= 0) return drop;
  const ratio = Math.round((savedTokens / beforeTokens) * 100);
  return ratio > 0 && ratio <= 100 ? `${drop}（省 ${ratio}%）` : drop;
}

/**
 * 用户回来了：会话空闲够久就先做一次快速压缩，让接下来那一轮请求按压小的历史发出。
 *
 * 宿主回 `skipped` 表示这次没压成（`busy` 会话正忙 / 别的进程持锁，`empty` 没有可清理
 * 的内容），那也不消耗次数——下一次请求仍按阈值判断。
 */
async function compactOnReturn(
  ctx: PluginContext,
  agentApi: NonNullable<PluginContext['agent']>,
  idleMs: number,
  nowMs: number,
  owner?: unknown,
): Promise<void> {
  const compact = agentApi.compactIdleHistory;
  if (!compact) return;
  const settings = readSettings(ctx, owner);
  const counters = normalizeCounters(ctx.sessionState?.get(owner));
  if (!shouldCompactOnReturn({ settings, counters, idleMs })) return;

  try {
    const outcome = await compact({
      // 计数与提示必须在落盘**之前**写：宿主压缩完就把会话文件写死了，之后写的状态
      // 只能等下一轮才带上——用户可能直接关掉页面，那次压缩就变成「压了但没记账」。
      afterApply: ({ savedTokens, beforeTokens, afterTokens }) => {
        const next = normalizeCounters(ctx.sessionState?.get(owner));
        next.quickRuns += 1;
        next.lastKind = 'quick';
        next.lastRunAt = new Date(nowMs).toISOString();
        next.lastSavedTokens = Math.round(savedTokens) || 0;
        next.lastActivityAt = new Date(nowMs).toISOString();
        persistState(ctx, next, owner);
        // 界面上看得见的一次：否则「到底压没压」只能翻插件日志。
        ctx.ui?.notice(
          `空闲 ${formatIdle(idleMs)}后重新输入，已快速压缩历史：${formatCompactGain(beforeTokens, afterTokens, savedTokens)}`,
          { owner },
        );
      },
    });
    if (outcome.status === 'skipped') {
      ctx.logger.info('auto-compact:idle-skipped', { idleMs, reason: outcome.reason });
      return;
    }
    ctx.logger.info('auto-compact:idle-applied', {
      idleMs,
      savedTokens: outcome.savedTokens,
      beforeTokens: outcome.beforeTokens,
      afterTokens: outcome.afterTokens,
    });
    ctx.health.report({
      level: 'ok',
      message: `空闲 ${formatIdle(idleMs)}后重新输入，已快速压缩历史：${formatCompactGain(outcome.beforeTokens, outcome.afterTokens, outcome.savedTokens)}`,
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

/**
 * 摘要请求：交给 `ctx.llm` 决定发去哪。
 *
 * 没有这条通路（宿主不给 `llm` 能力）时返回 `undefined`，内核退回它默认的摘要子代理——
 * 插件不该因为模型组件缺席就完全不能压缩。
 */
function summarizer(
  ctx: PluginContext,
  owner: unknown,
  signal: AbortSignal,
): ((transcript: string, prompt: string) => Promise<string>) | undefined {
  const llm = ctx.llm;
  if (!llm) return undefined;
  return async (transcript, prompt) => {
    // 关掉「复用当前会话模型」又没填完，就不该悄悄拿会话模型顶上：那是用户明确
    // 表示要用另一个接口。直接给出可读原因，由调用方记进健康状态。
    if (!llm.configured(owner))
      throw new Error('压缩摘要模型未配置：请在插件设置里复用当前会话模型，或填写接口地址与模型');
    const result = await llm.request({
      purpose: '自动压缩摘要',
      system: prompt,
      user: transcript,
      timeoutMs: 120_000,
      owner,
      signal,
    });
    if (!result.text.trim()) throw new Error('压缩摘要请求返回了空内容');
    return result.text;
  };
}

async function tryCompact(
  ctx: PluginContext,
  agent: PluginAgentHandle,
  messages: unknown[],
  mode: AutoCompactStep,
  counters: AutoCompactCounters,
  signal: AbortSignal,
): Promise<{ messages: unknown[]; savedTokens: number } | null> {
  try {
    if (signal.aborted) return null;
    const result = await agent.compact(messages, {
      mode,
      preserveRecentMessages: 8,
      preserveLatestUserMessage: true,
      // 摘要走 `ctx.llm`（清单 `llm` 声明）：默认复用当前会话模型，也可以单独配一个
      // 更便宜的接口；失败会自动降级回会话模型。分段、预算与重试仍归内核。
      summarize: mode === 'model' ? summarizer(ctx, agent.owner, signal) : undefined,
    });
    if (signal.aborted || result.savedTokens <= 0) return null;
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
      message: `最近一次${{ quick: '快速', model: '模型' }[mode]}压缩省下约 ${formatTokenCount(counters.lastSavedTokens)} tokens`,
    });
    return result;
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return null;
    if (isCompactionNotNeededError(error)) {
      ctx.logger.info('auto-compact:not-needed', { mode });
      return null;
    }
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
