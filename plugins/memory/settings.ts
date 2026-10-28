import { DEFAULT_MEMORY_BUDGETS, type MemoryBudgets } from './store.js';
import type { PluginLlmApi } from '@packages/mica-plugin/index.js';

/**
 * 插件设置 → 运行参数。
 *
 * 设置文件里的值全是字符串（配置页就是一个表单），所以解析、兜底、范围收敛都在
 * 这一处，运行期不再回头读原始值。
 *
 * `autoCapture` 默认开启，与 `auto-compact` 同一取向：记忆全靠模型自觉调用工具写入
 * 的话，真机上几乎不会增长（实测 12 个会话只有 1 次），插件就等于没装。成本靠节流
 * 兜住——默认 30 分钟最多一次（全局），比 `auto-compact` 的阈值触发更保守。
 */

export type CuratorMode = 'subagent' | 'direct';

export type MemorySettings = {
  enabled: boolean;
  budgets: MemoryBudgets;
  autoCapture: boolean;
  minIntervalMinutes: number;
  maxMessages: number;
  curatorMode: CuratorMode;
};

export const DEFAULT_SETTINGS: MemorySettings = {
  enabled: true,
  budgets: DEFAULT_MEMORY_BUDGETS,
  autoCapture: true,
  minIntervalMinutes: 30,
  maxMessages: 30,
  curatorMode: 'subagent',
};

export function settingsFromValues(values: Record<string, string | undefined>): MemorySettings {
  return {
    enabled: readSwitch(values.enabled, DEFAULT_SETTINGS.enabled),
    budgets: {
      user: readNumber(values.userCharLimit, DEFAULT_MEMORY_BUDGETS.user, 200, 20_000),
      memory: readNumber(values.memoryCharLimit, DEFAULT_MEMORY_BUDGETS.memory, 200, 20_000),
      project: readNumber(values.projectCharLimit, DEFAULT_MEMORY_BUDGETS.project, 200, 20_000),
    },
    autoCapture: readSwitch(values.autoCapture, DEFAULT_SETTINGS.autoCapture),
    minIntervalMinutes: readNumber(values.minIntervalMinutes, DEFAULT_SETTINGS.minIntervalMinutes, 0, 1440),
    maxMessages: readNumber(values.maxMessages, DEFAULT_SETTINGS.maxMessages, 2, 100),
    curatorMode: values.curatorMode === 'direct' ? 'direct' : 'subagent',
  };
}

/**
 * 独立接口是否可用。`ctx.llm` 已经在读生效值时展开过 `${ENV_VAR}`，
 * 缺地址或模型就是「没配好」，由调用方上报待配置。
 */
export function curatorReady(llm: PluginLlmApi | undefined): boolean {
  return llm?.configured() === true;
}

export function describeCurator(settings: MemorySettings, llm: PluginLlmApi | undefined): string {
  if (!settings.autoCapture) return '自动整理：关闭（/memory review 可手动整理一次）';
  const interval = settings.minIntervalMinutes > 0 ? `每 ${settings.minIntervalMinutes} 分钟最多一次` : '不节流';
  if (settings.curatorMode === 'direct') {
    return `自动整理：开启 · ${interval} · 独立接口（${llm?.describe() ?? '未配置'}）`;
  }
  return `自动整理：开启 · ${interval} · 宿主子代理（用当前模型）`;
}

function readSwitch(value: string | undefined, fallback: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function readNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const text = (value ?? '').trim();
  // `Number('')` 是 0 而不是 NaN：不先挡掉空串，没填过的设置会被压到下限
  // （预算默认值会被读成 200，而不是 1375）。
  if (!text) return fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
