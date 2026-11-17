import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';

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
 * - 每个 issue 只存最近一条，读取聚合取最高严重度；业务恢复不能覆盖依赖降级。
 * - 每条都带写它的插件版本：换了版本之后这一条就不作数了。上一版留下的「连不上 X」
 *   会让用户去修一个这一版可能早就不存在的问题——宁可不显示，也不显示错的那条。
 */
export const PLUGIN_HEALTH_DIR = 'plugin-health';
export const DEFAULT_PLUGIN_HEALTH_ISSUE = 'runtime';

type HealthDocument = { schemaVersion: 2; issues: Record<string, PluginHealthReport> };
type PendingHealth = {
  updates: Map<string, PluginHealthReport | null>;
  timer?: ReturnType<typeof setTimeout>;
};
const pendingWrites = new Map<string, PendingHealth>();

function commitHealth(file: string, issueKey: string, report: PluginHealthReport | null): void {
  const pending = pendingWrites.get(file) ?? { updates: new Map() };
  pending.updates.set(issueKey, report);
  pendingWrites.set(file, pending);
  flushHealth(file, pending);
}

function flushHealth(file: string, pending: PendingHealth): void {
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = undefined;
  }
  const release = acquireProcessLock(`${file}.lock`);
  if (!release) {
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      try {
        flushHealth(file, pending);
      } catch {
        pendingWrites.delete(file);
        // Health reporting must not raise an uncaught asynchronous IO error.
      }
    }, 25);
    pending.timer.unref?.();
    return;
  }
  try {
    // Read inside the same cross-process lock as the write. Never queue a whole
    // document: another host may update a different issue before this lock is free.
    preserveUnsupportedHealth(file);
    const document = readHealthDocument(file);
    for (const [issueKey, report] of pending.updates) {
      if (report) document.issues[issueKey] = report;
      else delete document.issues[issueKey];
    }
    writeTextFileAtomic(file, `${JSON.stringify(document, null, 2)}\n`);
    pendingWrites.delete(file);
  } finally {
    release();
  }
}

export type PluginHealthLevel = 'ok' | 'warn' | 'error';

/** 插件能上报的一条状态。`detail` 给人看，不要放凭据。 */
export type PluginHealthReport = {
  /** 独立恢复边界；缺省业务状态为 runtime，依赖应使用自己的固定 key。 */
  issueKey: string;
  level: PluginHealthLevel;
  /** 一句话说明，例如「未配置 baseUrl」「上一次请求失败：401」。 */
  message: string;
  /** 可选的处理建议，例如「到插件设置里填写 API Key」。 */
  hint?: string;
  /** ISO 时间，由写入方填。 */
  at: string;
  /** 写这条记录的插件版本；读的一方按它判断这条还算不算数。 */
  version?: string;
};

export type PluginHealthInput = {
  issueKey?: string;
  level: PluginHealthLevel;
  message: string;
  hint?: string;
};

export type PluginHealthStore = {
  readonly path: string | null;
  /** 最高严重度的当前状态（同级取最近上报）；也可只读一个 issue。 */
  read(issueKey?: string): PluginHealthReport | null;
  /** ok 只恢复指定 issue（缺省 runtime），不会抹掉其它 issue。 */
  report(report: PluginHealthInput): void;
  /** 只清指定 issue，缺省只清业务状态，不提供隐式「清全部」。 */
  clear(issueKey?: string): void;
};

export function resolvePluginHealthPath(pluginId: string, configDir: string): string {
  return join(configDir, PLUGIN_HEALTH_DIR, `${pluginId.replace(/[\\/]/g, '_')}.json`);
}

export function readPluginHealth(
  pluginId: string,
  options: { configDir?: string; version?: string; issueKey?: string } = {},
): PluginHealthReport | null {
  if (!options.configDir) return null;
  const file = resolvePluginHealthPath(pluginId, options.configDir);
  const issues = readHealthDocument(file).issues;
  const levels: Record<PluginHealthLevel, number> = { ok: 0, warn: 1, error: 2 };
  let current: PluginHealthReport | null = null;
  for (const report of Object.values(issues)) {
    if (options.issueKey !== undefined && report.issueKey !== options.issueKey) continue;
    // 传了版本就以它为准：版本对不上（含没写版本的记录）不代表这一版的状态。
    if (options.version && report.version !== options.version) continue;
    if (!current || levels[report.level] > levels[current.level] ||
      (report.level === current.level && report.at >= current.at)) current = report;
  }
  return current;
}

