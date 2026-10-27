import type { MicaPlugin, PluginAgentHandle, PluginContext } from '@packages/mica-plugin/index.js';
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
 * 自动压缩：每完成一次模型请求就检查一次上下文占用，超过阈值就在「这次请求已经结束、
 * 下一次请求还没发出」的间隙把历史压小，而不是等整个 turn 跑完——长任务里 turn 可能
 * 还要跑几十次请求，等到结束再压缩等于整段都在为膨胀的上下文付费。
 *
 * 三条规则：
 * - 快速压缩：ctx ≥ quickThresholdK 且次数没用完，本地把工具结果 / 工具参数正文 /
 *   媒体块换成占位符（不调用模型、不丢轮次）。
 * - 模型压缩：本地清理后仍 ≥ modelThresholdK 且次数没用完，调用模型生成 checkpoint 摘要。
 * - 节流：两次压缩之间至少间隔 minIntervalMinutes，免得同一段上下文被反复触发。唯一
 *   的例外是同一次触发里「快速 →（清不掉）模型」的升级：它在同一次调用里发生，算一次。
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

    if (ctx.settings.validate().length === 0) {
      ctx.health.report({ level: 'ok', message: '自动压缩已就绪' });
    }
  },
};

function readSettings(ctx: PluginContext) {
  const settings = settingsFromValues(ctx.settings.get());
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
