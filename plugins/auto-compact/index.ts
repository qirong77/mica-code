import type { MicaPlugin, PluginAgentHandle, PluginContext } from '@packages/mica-plugin/index.js';
import type { PluginAskHandle, PluginAskQuestion } from '@packages/mica-plugin/index.js';
import { formatTokenCount } from '@packages/mica-common/format.js';
import { isCompactionNotNeededError } from '@packages/mica-context/index.js';
import type {
  RuntimeTurnAfterHookEvent,
  RuntimeTurnBeforeHookEvent,
} from '@packages/mica-runtime/index.js';
import {
  EMPTY_COUNTERS,
  decideAutoCompactStep,
  decideCompactReminder,
  normalizeCounters,
  settingsFromValues,
  shouldEscalateToModel,
  type AutoCompactCounters,
  type AutoCompactStep,
  type CompactReminderKind,
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
 * 只在请求边界**自动**动手：轮次之外（空闲、焦点回到输入框）不主动改历史。那两条抢跑
 * 看起来能白捡一个间隙，实际要么在上下文远未到阈值时白扫几十 MB 历史，要么趁用户还没按
 * 发送就把工具结果换成占位符。轮次之外只有一条路——问一句：会话空闲够久（缓存大概率
 * 已失效）或上下文大到接近窗口时，用 `ctx.ask.post()` 发一张非阻塞的卡片，用户点「现在
 * 压缩」才走一次本地清理（`compactIdleHistory`），不点就什么都不发生。手动入口照旧：
 * 命令面板的「快速压缩（本地）」或 /compact。
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
    /** 这条会话里「用户轮次」所属的 agent：子代理的请求不算刷新了主会话的缓存。 */
    let mainOwner: unknown = null;
    /** 这一轮是否在跑。轮内压缩本来就在动，提醒只在轮次之外问。 */
    let turnRunning = false;
    /** 撤掉当前挂着的那张提醒卡（用户已经开始下一轮时用）。 */
    let dismissReminder: (() => void) | null = null;
    const registration = agentApi.onIterationRewrite(async (messages, agent) => {
      if (agent.mode === 'one-shot' || agent.signal?.aborted || lifetime.signal.aborted) return null;
      const settings = readSettings(ctx, agent.owner);
      const counters = normalizeCounters(agent.getState<AutoCompactCounters>());
      // 提醒要判断「这段历史在缓存里还热着吗」，而缓存是被每一次请求刷新的，所以这里
      // 每个请求都记一笔（只动内存里的插件状态，随本轮 checkpoint 落盘）。
      if (mainOwner === null || agent.owner === mainOwner) {
        if (mainOwner === null && agent.owner) mainOwner = agent.owner;
        counters.lastRequestAt = new Date().toISOString();
        agent.setState({ ...counters });
      }
      if (!settings.enabled) return null;

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
        // 模型摘要要几秒到几十秒，用户多半正好在这时候按发送。开一个维护窗口，宿主
        // 因此告诉客户端「这几秒别急着发」，那条消息留在排队行里（可见、可撤回），
        // 压完再补发——不会被塞进这次请求的历史，也不会混进正在写的摘要。
        // 本地快速压缩不开窗口：它很快，一轮里还可能跑几十次。
        const runModelCompact = () => tryCompact(ctx, agent, next, 'model', counters, signal);
        const model = agent.withMaintenance
          ? await agent.withMaintenance({ reason: 'compaction', label: '自动压缩' }, runModelCompact)
          : await runModelCompact();
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

    // 一次性运行（`mica exec`）没有下一轮：既不用记轮次起点，也不会提醒。
    if (agentApi.mode !== 'one-shot') {
      const turnBefore = ctx.hooks.on<RuntimeTurnBeforeHookEvent>('turn:before', (event) => {
        turnRunning = true;
        if (mainOwner === null && event?.owner) mainOwner = event.owner;
        // 用户已经开始下一轮了，那张「要不要压缩」的卡片已经没有意义：撤掉它，
        // 别让它挂在新一轮的输入框上面继续要一个答案。
        dismissReminder?.();
        if (!ctx.sessionState) return;
        // 记录本轮起点：最小间隔只约束同一轮里的重复压缩。没有会话级状态时写不进去，
        // 压缩本身也就没有计数可用。
        const counters = normalizeCounters(ctx.sessionState.get(event?.owner));
        counters.turnStartedAt = new Date(Date.now()).toISOString();
        persistState(ctx, counters, event?.owner);
      });
      ctx.onDispose(() => turnBefore.dispose());

      const turnAfter = ctx.hooks.on<RuntimeTurnAfterHookEvent>('turn:after', () => {
        turnRunning = false;
      });
      ctx.onDispose(() => turnAfter.dispose());

      const reminder = registerReminder(ctx, agentApi, {
        isTurnRunning: () => turnRunning,
        lifetime: lifetime.signal,
      });
      if (reminder) {
        dismissReminder = reminder.dismiss;
        ctx.onDispose(() => reminder.dispose());
      }
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
 * 轮次之外问一句「要不要压缩」。
 *
 * 为什么要有它：轮内的自动压缩只在请求边界动手，而「你走开了一小时、缓存已经失效」这种
 * 情况根本没有下一轮可等——等到用户再发一句话时，那份大上下文已经按没缓存的价格算完了。
 * 但轮次之外直接压是另一回事：它改写的是用户看得见的历史，得由他点一下。
 *
 * 所以这里只做「提醒」，而且刻意做得很轻：
 * - 走非阻塞的 `ctx.ask.post()`：卡片挂在输入框上方，用户不点就什么都不发生，照常打字；
 *   宿主把它当被动提问（`passive`），不会顶掉任何正在等答案的工具提问；
 * - 只读已经算好的用量与几个时间戳，不扫历史、不起进程（每分钟一次 tick 的代价是一个
 *   对象比较）；
 * - 同一段空闲只问一次：`lastReminderAt` 落在 `lastRequestAt` 之后就不再问，直到有新
 *   请求重新打开这个窗口；
 * - 选的「现在压缩」也只在对话历史本身上做本地清理（`compactIdleHistory`），不调用模型、
 *   不改对话文本。
 *
 * TUI / `mica exec` 没有可点的地方（`ctx.ask` 缺席），那边照旧只有轮内的自动压缩。
 */
function registerReminder(
  ctx: PluginContext,
  agentApi: NonNullable<PluginContext['agent']>,
  deps: { isTurnRunning: () => boolean; lifetime: AbortSignal },
): { dispose: () => void; dismiss: () => void } | null {
  const ask = ctx.ask;
  const compactIdle = agentApi.compactIdleHistory;
  const sessionState = ctx.sessionState;
  if (!ask || !compactIdle || !sessionState) return null;
  /** 挂着的那张卡片：用户开始下一轮时由外面撤掉。 */
  let shown: PluginAskHandle | null = null;

  const remind = async (): Promise<void> => {
    // 一轮在跑时轮内压缩本来就在按阈值动手，再问一句只是打断。
    if (deps.lifetime.aborted || deps.isTurnRunning()) return;
    const settings = readSettings(ctx);
    if (!settings.enabled || !settings.remindEnabled) return;
    const counters = normalizeCounters(sessionState.get());
    const usage = agentApi.lastUsage?.() ?? null;
    const kind = decideCompactReminder({
      settings,
      counters,
      ctxTokens: usage?.inputTokens ?? 0,
      ...(agentApi.contextWindowSize ? { contextWindowSize: agentApi.contextWindowSize } : {}),
    });
    if (!kind) return;

    let handle;
    try {
      handle = ask.post(reminderQuestion(kind, { counters, inputTokens: usage?.inputTokens ?? 0 }), {
        signal: deps.lifetime,
      });
    } catch (error) {
      // 同一个会话一次只显示一个问题：别的插件正问着，这次让开，攒到下一个空闲窗口。
      ctx.logger.info('auto-compact:remind-skipped', { reason: describeError(error) });
      return;
    }
    shown = handle;
    counters.lastReminderAt = new Date().toISOString();
    persistState(ctx, counters);

    const answer = await handle.answered;
    shown = null;
    if (answer.cancelled) return;
    if (!answer.optionIds.includes('compact')) {
      ctx.logger.info('auto-compact:remind-dismissed', { optionIds: answer.optionIds });
      return;
    }
    await compactIdleNow(ctx, sessionState, compactIdle);
  };

  let task: { dispose: () => void } | null = null;
  try {
    task =
      ctx.background?.register({
        id: 'remind',
        // 一分钟问一次「放够了没有」：读的是现成的用量与时间戳，不扫历史也不起进程。
        // 卡片挂着的时候 `remind` 还没返回，下一次 tick 自然不会重入。
        every: 60_000,
        run: remind,
      }) ?? null;
  } catch (error) {
    // 注册失败只该少掉提醒这一条路：轮内自动压缩照旧，别把整个插件 setup 带崩。
    ctx.logger.warn('auto-compact:remind-register-failed', { error: describeError(error) });
  }
  if (!task) return null;
  return {
    dispose: () => {
      task.dispose();
      shown?.dismiss();
      shown = null;
    },
    dismiss: () => {
      shown?.dismiss();
      shown = null;
    },
  };
}

/** 用户点了「现在压缩」：只做本地清理，走宿主那条独占会话的落盘通路。 */
async function compactIdleNow(
  ctx: PluginContext,
  sessionState: NonNullable<PluginContext['sessionState']>,
  compactIdle: NonNullable<NonNullable<PluginContext['agent']>['compactIdleHistory']>,
): Promise<void> {
  let outcome;
  try {
    outcome = await compactIdle({
      afterApply: (result) => {
        // 这个回调抛错会让宿主回滚这次压缩，所以每一步都不能把异常漏出去。
        try {
          const counters = normalizeCounters(sessionState.get());
          counters.quickRuns += 1;
          counters.lastKind = 'quick';
          counters.lastRunAt = new Date().toISOString();
          counters.lastSavedTokens = Math.max(0, Math.round(result.savedTokens));
          sessionState.set(counters);
          ctx.ui?.notice(
            `已清理较早的工具结果：${formatCompactGain(result.beforeTokens, result.afterTokens, result.savedTokens)}，对话内容没动`,
            { command: 'auto-compact', status: 'success', variant: 'compact', replace: true },
          );
        } catch (error) {
          ctx.logger.warn('auto-compact:idle-report-failed', { error: describeError(error) });
        }
      },
    });
  } catch (error) {
    ctx.logger.warn('auto-compact:idle-failed', { error: describeError(error) });
    ctx.ui?.showMessage(`压缩没做成：${describeError(error)}`, 6000);
    return;
  }
  if (outcome.status === 'applied') {
    ctx.logger.info('auto-compact:idle-applied', { savedTokens: outcome.savedTokens });
    return;
  }
  ctx.ui?.showMessage(
    outcome.reason === 'busy' ? '这条会话正忙，等这一轮结束再清理' : '没有可清理的内容：最近的历史里已经没有工具结果',
    6000,
  );
}

function reminderQuestion(
  kind: CompactReminderKind,
  facts: { counters: AutoCompactCounters; inputTokens: number },
): PluginAskQuestion {
  const tokens = formatTokenCount(facts.inputTokens, { roundedThousands: true });
  const title =
    kind === 'idle'
      ? `已经 ${describeIdle(facts.counters.lastRequestAt)}没有请求，缓存大概率已失效`
      : `上下文已经 ${tokens}，快到窗口上限了`;
  const detail =
    kind === 'idle'
      ? `最近一次请求带着约 ${tokens} 上下文。缓存过期之后，下一条消息要把整段历史按原价重算一遍——现在清理一次能把它压小（本地操作，不调模型、不改对话内容）。`
      : `再涨下去，下一次请求要么被截断、要么被迫做摘要。现在清理一次旧工具结果（本地操作，不调模型、不改对话内容），下一条消息按压缩后的历史发送。`;
  return {
    title,
    detail,
    summary: '要不要压缩上下文',
    options: [
      {
        id: 'compact',
        label: '现在压缩',
        description: '把旧工具结果换成占位符，不调用模型',
      },
      { id: 'later', label: '先不压', description: '保持现状，下一条消息照常带完整历史' },
    ],
    // 这是一次「顺手问一句」，不是让你做决定：去掉「2 个方案 · 单选」与底部提示行。
    ui: { meta: false, hint: false },
    timeoutMs: 30 * 60_000,
  };
}

/** 「已经 1 小时没有请求」里的那段时长。 */
function describeIdle(lastRequestAt: string | null): string {
  const since = Date.parse(lastRequestAt ?? '');
  if (!Number.isFinite(since)) return '一段时间';
  const minutes = Math.max(1, Math.round((Date.now() - since) / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
