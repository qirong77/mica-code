import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 插件健康状态：插件自己上报「我现在能不能正常工作」。
 *
 * 存在的理由很具体——插件最典型的失败方式是**静默**的：配置没填、URL 连不上、
 * 上一次请求失败，这些都不该让插件崩溃，但也不该只写进日志。没有这个通道时，用户
 * 看到的只是「开了插件却什么都没发生」，排查要一路翻到 tmpdir。
 *
 * 约定：
 * - 插件**在状态变化时**上报（成功一次、配置缺失、请求失败），不必每轮都写；
 * - 文件很小、可随时重建，因此损坏时当作「没有上报过」，不影响启动；
 * - 只存最近一条：健康状态回答的是「现在怎么样」，不是历史审计。
 */
export const PLUGIN_HEALTH_DIR = 'plugin-health';

export type PluginHealthLevel = 'ok' | 'warn' | 'error';

/** 插件能上报的一条状态。`detail` 给人看，不要放凭据。 */
export type PluginHealthReport = {
  level: PluginHealthLevel;
  /** 一句话说明，例如「未配置 baseUrl」「上一次请求失败：401」。 */
  message: string;
  /** 可选的处理建议，例如「到插件设置里填写 API Key」。 */
  hint?: string;
  /** ISO 时间，由写入方填。 */
  at: string;
};

export type PluginHealthStore = {
  readonly path: string | null;
  /** 最近一次上报；从没上报过返回 null。 */
  read(): PluginHealthReport | null;
  report(report: { level: PluginHealthLevel; message: string; hint?: string }): void;
  clear(): void;
};

export function resolvePluginHealthPath(pluginId: string, configDir: string): string {
  return join(configDir, PLUGIN_HEALTH_DIR, `${pluginId.replace(/[\\/]/g, '_')}.json`);
}

export function readPluginHealth(pluginId: string, options: { configDir?: string } = {}): PluginHealthReport | null {
  if (!options.configDir) return null;
  const file = resolvePluginHealthPath(pluginId, options.configDir);
  if (!existsSync(file)) return null;
  try {
    return normalizeHealthReport(JSON.parse(readFileSync(file, 'utf-8')));
  } catch {
    return null;
  }
}

export function writePluginHealth(
  pluginId: string,
  report: { level: PluginHealthLevel; message: string; hint?: string },
  options: { configDir?: string } = {},
): PluginHealthReport | null {
  if (!options.configDir) return null;
  const normalized: PluginHealthReport = {
    level: report.level,
    message: truncate(report.message),
    at: new Date().toISOString(),
  };
  if (report.hint) normalized.hint = truncate(report.hint);
  const file = resolvePluginHealthPath(pluginId, options.configDir);
  mkdirSync(join(options.configDir, PLUGIN_HEALTH_DIR), { recursive: true });
  writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  return normalized;
}

export function clearPluginHealth(pluginId: string, options: { configDir?: string } = {}): void {
  if (!options.configDir) return;
  const file = resolvePluginHealthPath(pluginId, options.configDir);
  if (!existsSync(file)) return;
  try {
    writeFileSync(file, '', 'utf-8');
  } catch {
    // 上报是辅助信息，清不掉也不该影响插件本身。
  }
}

/** 运行期用的上报句柄：带插件 id 与配置目录，插件只传 level/message。 */
export function createPluginHealthStore(pluginId: string, options: { configDir?: string } = {}): PluginHealthStore {
  const path = options.configDir ? resolvePluginHealthPath(pluginId, options.configDir) : null;
  return {
    path,
    read: () => readPluginHealth(pluginId, options),
    report: (report) => {
      writePluginHealth(pluginId, report, options);
    },
    clear: () => clearPluginHealth(pluginId, options),
  };
}

function normalizeHealthReport(input: unknown): PluginHealthReport | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const level = record.level;
  if (level !== 'ok' && level !== 'warn' && level !== 'error') return null;
  if (typeof record.message !== 'string') return null;
  const report: PluginHealthReport = {
    level,
    message: record.message,
    at: typeof record.at === 'string' ? record.at : '',
  };
  if (typeof record.hint === 'string' && record.hint) report.hint = record.hint;
  return report;
}

function truncate(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 300 ? `${single.slice(0, 300)}…` : single;
}
