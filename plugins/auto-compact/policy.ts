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
  /**
   * 会话空闲多久之后、用户在输入框里重新敲字，就先做一次快速压缩。0 表示关掉这个触发。
   *
   * 它与阈值无关：阈值判断的是「上下文是不是已经很大」，这里判断的是「人是不是刚回来」。
   */
  idleMs: number;
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
  /**
   * 这条会话最后一次活动的时间（ISO）：一轮开始/结束、或者用户在输入框里敲字。
   *
   * 存进会话状态是为了冷启动后还能算「这次回来隔了多久」——只在内存里的话，
   * 每次打开应用都会把用户当成刚说过话。
   */
  lastActivityAt: string | null;
  /** Unsuccessful/no-op attempts back off without consuming successful runs. */
  lastAttemptAt: string | null;
  lastAttemptTokens: number;
};

export type AutoCompactStep = 'quick' | 'model';

export const DEFAULT_SETTINGS: AutoCompactSettings = {
  enabled: true,
  quickThresholdK: 300,
  quickLimit: 999,
  modelThresholdK: 200,
  modelLimit: 999,
  minIntervalMs: 30 * 60 * 1000,
  idleMs: 15 * 60 * 1000,
};

export const EMPTY_COUNTERS: AutoCompactCounters = {
  quickRuns: 0,
  modelRuns: 0,
  lastRunAt: null,
  turnStartedAt: null,
  lastKind: null,
  lastSavedTokens: 0,
  lastActivityAt: null,
  lastAttemptAt: null,
  lastAttemptTokens: 0,
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
    idleMs: Math.max(0, Math.round(readNumber(values.idleMinutes, DEFAULT_SETTINGS.idleMs / 60_000) * 60_000)),
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
    lastActivityAt: typeof source.lastActivityAt === 'string' && source.lastActivityAt ? source.lastActivityAt : null,
    lastAttemptAt: typeof source.lastAttemptAt === 'string' && source.lastAttemptAt ? source.lastAttemptAt : null,
    lastAttemptTokens: Math.max(0, readNumber(source.lastAttemptTokens, 0)),
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

/**
 * 用户空闲很久之后重新敲字：要不要趁这个间隙先做一次快速压缩？
 *
 * 这里不看上下文大小——「这次请求马上就到」本身就是理由，小上下文压不动也无所谓
 * （宿主会返回「没有可清理内容」，不消耗次数）。真正拦住重复工作的是次数上限与
 * 本地清理的幂等性：没有新内容时宿主直接回「没压成」，不写盘也不计次。
 *
 * 也**不**看「同一轮内的压缩间隔」：那个间隔是为同一段上下文被反复按阈值压准备的，
 * 而这里判断的是「人回来了」。刚压过一次就返回的人恰恰是最需要提前量的一批：他离开
 * 之后的历史又长大了，压一次才有意义；把间隔套在这里，最常见的场景（工作正密集、
 * 一会儿压一会儿走）就会静默失效。
 */
export function shouldCompactOnReturn(input: {
  settings: AutoCompactSettings;
  counters: AutoCompactCounters;
  /** 距这条会话上一次活动过去了多久。 */
  idleMs: number;
}): boolean {
  const { settings, counters, idleMs } = input;
  if (!settings.enabled) return false;
  if (!Number.isFinite(settings.idleMs) || settings.idleMs <= 0) return false;
  if (!Number.isFinite(idleMs) || idleMs < settings.idleMs) return false;
  return counters.quickRuns < settings.quickLimit;
}
