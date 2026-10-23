/**
 * 自动压缩设置在会话级的覆盖规则（CLI / desktop / app-server 共用）。
 *
 * 两层的语义与能力开关一致：
 * - 默认值：全局唯一一份（desktop 设置页写，见 host/auto-compact.js）。CLI 没有单独的
 *   默认配置，使用 `AUTO_COMPACT_DEFAULTS`。
 * - 会话覆盖：只记录用户显式改过的键，存在会话快照里（`autoCompactOverride`）。
 *   没记录的键继续跟随默认值，所以以后调默认值仍然能落到这条会话上。
 *
 * 覆盖必须只存「改过的键」：整份设置一起存会把当时的默认值固化进会话，
 * 之后调默认值对老会话完全无效。
 */

export type AutoCompactSettings = {
  enabled: boolean;
  quickThresholdK: number;
  quickLimit: number;
  modelThresholdK: number;
  modelLimit: number;
  /** 两次压缩之间的最小间隔（毫秒）；0 表示不限制。 */
  minIntervalMs: number;
};

export type AutoCompactOverride = Partial<AutoCompactSettings>;

export type AutoCompactNumericKey = Exclude<keyof AutoCompactSettings, 'enabled'>;

export const AUTO_COMPACT_DEFAULTS: AutoCompactSettings = {
  enabled: true,
  quickThresholdK: 200,
  quickLimit: 3,
  modelThresholdK: 120,
  modelLimit: 3,
  minIntervalMs: 20 * 60 * 1000,
};

export const AUTO_COMPACT_MAX_THRESHOLD_K = 10_000;
export const AUTO_COMPACT_MAX_LIMIT = 999;
/**
 * 阈值的安全下限：低于它压缩就没有意义了（快速压缩 150k 以下基本清不出东西，
 * 模型压缩 100k 以下等于每次请求都换一份摘要），所以不把边界留给用户填。
 */
export const AUTO_COMPACT_MIN_QUICK_THRESHOLD_K = 150;
export const AUTO_COMPACT_MIN_MODEL_THRESHOLD_K = 100;
export const AUTO_COMPACT_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type AutoCompactFieldRange = { min: number; max: number; step: number };

/**
 * 数值字段的边界与步进。两端面板都按这份表渲染与加减，避免 CLI 与桌面各写一套步进。
 */
export const AUTO_COMPACT_FIELD_RANGES: Record<AutoCompactNumericKey, AutoCompactFieldRange> = {
  quickThresholdK: { min: AUTO_COMPACT_MIN_QUICK_THRESHOLD_K, max: AUTO_COMPACT_MAX_THRESHOLD_K, step: 10 },
  quickLimit: { min: 0, max: AUTO_COMPACT_MAX_LIMIT, step: 1 },
  modelThresholdK: { min: AUTO_COMPACT_MIN_MODEL_THRESHOLD_K, max: AUTO_COMPACT_MAX_THRESHOLD_K, step: 10 },
  modelLimit: { min: 0, max: AUTO_COMPACT_MAX_LIMIT, step: 1 },
  minIntervalMs: { min: 0, max: AUTO_COMPACT_MAX_INTERVAL_MS, step: 5 * 60 * 1000 },
};

export const AUTO_COMPACT_NUMERIC_KEYS = Object.keys(AUTO_COMPACT_FIELD_RANGES) as AutoCompactNumericKey[];

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // 数字字符串来自 config/协议（桌面宿主可能把它们当前端输入发过来）。
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 只保留显式给出且合法的键：非法的键整个丢掉（回落到默认值），越界的键钳到边界。
 * 丢掉而不是回落写入，会话快照里才不会留下一堆「用户没真正选过」的值。
 */
export function normalizeAutoCompactOverride(input: unknown): AutoCompactOverride {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const override: AutoCompactOverride = {};
  if (typeof source.enabled === 'boolean') override.enabled = source.enabled;
  for (const key of AUTO_COMPACT_NUMERIC_KEYS) {
    if (!(key in source)) continue;
    const parsed = toFiniteNumber(source[key]);
    if (parsed === null) continue;
    const range = AUTO_COMPACT_FIELD_RANGES[key];
    override[key] = Math.min(Math.max(Math.round(parsed), range.min), range.max);
  }
  return override;
}

/** 默认值 + 会话覆盖 = 这条会话真正生效的设置。 */
export function resolveAutoCompactSettings(
  base: AutoCompactSettings = AUTO_COMPACT_DEFAULTS,
  override: AutoCompactOverride | undefined = undefined,
): AutoCompactSettings {
  if (!override) return { ...base };
  return { ...base, ...normalizeAutoCompactOverride(override) };
}

export function isEmptyAutoCompactOverride(override: AutoCompactOverride | undefined): boolean {
  return !override || Object.keys(override).length === 0;
}

/** 覆盖了对齐默认值的键等于没覆盖：面板据此显示「继承默认」。 */
export function pruneAutoCompactOverride(
  override: AutoCompactOverride,
  base: AutoCompactSettings = AUTO_COMPACT_DEFAULTS,
): AutoCompactOverride {
  const pruned: AutoCompactOverride = {};
  for (const key of AUTO_COMPACT_NUMERIC_KEYS) {
    const value = override[key];
    if (value === undefined || value === base[key]) continue;
    pruned[key] = value;
  }
  if (override.enabled !== undefined && override.enabled !== base.enabled) pruned.enabled = override.enabled;
  return pruned;
}
