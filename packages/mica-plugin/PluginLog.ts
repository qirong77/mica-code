import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLogDir } from '@packages/mica-config/brand.js';
import { enqueueLogEntry, flushLogs } from '@packages/mica-diagnostics/index.js';

/**
 * 插件日志：每个插件一份 JSONL，和 desktop 运行时日志同一个目录，出问题时直接 tail / grep。
 *
 * 复用 mica-diagnostics 的有界批量写入器，不在每条事件的调用栈里扫描或写盘：
 *
 * - 目录来自 `resolveLogDir()`（macOS `~/Library/Logs/mica`），与运行时日志同处一地。
 *   不放系统 temp：temp 每次登录被清空，重启后连「上一个版本为什么失败」都查不到；
 *   堆积靠下面两条规则控制，而不是靠系统清空；
 * - 一天一个文件，单文件超过 `MAX_FILE_BYTES` 就换下一个分片，不原地无限增长；
 * - 超过 7 天的旧分片在批量写入时节流清掉，目录总容量由共享写入器兜底；
 * - 写盘失败、目录不可写一律吞掉：日志永远不能成为插件失败的原因。
 *
 * `MICA_PLUGIN_LOG=0` 关闭落盘（仍然转发给 host 的 logger）。
 */
const PLUGIN_FILE_PREFIX = 'plugin-';
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type PluginLogPayload = Record<string, unknown> | unknown;

export type PluginLogger = {
  info(event: string, data?: PluginLogPayload): void;
  warn(event: string, data?: PluginLogPayload): void;
  error(event: string, data?: PluginLogPayload): void;
};

export type PluginLogOptions = {
  /** 覆盖日志目录；测试与需要把日志收进隔离目录时用。 */
  dir?: string;
  /** 关闭落盘（仍然转发）。 */
  disabled?: boolean;
  /** 覆盖共享 writer 的分片大小；默认 2 MiB。 */
  fileMaxBytes?: number;
  /** 测试或一次性宿主需要立刻落盘时显式刷新共享批次。 */
  force?: boolean;
};

/** 插件日志目录。与 desktop `host/log.js` 同一个目录，只是文件前缀不同。 */
export function pluginLogDir(options: PluginLogOptions = {}): string {
  return options.dir ?? resolveLogDir();
}

/** 插件最新的实际日志文件；还没有日志时返回日志目录，不创建空日志。 */
export function pluginLogPath(pluginId: string, options: PluginLogOptions = {}): string {
  const dir = pluginLogDir(options);
  const prefix = `${PLUGIN_FILE_PREFIX}${safeFileName(pluginId)}-`;
  let latest: { name: string; day: string; shard: number } | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const match = /^(\d{8})(?:-([1-9]\d*))?\.jsonl$/.exec(entry.name.slice(prefix.length));
      if (!match) continue;
      const day = match[1]!;
      const date = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10).replace(/-/g, '') !== day) continue;
      const shard = Number(match[2] ?? 0);
      if (!Number.isSafeInteger(shard)) continue;
      if (!latest || day > latest.day || (day === latest.day && shard > latest.shard)) {
        latest = { name: entry.name, day, shard };
      }
    }
  } catch {
    // 日志目录不可读写时仍展示目录位置，不影响配置页。
  }
  return latest ? join(dir, latest.name) : dir;
}

/**
 * 为单个插件创建 logger。
 *
 * host 传入的 `fallback` 保留原有行为（TUI 静默、headless 写 stderr），文件日志是
 * 额外的一路——排查时不需要重跑一遍才能拿到现场。
 */
export function createPluginLogger(
  pluginId: string,
  fallback?: Partial<PluginLogger>,
  options: PluginLogOptions = {},
): PluginLogger {
  const write = (level: 'info' | 'warn' | 'error', event: string, data?: PluginLogPayload) => {
    forward(fallback, level, event, data);
    if (options.disabled || process.env.MICA_PLUGIN_LOG === '0') return;
    try {
      enqueueLogEntry(
        { at: Date.now(), scope: 'plugin', pluginId, plugin: pluginId, level, event, data },
        {
          dir: pluginLogDir(options),
          filePrefix: `${PLUGIN_FILE_PREFIX}${safeFileName(pluginId)}`,
          maxFileBytes: options.fileMaxBytes ?? MAX_FILE_BYTES,
        },
      );
      if (options.force) flushLogs();
    } catch {
      // 日志落到磁盘失败不影响插件本身。
    }
  };

  return {
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
  };
}

function forward(
  fallback: Partial<PluginLogger> | undefined,
  level: 'info' | 'warn' | 'error',
  event: string,
  data?: PluginLogPayload,
): void {
  try {
    fallback?.[level]?.(event, data);
  } catch {
    // host 的 logger 自己抛错时，插件不该跟着挂掉。
  }
}

function safeFileName(pluginId: string): string {
  return pluginId.replace(/[^A-Za-z0-9._-]+/g, '_');
}
