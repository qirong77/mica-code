/**
 * 自动压缩的规则表与决策。
 *
 * 这里只有「什么时候压、压哪一种」，不含任何 IO：读设置、写计数、真的去压都在
 * `index.ts`。分开是为了让策略能被直接测——阈值、次数、间隔这些边界最容易写错，
 * 而它们错一次就是「每轮都在压」或者「从来不压」。
 */

export type AutoCompactSettings = {
  enabled: boolean;
  quickThresholdK: number;
  quickLimit: number;
  modelThresholdK: number;
  modelLimit: number;
  minIntervalMs: number;
  /** 关掉之后不再问「要不要压缩」，自动压缩本身照旧。 */
  remindEnabled: boolean;
  /** 距上一次请求过了这么久，提示词缓存大概率已失效：值得问一句。 */
  idleRemindMs: number;
  /** 上下文小于这个量时不提醒：省下的 token 还不够一次请求的零头。 */
  remindContextTokens: number;
};

export type AutoCompactCounters = {
  quickRuns: number;
  modelRuns: number;
  /** 上一次压缩成功的时间（ISO）。 */
  lastRunAt: string | null;
  /**
   * 本轮开始的 ISO 时间。
   *
   * 「同一轮内的压缩间隔」只约束**同一轮运行中**的重复压缩：模型还在为这一轮反复请求、
   * 上下文又长回阈值时才等一会儿。上一轮压过、这一轮重新超阈值时必须立刻压，否则用户
   * 看到的会是「明明上下文已经很大，插件却因为半小时前压过而装死」。
   */
  turnStartedAt: string | null;
  lastKind: 'quick' | 'model' | null;
  lastSavedTokens: number;
  /** Unsuccessful/no-op attempts back off without consuming successful runs. */
  lastAttemptAt: string | null;
  lastAttemptTokens: number;
  /**
   * 最近一次往模型发请求的时间（ISO）。
   *
   * 提醒要回答的是「这段历史在缓存里还热着吗」，所以记的是请求时刻而不是轮次开始：
   * 一轮跑了半小时、期间压过两次，缓存是被最后一次请求刷新的。
   */
  lastRequestAt: string | null;
  /** 最近一次发出「要不要压缩」提醒的时间（ISO）；与 `lastRequestAt` 比出「这段空闲问过没有」。 */
  lastReminderAt: string | null;
};

export type AutoCompactStep = 'quick' | 'model';

export const DEFAULT_SETTINGS: AutoCompactSettings = {
  enabled: true,
  quickThresholdK: 300,
  quickLimit: 999,
  modelThresholdK: 200,
  modelLimit: 999,
  minIntervalMs: 30 * 60 * 1000,
  remindEnabled: true,
  idleRemindMs: 60 * 60 * 1000,
  remindContextTokens: 100_000,
};

export const EMPTY_COUNTERS: AutoCompactCounters = {
  quickRuns: 0,
  modelRuns: 0,
  lastRunAt: null,
  turnStartedAt: null,
  lastKind: null,
  lastSavedTokens: 0,
  lastAttemptAt: null,
  lastAttemptTokens: 0,
  lastRequestAt: null,
  lastReminderAt: null,
};

const MAX_RUNS = 1_000_000;

function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 设置来自 `ctx.settings.get()`（全是字符串），边界由清单声明，这里只做兜底。 */
export function settingsFromValues(values: Record<string, string | undefined>): AutoCompactSettings {
  return {
    enabled: (values.enabled ?? String(DEFAULT_SETTINGS.enabled)) !== 'false',
    quickThresholdK: Math.max(1, readNumber(values.quickThresholdK, DEFAULT_SETTINGS.quickThresholdK)),
    quickLimit: Math.max(0, Math.round(readNumber(values.quickLimit, DEFAULT_SETTINGS.quickLimit))),
    modelThresholdK: Math.max(1, readNumber(values.modelThresholdK, DEFAULT_SETTINGS.modelThresholdK)),
    modelLimit: Math.max(0, Math.round(readNumber(values.modelLimit, DEFAULT_SETTINGS.modelLimit))),
    minIntervalMs: Math.max(
      0,
      Math.round(readNumber(values.minIntervalMinutes, DEFAULT_SETTINGS.minIntervalMs / 60_000) * 60_000),
    ),
    remindEnabled: (values.remindEnabled ?? String(DEFAULT_SETTINGS.remindEnabled)) !== 'false',
    idleRemindMs:
      Math.max(1, Math.round(readNumber(values.idleRemindMinutes, DEFAULT_SETTINGS.idleRemindMs / 60_000))) * 60_000,
    remindContextTokens:
      Math.max(1, Math.round(readNumber(values.remindContextK, DEFAULT_SETTINGS.remindContextTokens / 1000))) * 1000,
  };
}

