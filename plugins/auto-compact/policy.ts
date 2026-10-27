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
};

export type AutoCompactCounters = {
  quickRuns: number;
  modelRuns: number;
  /** 上一次压缩成功的时间（ISO），节流的基线。 */
  lastRunAt: string | null;
  lastKind: 'quick' | 'model' | null;
  lastSavedTokens: number;
};

export type AutoCompactStep = 'quick' | 'model';

export const DEFAULT_SETTINGS: AutoCompactSettings = {
  enabled: true,
  quickThresholdK: 200,
  quickLimit: 3,
  modelThresholdK: 120,
  modelLimit: 3,
  minIntervalMs: 20 * 60 * 1000,
};

export const EMPTY_COUNTERS: AutoCompactCounters = {
  quickRuns: 0,
  modelRuns: 0,
  lastRunAt: null,
  lastKind: null,
  lastSavedTokens: 0,
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
    lastKind: source.lastKind === 'quick' || source.lastKind === 'model' ? source.lastKind : null,
    lastSavedTokens: count(source.lastSavedTokens),
  };
}

/**
 * 距上一次压缩还不满间隔？时钟回拨（elapsed < 0）不算在间隔内：否则会一直等到
 * 时间追上来，等于把压缩永久关掉。
 */
function withinMinInterval(settings: AutoCompactSettings, counters: AutoCompactCounters, nowMs: number): boolean {
  if (!Number.isFinite(settings.minIntervalMs) || settings.minIntervalMs <= 0) return false;
  const lastRunAtMs = Date.parse(counters.lastRunAt ?? '');
  if (!Number.isFinite(lastRunAtMs)) return false;
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
}): AutoCompactStep | null {
  const { settings, counters, ctxTokens } = input;
  if (!settings.enabled) return null;
  if (!Number.isFinite(ctxTokens) || ctxTokens <= 0) return null;
  if (withinMinInterval(settings, counters, input.nowMs ?? Date.now())) return null;
  const modelDue = counters.modelRuns < settings.modelLimit && ctxTokens >= settings.modelThresholdK * 1000;
  if (counters.quickRuns < settings.quickLimit && (ctxTokens >= settings.quickThresholdK * 1000 || modelDue)) {
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
}): boolean {
  const { settings, counters, ctxTokens } = input;
  return counters.modelRuns < settings.modelLimit && ctxTokens >= settings.modelThresholdK * 1000;
}
