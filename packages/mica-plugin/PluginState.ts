import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMicaHomePath } from '@packages/mica-config/brand.js';

/**
 * 插件的启停状态。
 *
 * 它刻意不写进 `config.json`：那是「用户配置」，而这是「这台机器上这个运行时的插件账本」，
 * 和 `plugin-status.json` 一样属于本地状态。停用的插件在启动阶段就不会被注册，所以改完需要
 * 重启会话才生效——配置页会如实说明这一点。
 */

export const PLUGIN_STATE_FILE = 'plugins-state.json';

export type PluginState = {
  /** 被停用的插件 id。名单为空即全部启用。 */
  disabled: string[];
};

export type PluginStateOptions = {
  /** 状态文件路径；默认 `$MICA_HOME/plugins-state.json`。 */
  path?: string;
};

export function resolvePluginStatePath(options: PluginStateOptions = {}): string {
  return options.path ?? resolveMicaHomePath(PLUGIN_STATE_FILE);
}

export function readPluginState(options: PluginStateOptions = {}): PluginState {
  const path = resolvePluginStatePath(options);
  if (!existsSync(path)) return { disabled: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return normalizePluginState(parsed);
  } catch {
    // 坏文件不能让插件体系起不来：当作「全部启用」，下一次写入会覆盖它。
    return { disabled: [] };
  }
}

export function readDisabledPluginIds(options: PluginStateOptions = {}): Set<string> {
  return new Set(readPluginState(options).disabled);
}

export function writePluginState(state: PluginState, options: PluginStateOptions = {}): PluginState {
  const normalized = normalizePluginState(state);
  const path = resolvePluginStatePath(options);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${PLUGIN_STATE_FILE}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  renameSync(temporary, path);
  return normalized;
}

export function setPluginDisabled(id: string, disabled: boolean, options: PluginStateOptions = {}): PluginState {
  const pluginId = id.trim();
  if (!pluginId) throw new Error('插件 id 不能为空');
  const current = readPluginState(options);
  const next = new Set(current.disabled);
  if (disabled) next.add(pluginId);
  else next.delete(pluginId);
  return writePluginState({ disabled: [...next].sort() }, options);
}

export function normalizePluginState(input: unknown): PluginState {
  if (!isRecord(input) || !Array.isArray(input.disabled)) return { disabled: [] };
  const disabled = new Set<string>();
  for (const entry of input.disabled) {
    if (typeof entry === 'string' && entry.trim()) disabled.add(entry.trim());
  }
  return { disabled: [...disabled].sort() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
