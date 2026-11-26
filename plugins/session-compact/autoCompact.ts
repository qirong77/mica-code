import { formatTokenCount } from '@packages/mica-common/format.js';

/**
 * 自动压缩的策略层：什么时候触发、两条消息写什么、交接文档从哪儿读回来。
 *
 * 这里不碰宿主：判断都是纯函数，接线（hooks / 后台 tick / 落盘）在 index.ts。
 * 分开写是因为「什么时候该压」和「怎么压」是两件事——前者要能单测，后者归宿主。
 *
 * 流程是一条可见交接的流水线：
 *   1. 最近一次请求的输入超过阈值 → 以插件身份发一条「暂停并写交接文档」；
 *   2. 交接那一轮结束 → 快速压缩（只折工具过程）；
 *   3. 快速压缩后估算仍高于模型压缩阈值 → 再做一次模型压缩（checkpoint 摘要）；
 *   4. 压缩完发一条「继续」，让模型按交接文档里的待办接着做。
 */

/** 两条自动消息都以此开头：识别「这一轮是我们自己发的」，不必把整段正文存进状态。 */
export const HANDOFF_MARKER = '［Mica 自动压缩］';
export const RESUME_MARKER = '［Mica 自动压缩·继续］';

export const DEFAULT_THRESHOLD_TOKENS = 400_000;
export const DEFAULT_MODEL_COMPACT_TOKENS = 100_000;
export const DEFAULT_MIN_INTERVAL_MINUTES = 10;

/** 连续失败到这个次数就停下：压不动还反复触发只会一直烧钱。 */
export const MAX_FAILURES = 3;

/**
 * 窗口占比的硬上限。
 *
 * 用户填的是绝对阈值（400K），但模型窗口可能只有 200K：等到 400K 时请求已经先超限了。
 * 所以实际阈值取「设置值」与「窗口 × 90%」里更小的那个——窗口很小时提前压，窗口很大时
 * 仍按设置值。这不是第二个触发条件，只是同一条件的安全上限。
 */
export const WINDOW_CEILING_RATIO = 0.9;

/** 压缩完到「继续」之间的等待：给客户端把压缩期间排队的发送补发回来。 */
export const RESUME_DELAY_MS = 800;

export type AutoCompactSettings = {
  enabled: boolean;
  /** 最近一次请求的输入 token 达到它就触发交接。 */
  thresholdTokens: number;
  /** 快速压缩后估算仍高于它，就再做一次模型压缩。 */
  modelCompactThreshold: number;
  /** 两次自动流程之间至少隔多久（从触发算起）。 */
  minIntervalMs: number;
  /** 压缩完自动发「继续」。 */
  autoResume: boolean;
  /** 交接文档另存一份到 `$MICA_HOME/handovers/`。 */
  saveHandover: boolean;
};

export type AutoCompactPhase = 'idle' | 'handoff' | 'compact' | 'resume' | 'resuming';

/**
 * 按会话保存的流程状态（`ctx.sessionState`）。
 *
 * 只放能重建的判断依据，不放正文：交接提示词有几百字，整段塞进快照会一直占配额。
 */
export type AutoCompactState = {
  phase: AutoCompactPhase;
  /** 进入当前阶段的时间。 */
  phaseAt?: number;
  /** 这次流程触发的时间；冷却从它算起。 */
  triggeredAt?: number;
  /** 压缩后估算的上下文占用（含系统提示词与工具定义）。 */
  compactedTokens?: number;
  /** 最近一次尝试压缩的时间（失败后退避用）。 */
  attemptAt?: number;
  /**
   * 压缩那一刻 `lastUsage` 的 inputTokens。
   *
   * 压缩不改 `lastUsage`（Stats 对账口径），所以「还是同一个数」说明之后还没有新的
   * 真实请求——这时候再看阈值只会把同一次用量反复算成新的一轮。
   */
  staleUsageTokens?: number;
  /** 连续失败次数（报错，或压完仍在阈值以上）。 */
  failures?: number;
  /** 用户在这轮自动流程里插过话：压缩完不要再自动继续。 */
  userIntervened?: boolean;
  /** 最近一次自动流程的结论，排查用。 */
  lastResult?: string;
  /** 完成过的自动压缩次数。 */
  runs?: number;
};