export function writePluginHealth(
  pluginId: string,
  report: PluginHealthInput,
  options: { configDir?: string; version?: string } = {},
): PluginHealthReport | null {
  if (!options.configDir) return null;
  const normalized: PluginHealthReport = {
    issueKey: normalizeIssueKey(report.issueKey),
    level: report.level,
    message: truncate(report.message),
    at: new Date().toISOString(),
  };
  if (report.hint) normalized.hint = truncate(report.hint);
  if (options.version) normalized.version = options.version;
  const file = resolvePluginHealthPath(pluginId, options.configDir);
  commitHealth(file, normalized.issueKey, normalized);
  return normalized;
}

export function clearPluginHealth(
  pluginId: string,
  options: { configDir?: string; issueKey?: string } = {},
): void {
  if (!options.configDir) return;
  const file = resolvePluginHealthPath(pluginId, options.configDir);
  if (!existsSync(file) && !pendingWrites.has(file)) return;
  try {
    commitHealth(file, normalizeIssueKey(options.issueKey), null);
  } catch {
    // 上报是辅助信息，清不掉也不该影响插件本身。
  }
}

/** 运行期用的上报句柄：带插件 id 与配置目录，插件只传 level/message。 */
export function createPluginHealthStore(
  pluginId: string,
  options: { configDir?: string; version?: string } = {},
): PluginHealthStore {
  const path = options.configDir ? resolvePluginHealthPath(pluginId, options.configDir) : null;
  return {
    path,
    read: (issueKey) => readPluginHealth(pluginId, { ...options, issueKey }),
    report: (report) => {
      writePluginHealth(pluginId, report, options);
    },
    clear: (issueKey) => clearPluginHealth(pluginId, { ...options, issueKey }),
  };
}

function readHealthDocument(file: string): HealthDocument {
  const empty: HealthDocument = { schemaVersion: 2, issues: Object.create(null) };
  try {
    const input: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return empty;
    const document = input as Record<string, unknown>;
    // The old single-report shape is no longer supported; Evolution migrates it.
    if (document.schemaVersion !== 2 || !document.issues || typeof document.issues !== 'object' ||
      Array.isArray(document.issues)) return empty;
    for (const [issueKey, value] of Object.entries(document.issues)) {
      if (!isIssueKey(issueKey)) continue;
      const report = normalizeHealthReport(value, issueKey);
      if (report) empty.issues[issueKey] = report;
    }
  } catch {
    // Health is derived state; a missing or corrupt document cannot stop startup.
  }
  return empty;
}

/** A runtime can report before Evolution. Preserve old bytes rather than overwrite them first. */
function preserveUnsupportedHealth(file: string): void {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  try {
    const value = JSON.parse(raw);
    if (value?.schemaVersion === 2 && value.issues && typeof value.issues === 'object' && !Array.isArray(value.issues)) return;
  } catch { /* unsupported/corrupt derived state is archived, never interpreted */ }
  const archive = join(dirname(file), 'archive');
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  const target = join(archive, `${basename(file)}.${createHash('sha256').update(raw).digest('hex')}`);
  try { writeFileSync(target, raw, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

function normalizeHealthReport(input: unknown, issueKey: string): PluginHealthReport | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const level = record.level;
  if (level !== 'ok' && level !== 'warn' && level !== 'error') return null;
  if (typeof record.message !== 'string') return null;
  const report: PluginHealthReport = {
    issueKey,
    level,
    message: record.message,
    at: typeof record.at === 'string' ? record.at : '',
  };
  if (typeof record.hint === 'string' && record.hint) report.hint = record.hint;
  if (typeof record.version === 'string' && record.version) report.version = record.version;
  return report;
}

function isIssueKey(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/.test(value) &&
    value !== '__proto__' && value !== 'constructor' && value !== 'prototype';
}

function normalizeIssueKey(value: string | undefined): string {
  if (value === undefined) return DEFAULT_PLUGIN_HEALTH_ISSUE;
  if (!isIssueKey(value)) throw new Error('Invalid plugin health issue key');
  return value;
}

function truncate(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 300 ? `${single.slice(0, 300)}…` : single;
}
