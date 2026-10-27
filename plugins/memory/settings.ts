import { DEFAULT_MEMORY_BUDGETS, type MemoryBudgets } from './store.js';
import { CURATOR_PROTOCOLS, type CuratorProtocol, type CuratorProviderConfig } from './providers.js';

/**
 * 插件设置 → 运行参数。
 *
 * 设置文件里的值全是字符串（配置页就是一个表单），所以解析、兜底、范围收敛都在
 * 这一处，运行期不再回头读原始值。`autoCapture` 默认关闭：后台整理会花模型的钱，
 * 不该是「装了插件就自动开始」的行为。
 */

export type CuratorMode = 'subagent' | 'direct';

export type MemorySettings = {
  enabled: boolean;
  budgets: MemoryBudgets;
  autoCapture: boolean;
  minIntervalMinutes: number;
  maxMessages: number;
  curatorMode: CuratorMode;
  curatorBaseUrl: string;
  curatorApiKey: string;
  curatorProtocol: CuratorProtocol;
  curatorModel: string;
};

export const DEFAULT_SETTINGS: MemorySettings = {
  enabled: true,
  budgets: DEFAULT_MEMORY_BUDGETS,
  autoCapture: false,
  minIntervalMinutes: 10,
  maxMessages: 30,
  curatorMode: 'subagent',
  curatorBaseUrl: '',
  curatorApiKey: '',
  curatorProtocol: 'openai_chat_completions',
  curatorModel: '',
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
    curatorBaseUrl: (values.curatorBaseUrl ?? '').trim(),
    // Key 支持 `${ENV_VAR}`：设置文件是明文 JSON，长期凭据更适合放在环境变量里。
    // 只对 Key 展开——地址带 `format: url` 校验，占位符会被配置页判成非法值。
    curatorApiKey: expandEnv((values.curatorApiKey ?? '').trim()),
    curatorProtocol: CURATOR_PROTOCOLS.includes(values.curatorProtocol as CuratorProtocol)
      ? (values.curatorProtocol as CuratorProtocol)
      : DEFAULT_SETTINGS.curatorProtocol,
    curatorModel: (values.curatorModel ?? '').trim(),
  };
}

/** 独立 provider 模式下的请求配置；缺任何一项都返回 null（由调用方上报待配置）。 */
export function curatorProviderConfig(settings: MemorySettings): CuratorProviderConfig | null {
  if (!settings.curatorBaseUrl || !settings.curatorApiKey || !settings.curatorModel) return null;
  return {
    baseUrl: settings.curatorBaseUrl,
    apiKey: settings.curatorApiKey,
    protocol: settings.curatorProtocol,
    model: settings.curatorModel,
  };
}

export function describeCurator(settings: MemorySettings): string {
  if (!settings.autoCapture) return '自动整理：关闭（/memory review 可手动整理一次）';
  const interval = settings.minIntervalMinutes > 0 ? `每 ${settings.minIntervalMinutes} 分钟最多一次` : '不节流';
  if (settings.curatorMode === 'direct') {
    const model = settings.curatorModel || '未指定模型';
    return `自动整理：开启 · ${interval} · 独立接口（${settings.curatorProtocol} / ${model}）`;
  }
  return `自动整理：开启 · ${interval} · 宿主子代理（用当前模型）`;
}

function readSwitch(value: string | undefined, fallback: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** `${VAR}` → 环境变量；变量缺失时变成空串，由 `curatorProviderConfig` 判为未配置。 */
export function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? '');
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