export function readAutoCompactSettings(values: Record<string, string>): AutoCompactSettings {
  const number = (key: string, fallback: number, min: number): number => {
    const parsed = Number(values[key]);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  };
  return {
    // 开关与其余布尔项都按「不是 false 就是开」读：清单里的默认值由宿主补。
    enabled: values.autoCompact !== 'false',
    thresholdTokens: number('thresholdTokens', DEFAULT_THRESHOLD_TOKENS, 1000),
    modelCompactThreshold: number('modelCompactThreshold', DEFAULT_MODEL_COMPACT_TOKENS, 1000),
    minIntervalMs: number('minIntervalMinutes', DEFAULT_MIN_INTERVAL_MINUTES, 0) * 60_000,
    autoResume: values.autoResume !== 'false',
    saveHandover: values.saveHandover !== 'false',
  };
}

/** 状态来自磁盘，任何字段都可能是旧版本或脏数据：逐项收敛，坏的整项丢掉。 */
export function normalizeAutoCompactState(raw: unknown): AutoCompactState {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const phase = record.phase;
  const state: AutoCompactState = {
    phase:
      phase === 'handoff' || phase === 'compact' || phase === 'resume' || phase === 'resuming' ? phase : 'idle',
  };
  for (const key of ['phaseAt', 'triggeredAt', 'compactedTokens', 'attemptAt', 'staleUsageTokens'] as const) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) state[key] = value;
  }
  for (const key of ['failures', 'runs'] as const) {
    const value = record[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) state[key] = value;
  }
  if (record.userIntervened === true) state.userIntervened = true;
  if (typeof record.lastResult === 'string' && record.lastResult.trim()) state.lastResult = record.lastResult.slice(0, 500);
  return state;
}

/**
 * 实际生效的触发阈值。
 *
 * 模型没声明窗口时只有设置值；声明了就再压一层 90% 的天花板。
 */
export function compactThreshold(settings: AutoCompactSettings, contextWindowSize?: number): number {
  if (!contextWindowSize || !Number.isFinite(contextWindowSize) || contextWindowSize <= 0) {
    return settings.thresholdTokens;
  }
  return Math.min(settings.thresholdTokens, Math.floor(contextWindowSize * WINDOW_CEILING_RATIO));
}

export type TriggerSkipReason =
  | 'disabled'
  | 'not-idle'
  | 'no-usage'
  | 'queued'
  | 'below-threshold'
  | 'cooldown'
  | 'stale-usage'
  | 'too-many-failures';

export type TriggerDecision =
  | { trigger: true; threshold: number; usageTokens: number }
  | { trigger: false; reason: TriggerSkipReason };

export type TriggerFacts = {
  settings: AutoCompactSettings;
  state: AutoCompactState;
  usage: { inputTokens: number } | null;
  contextWindowSize?: number;
  /** 宿主排队槽里已有的输入条数（有用户消息就先让它跑）。 */
  queued: number;
  now: number;
};

/**
 * 一次「该不该现在触发」的完整判断。
 *
 * 顺序有讲究：先便宜的、再需要读状态的，最后才是阈值。每一条都对应一种真实会遇到
 * 的情形（用户排了消息、刚压完还没新请求、压不动在冷却…），所以拒绝原因带回给日志。
 */
export function shouldTrigger(facts: TriggerFacts): TriggerDecision {
  const { settings, state, usage, now } = facts;
  if (!settings.enabled) return { trigger: false, reason: 'disabled' };
  if (state.phase !== 'idle') return { trigger: false, reason: 'not-idle' };
  if (!usage || !Number.isFinite(usage.inputTokens) || usage.inputTokens <= 0) {
    return { trigger: false, reason: 'no-usage' };
  }
  if (facts.queued > 0) return { trigger: false, reason: 'queued' };
  if ((state.failures ?? 0) >= MAX_FAILURES) return { trigger: false, reason: 'too-many-failures' };
  const threshold = compactThreshold(settings, facts.contextWindowSize);
  if (usage.inputTokens < threshold) return { trigger: false, reason: 'below-threshold' };
  if (state.triggeredAt !== undefined && now - state.triggeredAt < settings.minIntervalMs) {
    return { trigger: false, reason: 'cooldown' };
  }
  if (state.staleUsageTokens !== undefined && usage.inputTokens === state.staleUsageTokens) {
    return { trigger: false, reason: 'stale-usage' };
  }
  return { trigger: true, threshold, usageTokens: usage.inputTokens };
}

