import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 插件日志：每个插件一份 JSONL，写在系统 temp 目录，出问题时直接 tail / grep。
 *
 * 插件跑在 CLI 进程里（TUI 或 app-server），拿不到 desktop `host/log.js` 的写入器，
 * 所以这里是一个独立的小实现，规则和它保持一致：
 *
 * - 目录 `os.tmpdir()/mica-logs/`，**不放用户 home**：日志是诊断产物，不该在用户目录里
 *   越积越多，macOS 开机也会清掉 temp；
 * - 一天一个文件，单文件超过 `MAX_FILE_BYTES` 就换下一个分片，不原地无限增长；
 * - 超过 `KEEP_DAYS` 天的旧分片在下次写入时清掉；
 * - 写盘失败、目录不可写一律吞掉：日志永远不能成为插件失败的原因。
 *
 * `MICA_PLUGIN_LOG=0` 关闭落盘（仍然转发给 host 的 logger）。
 */
const LOG_DIR_NAME = 'mica-logs';
const PLUGIN_FILE_PREFIX = 'plugin-';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const KEEP_DAYS = 3;

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
};

/** 插件日志目录。与 desktop `host/log.js` 同一个目录，只是文件前缀不同。 */
export function pluginLogDir(options: PluginLogOptions = {}): string {
  return options.dir ?? join(tmpdir(), LOG_DIR_NAME);
}

/**
 * 这个插件今天正在写的日志文件。
 *
 * 目录还不存在（进程还没产生任何日志）时也返回路径：配置页要展示「日志在哪」，
 * 不能因为暂时没有文件就显示空。
 */
export function pluginLogPath(pluginId: string, options: PluginLogOptions = {}): string {
  const base = join(pluginLogDir(options), `${PLUGIN_FILE_PREFIX}${safeFileName(pluginId)}-${dayStamp(Date.now())}`);
  const existing = nextFreePath(base);
  return `${existing}.jsonl`;
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
      appendLine(pluginId, { time: new Date().toISOString(), plugin: pluginId, level, event, data }, options);
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

function appendLine(
  pluginId: string,
  entry: { time: string; plugin: string; level: string; event: string; data?: PluginLogPayload },
  options: PluginLogOptions,
): void {
  const dir = pluginLogDir(options);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const base = join(dir, `${PLUGIN_FILE_PREFIX}${safeFileName(pluginId)}-${dayStamp(Date.now())}`);
  appendFileSync(`${nextFreePath(base)}.jsonl`, `${JSON.stringify(entry)}\n`, 'utf-8');
  pruneOldFiles(dir, Date.now());
}

/**
 * 当天第几个分片：同一份日志超过上限就换下一个 `-1.jsonl`，而不是原地截断。
 * 保留分片而不是丢弃内容，排查「刚才那次为什么失败」才有价值。
 */
function nextFreePath(base: string): string {
  for (let index = 0; ; index += 1) {
    const candidate = index === 0 ? base : `${base}-${index}`;
    const file = `${candidate}.jsonl`;
    try {
      if (!existsSync(file) || statSync(file).size < MAX_FILE_BYTES) return candidate;
    } catch {
      return candidate;
    }
  }
}

function pruneOldFiles(dir: string, now: number): void {
  const cutoff = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(PLUGIN_FILE_PREFIX) || !name.endsWith('.jsonl')) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
    } catch {
      // 文件在扫描与删除之间消失，或者没有权限：都不影响记录本次日志。
    }
  }
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

function dayStamp(now: number): string {
  const date = new Date(now);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('');
}

function safeFileName(pluginId: string): string {
  return pluginId.replace(/[^A-Za-z0-9._-]+/g, '_');
}