/**
 * 计数存在会话快照里，所以它可能是上一个版本写的、也可能被手工改坏。
 * 任何一个字段不可信就退回 0：多压一次比少压一次无害，读崩了才是事故。
 */
export function normalizeCounters(input: unknown): AutoCompactCounters {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const count = (value: unknown): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.min(Math.round(parsed), MAX_RUNS);
  };
  return {
    quickRuns: count(source.quickRuns),
    modelRuns: count(source.modelRuns),
    lastRunAt: typeof source.lastRunAt === 'string' && source.lastRunAt ? source.lastRunAt : null,
    turnStartedAt: typeof source.turnStartedAt === 'string' && source.turnStartedAt ? source.turnStartedAt : null,
    lastKind: source.lastKind === 'quick' || source.lastKind === 'model' ? source.lastKind : null,
    lastSavedTokens: count(source.lastSavedTokens),
    lastAttemptAt: typeof source.lastAttemptAt === 'string' && source.lastAttemptAt ? source.lastAttemptAt : null,
    lastAttemptTokens: Math.max(0, readNumber(source.lastAttemptTokens, 0)),
    lastRequestAt: typeof source.lastRequestAt === 'string' && source.lastRequestAt ? source.lastRequestAt : null,
    lastReminderAt: typeof source.lastReminderAt === 'string' && source.lastReminderAt ? source.lastReminderAt : null,
  };
}

/**
 * 同一轮里距上一次压缩还不满间隔？
 *
 * 上一轮压过的不算：`turnStartedAt` 比 `lastRunAt` 新，说明这是新一轮，间隔从这一刻
 * 重新起算（而不是继续沿用上一轮的冷却）。没有记录轮次开始时间时按旧行为保守节流——
 * 那只可能出现在没有 turn 钩子的宿主里。
 *
 * 时钟回拨（elapsed < 0）不算在间隔内：否则会一直等到时间追上来，等于把压缩永久关掉。
 */
function withinMinInterval(settings: AutoCompactSettings, counters: AutoCompactCounters, nowMs: number): boolean {
  if (!Number.isFinite(settings.minIntervalMs) || settings.minIntervalMs <= 0) return false;
  const lastRunAtMs = Date.parse(counters.lastRunAt ?? '');
  if (!Number.isFinite(lastRunAtMs)) return false;
  const turnStartedAtMs = Date.parse(counters.turnStartedAt ?? '');
  if (Number.isFinite(turnStartedAtMs) && lastRunAtMs < turnStartedAtMs) return false;
  const elapsed = nowMs - lastRunAtMs;
  return elapsed >= 0 && elapsed < settings.minIntervalMs;
}

/**
 * 给定当前 ctx 与已运行次数，决定这次请求结束后要不要压缩、压哪一种。
 *
 * 快速压缩同时是模型压缩的前置步骤，所以「模型压缩到期」本身就足以触发一次快速
 * 压缩：ctx 落在两个阈值之间时是「快速压缩 →（仍高于模型阈值）模型压缩」两步，
 * 而不是直接跳到模型压缩。升级判定在调用方按压缩后的 ctx 做。
 */
export function decideAutoCompactStep(input: {
  settings: AutoCompactSettings;
  counters: AutoCompactCounters;
  ctxTokens: number;
  /** 当前时间（测试可注入）。 */
  nowMs?: number;
  contextWindowSize?: number;
}): AutoCompactStep | null {
  const { settings, counters, ctxTokens } = input;
  if (!settings.enabled) return null;
  if (!Number.isFinite(ctxTokens) || ctxTokens <= 0) return null;
  const nowMs = input.nowMs ?? Date.now();
  const sinceAttempt = nowMs - Date.parse(counters.lastAttemptAt ?? '');
  if (sinceAttempt >= 0 && sinceAttempt < 60_000 && ctxTokens <= counters.lastAttemptTokens * 1.1) return null;
  const thresholds = effectiveThresholds(settings, input.contextWindowSize);
  const urgent = thresholds.window !== undefined && ctxTokens >= thresholds.window * 0.88;
  if (!urgent && withinMinInterval(settings, counters, nowMs)) return null;
  const modelDue = counters.modelRuns < settings.modelLimit && ctxTokens >= thresholds.model;
  if (counters.quickRuns < settings.quickLimit && (ctxTokens >= thresholds.quick || modelDue)) {
    return 'quick';
  }
  if (modelDue) return 'model';
  return null;
}