/** 交接请求的正文（模型看到的全文）。 */
export function buildHandoffPrompt(input: {
  usageTokens: number;
  thresholdTokens: number;
  contextWindowSize?: number;
}): string {
  const window =
    input.contextWindowSize && input.contextWindowSize > 0
      ? `，模型窗口 ${formatTokenCount(input.contextWindowSize)}（约占 ${Math.round(
          (input.usageTokens / input.contextWindowSize) * 100,
        )}%）`
      : '';
  return [
    `${HANDOFF_MARKER}上下文已经到 ${formatTokenCount(input.usageTokens)} tokens${window}，触发阈值 ${formatTokenCount(
      input.thresholdTokens,
    )}。现在先暂停手里的任务，把当前进展写成一份能照着继续做的交接文档。`,
    '',
    '这一轮的要求：',
    '1. 不要调用任何工具：不读写文件、不跑命令、不派子代理、不起后台任务。这一轮只写这份文档。',
    '2. 文档直接写在这条回复里（不要新建文件），用与当前对话一致的语言，按下面的结构：',
    '   ## 任务目标',
    '   用户要完成什么；保留原始约束与措辞要点，不要改写意图。',
    '   ## 已完成',
    '   做完的事；改过 / 新增 / 删除的文件（写路径）；跑过的验证与结果。',
    '   ## 进行中',
    '   停在哪一步；有没有半成品改动；哪些改动还没验证。',
    '   ## 待办',
    '   后续必须继续完成的任务，按优先级逐条列出。每条写清楚：改哪里、怎么验证、验收标准。',
    '   ## 关键约束与坑',
    '   用户明确要求不能丢的约束；失败过的尝试与原因；未验证的假设；容易踩的坑。',
    '   ## 下一步',
    '   压缩完成后要做的第一条动作，具体到文件与命令。',
    '3. 写具体：路径、函数名、命令原文。不确定的地方写「未验证」，不要用「如上」「见前文」这类指代。',
    '4. 写完就停下等压缩完成，不要自己开始新的工作。',
  ].join('\n');
}

export function handoffDisplayText(usageTokens: number, thresholdTokens: number): string {
  const show = (tokens: number) => formatTokenCount(tokens, { roundedThousands: true });
  // 会话记录里保存的是这句展示文本（不是整段提示词），所以它必须带同一个标记：
  // 交接完成后要靠标记在对话里找回「哪条请求 → 哪条交接文档」。
  return `${HANDOFF_MARKER}暂停任务，先写交接文档（${show(usageTokens)} / ${show(thresholdTokens)}）`;
}

/** 压缩完成后那条「继续」。 */
export function buildResumePrompt(input: { beforeTokens: number; afterTokens: number }): string {
  return [
    `${RESUME_MARKER}上下文已压缩完成（${formatTokenCount(input.beforeTokens)} → 约 ${formatTokenCount(
      input.afterTokens,
    )}）。`,
    '',
    '按交接文档（或压缩摘要）里的「待办」与「下一步」继续执行原来的任务。',
    '如果那里已经没有待办、任务已经全部完成，只回一句「没有待办，已收尾」，不要开始新的工作。',
  ].join('\n');
}

export const RESUME_DISPLAY_TEXT = `${RESUME_MARKER}继续执行交接文档里的待办`;

/** 我们自己发出去的消息：来源是插件，且带标记。 */
export function isAutoInput(input: { text: string; source?: string }): boolean {
  if (input.source !== 'plugin') return false;
  return input.text.startsWith(HANDOFF_MARKER) || input.text.startsWith(RESUME_MARKER);
}

export function isHandoffInput(input: { text: string; source?: string }): boolean {
  return input.source === 'plugin' && input.text.startsWith(HANDOFF_MARKER);
}

export function isResumeInput(input: { text: string; source?: string }): boolean {
  return input.source === 'plugin' && input.text.startsWith(RESUME_MARKER);
}

/** 消息正文可能是字符串，也可能是内容块数组；只取文本块。 */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === 'text' && typeof record.text === 'string' && record.text.trim()) parts.push(record.text.trim());
  }
  return parts.join('\n').trim();
}

export type UiMessageLike = { role: string; content: unknown };

/**
 * 从会话记录里取回交接文档正文：我们那条请求之后的第一条助手消息。
 *
 * 用「从后往前找请求、再往后找回复」而不是「取最后一条助手消息」：交接轮之后用户可能
 * 已经又说了一句，最后一条助手消息就不一定是交接文档了。
 */
export function findHandoffReply(messages: readonly UiMessageLike[], requestText: string): string {
  const request = requestText.trim();
  if (!request) return '';
  // 会话文件里的那条用户消息可能与原文有细微差别（内容块、空白），所以「带标记」也算
  // 命中；从后往前找，拿到的一定是最近一次交接。
  const matches = (text: string) => text === request || text.startsWith(HANDOFF_MARKER);
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === 'user' && matches(messageText(message.content))) {
      index = i;
      break;
    }
  }
  if (index < 0) return '';
  for (let i = index + 1; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    const text = messageText(message.content);
    if (text) return text;
  }
  return '';
}
