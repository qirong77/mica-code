import type {
  ConfigWebAutoCompactCounter,
  ConfigWebAutoCompactDetails,
  ConfigWebAutoCompactSettings,
} from '../src/shared/types.js';

/**
 * 配置页「Auto Compact」一节的纯逻辑：表单草稿的换算与校验、计数的展示文案。
 *
 * 规则与计数都活在运行时里（桌面端是 `apps/desktop/src/host/auto-compact.js`），页面只是
 * 读写视图。这里不碰数据源，只把设置对象翻译成表单草稿、把计数翻译成界面文案 —— 与
 * `dialogState.ts` 同一条边界：能测的判断都抽出来，组件里只留接线。
 */

export const AUTO_COMPACT_THRESHOLD_MIN_K = 1;
export const AUTO_COMPACT_THRESHOLD_MAX_K = 10_000;
export const AUTO_COMPACT_LIMIT_MIN = 0;
export const AUTO_COMPACT_LIMIT_MAX = 999;

export type AutoCompactDraft = {
  enabled: boolean;
  quickThresholdK: string;
  quickLimit: string;
  modelThresholdK: string;
  modelLimit: string;
};

export type AutoCompactParseResult =
  | { ok: true; settings: ConfigWebAutoCompactSettings }
  | { ok: false; error: string };

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const limit = numberOr(value, fallback);
  return limit >= 0 ? Math.floor(limit) : fallback;
}

/** 设置 → 表单草稿：数字一律转成字符串，输入框才好编辑（空串代表用户清空了）。 */
export function autoCompactDraftFromSettings(settings: ConfigWebAutoCompactSettings): AutoCompactDraft {
  return {
    enabled: settings.enabled !== false,
    quickThresholdK: String(nonNegativeInt(settings.quickThresholdK, 0)),
    quickLimit: String(nonNegativeInt(settings.quickLimit, 0)),
    modelThresholdK: String(nonNegativeInt(settings.modelThresholdK, 0)),
    modelLimit: String(nonNegativeInt(settings.modelLimit, 0)),
  };
}

const INTEGER_PATTERN = /^\d+$/;

function parseIntegerField(
  raw: unknown,
  { min, max, label, unit }: { min: number; max: number; label: string; unit: string },
): { ok: true; value: number } | { ok: false; error: string } {
  const text = String(raw ?? '').trim();
  if (!INTEGER_PATTERN.test(text)) {
    return { ok: false, error: `${label}需为 ${min}–${max} 之间的整数${unit}` };
  }
  const value = Number(text);
  if (value < min || value > max) {
    return { ok: false, error: `${label}需为 ${min}–${max} 之间的整数${unit}` };
  }
  return { ok: true, value };
}

/**
 * 表单草稿 → 设置。空串、非数字、越界都如实报错，不做静默兜底（否则用户改了半天却存了个
 * 别的值，问题只会在自动压缩跑起来时暴露）。运行时的保存路径仍会再钳一次，这里是给用户
 * 看的那一道。
 */
export function autoCompactSettingsFromDraft(draft: AutoCompactDraft): AutoCompactParseResult {
  const quickThreshold = parseIntegerField(draft?.quickThresholdK, {
    min: AUTO_COMPACT_THRESHOLD_MIN_K,
    max: AUTO_COMPACT_THRESHOLD_MAX_K,
    label: '快速压缩阈值',
    unit: '（单位 k）',
  });
  if (!quickThreshold.ok) return quickThreshold;
  const quickLimit = parseIntegerField(draft?.quickLimit, {
    min: AUTO_COMPACT_LIMIT_MIN,
    max: AUTO_COMPACT_LIMIT_MAX,
    label: '快速压缩上限',
    unit: '（次）',
  });
  if (!quickLimit.ok) return quickLimit;
  const modelThreshold = parseIntegerField(draft?.modelThresholdK, {
    min: AUTO_COMPACT_THRESHOLD_MIN_K,
    max: AUTO_COMPACT_THRESHOLD_MAX_K,
    label: '模型压缩阈值',
    unit: '（单位 k）',
  });
  if (!modelThreshold.ok) return modelThreshold;
  const modelLimit = parseIntegerField(draft?.modelLimit, {
    min: AUTO_COMPACT_LIMIT_MIN,
    max: AUTO_COMPACT_LIMIT_MAX,
    label: '模型压缩上限',
    unit: '（次）',
  });
  if (!modelLimit.ok) return modelLimit;
  return {
    ok: true,
    settings: {
      enabled: draft?.enabled !== false,
      quickThresholdK: quickThreshold.value,
      quickLimit: quickLimit.value,
      modelThresholdK: modelThreshold.value,
      modelLimit: modelLimit.value,
    },
  };
}

/** 一次压缩的类型文案：没压过时返回空串（调用方据此隐藏这一列）。 */
export function autoCompactKindLabel(kind: ConfigWebAutoCompactCounter['lastKind']): string {
  if (kind === 'quick') return '快速压缩';
  if (kind === 'model') return '模型压缩';
  return '';
}

/** 计数值的进度：`2/3`（上限为 0 时表示这类压缩被关掉）。 */
export function autoCompactRunLabel(
  counter: ConfigWebAutoCompactCounter,
  settings: ConfigWebAutoCompactSettings,
): string {
  const quickRuns = countOrZero(counter?.quickRuns);
  const modelRuns = countOrZero(counter?.modelRuns);
  const quickLimit = nonNegativeInt(settings?.quickLimit, 0);
  const modelLimit = nonNegativeInt(settings?.modelLimit, 0);
  return `快速 ${quickRuns}/${quickLimit} · 模型 ${modelRuns}/${modelLimit}`;
}

function countOrZero(value: unknown): number {
  const count = numberOr(value, 0);
  return count > 0 ? Math.floor(count) : 0;
}

/** 计数行的标题：会话文件还在用标题，被删掉的会话退回 id 片段。 */
export function autoCompactCounterTitle(counter: ConfigWebAutoCompactCounter): string {
  const title = typeof counter?.title === 'string' ? counter.title.trim() : '';
  if (title) return title;
  const id = typeof counter?.sessionId === 'string' ? counter.sessionId : '';
  return id ? `${id.slice(0, 8)}…（会话已删除）` : '未知会话';
}

/** 设置的整体状态文案：页面标题右侧的那一行。 */
export function autoCompactStatusLabel(details: ConfigWebAutoCompactDetails | null): string {
  if (!details) return '';
  const settings = details.settings;
  if (settings.enabled === false) return '已关闭';
  const runs = details.counters.reduce(
    (total, counter) => total + countOrZero(counter.quickRuns) + countOrZero(counter.modelRuns),
    0,
  );
  return `快速 ${settings.quickThresholdK}k · 模型 ${settings.modelThresholdK}k · 已压缩 ${runs} 次`;
}

export function formatAutoCompactTime(value: string | null | undefined): string {
  const at = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(at) ? new Date(at).toLocaleString() : '-';
}