/** 快速压缩之后仍高于模型阈值（压缩没压够）才升级；已经压到阈值以下不再花一次请求。 */
export function shouldEscalateToModel(input: {
  settings: AutoCompactSettings;
  counters: AutoCompactCounters;
  ctxTokens: number;
  contextWindowSize?: number;
}): boolean {
  const { settings, counters, ctxTokens } = input;
  return (
    settings.enabled &&
    counters.modelRuns < settings.modelLimit &&
    ctxTokens >= effectiveThresholds(settings, input.contextWindowSize).model
  );
}

/** User thresholds remain upper bounds; smaller models reserve room for answers and tool batches. */
export function effectiveThresholds(settings: AutoCompactSettings, contextWindowSize?: number) {
  const window = Number.isFinite(contextWindowSize) && contextWindowSize! > 0 ? contextWindowSize : undefined;
  return {
    window,
    quick: Math.min(settings.quickThresholdK * 1000, window ? window * 0.55 : Infinity),
    model: Math.min(settings.modelThresholdK * 1000, window ? window * 0.75 : Infinity),
  };
}

export type CompactReminderKind = 'idle' | 'context';

/**
 * 轮次之外多久可以打扰用户一次：'context' 那条走容量，不等到一小时也得先等一轮落地。
 *
 * 刚答完的一轮里上下文本来就大，那时再补一张卡纯属噪音——真正要问的是「人走开之后」。
 */
const CONTEXT_REMINDER_MIN_IDLE_MS = 10 * 60 * 1000;

/**
 * 给定「现在多大、放了多久」，决定要不要问用户一句「要不要压缩」。
 *
 * 这里**不做压缩**，只决定要不要提醒：轮次之外的压缩会改写用户看得见的历史，那得由
 * 他点一下。所以规则比 `decideAutoCompactStep` 保守得多，四条缺一不可：
 *
 * - 会话是空闲的（一轮在跑时轮内压缩本来就在动，再问一句只是打断）；
 * - 上下文确实大（低于提醒下限时压也压不出什么）；
 * - 这段空闲里**还没问过**（同一个「人走开了」只问一次，按 `lastReminderAt` 与
 *   `lastRequestAt` 的先后判定：一次新请求会重新打开这个窗口）；
 * - 压缩次数还没用尽（提醒了也压不动等于骗用户）。
 *
 * `context` 只在接近窗口上限时出现，`idle` 是「放太久了，缓存大概率已经失效」。
 */
export function decideCompactReminder(input: {
  settings: AutoCompactSettings;
  counters: AutoCompactCounters;
  /** 最近一次真实请求送出去的上下文；还没请求过时是 0。 */
  ctxTokens: number;
  /** 这一轮是否在跑（或别的进程占着会话）。 */
  busy?: boolean;
  /** 当前时间（测试可注入）。 */
  nowMs?: number;
  contextWindowSize?: number;
}): CompactReminderKind | null {
  const { settings, counters, ctxTokens } = input;
  if (!settings.enabled || !settings.remindEnabled) return null;
  if (input.busy) return null;
  if (!Number.isFinite(ctxTokens)) return null;
  if (counters.quickRuns >= settings.quickLimit && counters.modelRuns >= settings.modelLimit) return null;

  const window = effectiveThresholds(settings, input.contextWindowSize).window;
  // 小窗口模型上「100k 才值得提醒」永远不成立：门槛跟着窗口一起缩。
  const floor = window ? Math.min(settings.remindContextTokens, window * 0.5) : settings.remindContextTokens;
  if (ctxTokens < floor) return null;

  const nowMs = input.nowMs ?? Date.now();
  const lastRequestMs = Date.parse(counters.lastRequestAt ?? '');
  const lastReminderMs = Date.parse(counters.lastReminderAt ?? '');
  // 这段停留已经问过：用户没回、或者回了「先不压」，都不该在一轮新请求之前再问。
  if (Number.isFinite(lastReminderMs) && (!Number.isFinite(lastRequestMs) || lastReminderMs >= lastRequestMs)) {
    return null;
  }

  // 时钟回拨时不猜「放了多久」：宁可这轮不提醒，也不要拿负数算出「刚请求过」再反着理解。
  const idleMs = Number.isFinite(lastRequestMs) ? nowMs - lastRequestMs : -1;
  const hugeAt = window ? window * 0.8 : settings.remindContextTokens * 3;
  if (ctxTokens >= hugeAt && idleMs >= CONTEXT_REMINDER_MIN_IDLE_MS) return 'context';
  if (idleMs >= settings.idleRemindMs) return 'idle';
  return null;
}
