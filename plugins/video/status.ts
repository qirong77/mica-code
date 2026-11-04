import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';

/**
 * 插件自己的运行状态。
 *
 * 配置页详情页读的是 `$MICA_HOME/plugin-data/video/data.json`（清单 `status` 声明了哪几行），
 * 页面不认识任何具体插件，也不会替它编造值——没写过的键就显示「尚未上报」。
 */

const PLUGIN_ID = 'video';
const DATA_NAME = 'data.json';

export type VideoStatus = {
  ffmpeg: { text: string; tone?: 'ok' | 'warn' | 'error' };
  cache: { text: string; tone?: 'ok' | 'warn' | 'error' };
  updatedAt: number;
};

export function pluginDataDir(): string {
  return join(resolveMicaHome(), 'plugin-data', PLUGIN_ID);
}

export function publishStatus(ctx: PluginContext, status: Omit<VideoStatus, 'updatedAt'>): void {
  try {
    const dir = pluginDataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DATA_NAME), `${JSON.stringify({ ...status, updatedAt: Date.now() }, null, 2)}\n`, 'utf8');
  } catch (error) {
    // 状态写不进去不影响抽帧本身。
    ctx.logger.warn('video:status-write-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}
