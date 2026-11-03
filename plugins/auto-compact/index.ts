import type { MicaPlugin, PluginAgentHandle, PluginContext } from '@packages/mica-plugin/index.js';
import { formatTokenCount } from '@packages/mica-common/format.js';
import { isCompactionNotNeededError } from '@packages/mica-context/index.js';
import type { RuntimeTurnBeforeHookEvent } from '@packages/mica-runtime/index.js';
import {
  EMPTY_COUNTERS,
  decideAutoCompactStep,
  normalizeCounters,
  settingsFromValues,
  shouldEscalateToModel,
  type AutoCompactCounters,
  type AutoCompactStep,
} from './policy.js';

const PLUGIN_ID = 'auto-compact';

/**
 * 自动压缩：每次模型请求前按即将发送的历史检查，包括恢复会话后的首个请求。
 * 自动清理保留最近的消息和完整工具批次；摘要保留当前用户轮次，最终回答后不再额外压缩。
 *
 * 三条规则：
 * - 快速压缩：ctx ≥ quickThresholdK 且次数没用完，本地把工具结果 / 工具参数正文 /
 *   媒体块换成占位符（不调用模型、不丢轮次）。
 * - 模型压缩：本地清理后仍 ≥ modelThresholdK 且次数没用完，调用模型生成 checkpoint 摘要。
 * - 节流：**同一轮运行中**两次压缩至少间隔 minIntervalMinutes，免得同一段上下文被模型
 *   反复请求时来回压。跨轮不沿用这个冷却：上一轮压过、这一轮又超阈值就该马上压。唯一
 *   的例外是同一次触发里「快速 →（清不掉）模型」的升级算一次。
 *
 * 只在请求边界动手：轮次之外（空闲、焦点回到输入框）一律不压。那两条抢跑看起来能白捡
 * 一个间隙，实际要么在上下文远未到阈值时白扫几十 MB 历史，要么趁用户还没按发送就把工具
 * 结果换成占位符。压不压交给用户手动触发：命令面板的「快速压缩（本地）」或 /compact。
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
      let modelApplied = false;
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
        if (model) {
          next = model.messages;
          modelApplied = true;
        }
      }

      if (signal.aborted) {
        if (modelAttempted && !lifetime.signal.aborted)
          ctx.ui?.notice('已取消自动压缩，保留原上下文', {
            owner: agent.owner,
            command: 'auto-compact',
            status: 'info',
            variant: 'compact',
            replace: true,
          });
        return null;
      }
      if (next !== messages) agent.setState({ ...counters });
      // 只有模型摘要真的改写了历史才提示：本地清理（把工具结果换成占位符）是一轮里可能
      // 发生几十次的例行整理，它不改用户看到的对话，逐次提示只会在对话里排出一列卡片。
      if (modelApplied) {
        const afterTokens = agent.estimateTokens(next);
        ctx.ui?.notice(
          `自动压缩：${formatCompactGain(beforeTokens, afterTokens, beforeTokens - afterTokens)}，已保留最近上下文`,
          {
            owner: agent.owner,
            command: 'auto-compact',
            status: 'success',
            variant: 'compact',
            replace: true,
          },
        );
      }
      if (modelAttempted && next === messages)
        ctx.ui?.notice('本次自动压缩未生效，继续使用原上下文', {
          owner: agent.owner,
          command: 'auto-compact',
          status: 'warning',
          variant: 'compact',
          replace: true,
        });
      return next === messages ? null : next;
    });
    ctx.onDispose(() => registration.dispose());

    // 记录本轮起点：最小间隔只约束同一轮里的重复压缩。没有会话级状态时写不进去，
    // 压缩本身也就没有计数可用；一次性运行整条自动压缩都不生效。
    if (agentApi.mode !== 'one-shot' && ctx.sessionState) {
      const turnBefore = ctx.hooks.on<RuntimeTurnBeforeHookEvent>('turn:before', (event) => {
        const counters = normalizeCounters(ctx.sessionState!.get(event?.owner));
        counters.turnStartedAt = new Date(Date.now()).toISOString();
        persistState(ctx, counters, event?.owner);
      });
      ctx.onDispose(() => turnBefore.dispose());
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

function persistState(ctx: PluginContext, value: AutoCompactCounters, owner?: unknown): void {
  ctx.sessionState?.set(value, owner);
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
