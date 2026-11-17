import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { readPluginHealth } from '@packages/mica-plugin/PluginHealth.js';
import { readDisabledPluginIds } from '@packages/mica-plugin/PluginState.js';
import type { PluginWebContext } from '@packages/mica-plugin/PluginWeb.js';
import type { ConsoleFinding, ConsolePlugin, ConsoleRun, ConsoleSnapshot } from './console-types.js';
import { CLASSIFIER_VERSION, HarnessRecorder, consoleText, type ReviewReport, type RunSummary } from './engine.js';
import { fileSignature } from './derived-index.js';
import type { LogEvidence } from './log-evidence.js';
import { prioritizeFindings, progressGroup, summarizeProgress } from './progress.js';

export const CONSOLE_TTL_MS = 30_000;
export const CONSOLE_MAX_BYTES = 900 * 1024;
const MAX_STATUS_BYTES = 1024 * 1024;
const LIMITS = { runs: 200, findings: 200, toolHealth: 60, plugins: 100, pluginFailures: 100, warnings: 40 } as const;
const INTERPRETATION =
  '全机只读、有界统计，不是完整历史或当前所有活进程的状态。主运行、委派和 helper 分开计数；running 仅表示尚无收尾记录，不证明进程仍在运行；interrupted 与错误分开，结果未知。completed/operation success 只表示处理器结束，不等于用户验收。装配表仅为 assembly.host 在 assembly.updatedAt 写下的最后共享快照，未知版本的健康状态只是上次上报。取消、忙、等待与失败不同，仅 error/timeout 计操作错误；只有 start 没有 finish 的操作为未知。插件失败次数是下界；错误原文、prompt/input、轨迹路径均不返回。数组可能缩减，counts 保留缩减前总数；扫描/保留期/时间覆盖的未知不能解读为零问题。';

type Assembly = {
  assembly: ConsoleSnapshot['assembly'];
  loading: Map<string, ConsolePlugin['loading']>;
  warnings: string[];
};
type ProjectionOptions = {
  recording: ConsoleSnapshot['recording'];
  plugins: ConsolePlugin[];
  pluginCount?: number;
  assembly: ConsoleSnapshot['assembly'];
  warnings?: string[];
};
export type ConsoleServiceOptions = {
  now?: () => number;
  readReport?: (signal: AbortSignal) => Promise<ReviewReport>;
};

function abortError(): DOMException {
  return new DOMException('Harness console request was cancelled.', 'AbortError');
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
function rethrowAbort(error: unknown, signal?: AbortSignal): void {
  checkAbort(signal);
  if (error instanceof Error && error.name === 'AbortError') throw error;
}
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, value) : 0;
const date = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
};
const pluginId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value);
const text = (value: unknown, max = 240): string => {
  if (typeof value !== 'string') return '';
  // Trace references can also occur inside an old assessment or warning. Do not
  // turn them into a path disclosure (and never expose an arbitrary-file URL).
  const safe = value.replace(/(?:[A-Za-z]:[\\/]|\/)[^\r\n<>"`]*?events\.jsonl/g, '[trace omitted]');
  return consoleText(safe, max);
};
function warningText(value: string): string {
  if (/unreadable|corrupt|cannot list|missing or unreadable|persistence error|correction queue/i.test(value))
    return '部分复盘数据无法读取或核验，覆盖不完整（不返回诊断原文）。';
  return text(value, 320);
}

function projectRun(run: RunSummary): ConsoleRun {
  const source = run.helper ? 'helper' : run.delegation ? 'delegation' : 'main';
  return {
    id: text(run.id, 80),
    sessionTitle: run.sessionTitle === null ? null : text(run.sessionTitle, 180),
    ...(run.cwd ? { cwd: text(run.cwd) } : {}),
    source,
    sourceLabel: text(run.helper?.kind ?? run.delegation?.type ?? 'main', 100),
    providerId: text(run.config.providerId, 80),
    model: text(run.config.model, 120),
    outcome: run.outcome,
    startedAt: date(run.startedAt) ?? '',
    ...(date(run.finishedAt) ? { finishedAt: date(run.finishedAt) } : {}),
    ...(run.elapsedMs !== undefined ? { elapsedMs: count(run.elapsedMs) } : {}),
    requestCount: count(run.requestCount),
    toolCalls: count(run.toolCalls),
    toolErrors: count(run.toolErrors),
    retries: count(run.retries),
    inputTokens: count(run.inputTokens),
    outputTokens: count(run.outputTokens),
    droppedEvents: count(run.droppedEvents),
  };
}

function projectFinding(finding: ReviewReport['findings'][number]): ConsoleFinding {
  return {
    id: text(finding.id, 240),
    kind: finding.kind,
    title: text(finding.title, 180),
    module: text(finding.module, 120),
    status: finding.status,
    group: progressGroup(finding),
    ...(finding.cwd ? { cwd: text(finding.cwd) } : {}),
    occurrences: count(finding.occurrences),
    ...(finding.recentOccurrences !== undefined ? { recentOccurrences: count(finding.recentOccurrences) } : {}),
    ...(finding.recentRuns !== undefined ? { recentRuns: count(finding.recentRuns) } : {}),
    ...(date(finding.firstSeenAt) ? { firstSeenAt: date(finding.firstSeenAt) } : {}),
    ...(date(finding.lastSeenAt) ? { lastSeenAt: date(finding.lastSeenAt) } : {}),
    ...(finding.reviewNeeded
      ? {
          reviewNeeded: {
            reason: finding.reviewNeeded.reason,
            occurrences: count(finding.reviewNeeded.occurrences),
            runs: count(finding.reviewNeeded.runs),
          },
        }
      : {}),
    suggestion: text(finding.suggestion, 320),
    // Plugin-background evaluation embeds lastError in the recorder's full
    // report. The console deliberately uses fixed guidance instead.
    evaluation:
      finding.kind === 'plugin-background'
        ? '检查插件配置和依赖后，在下一个实际操作中核实恢复；错误原文仅留在本机复盘中。'
        : text(finding.evaluation, 320),
    ...(finding.note ? { note: text(finding.note, 320) } : {}),
    evidenceCount: finding.evidence.length,
    evidence: finding.evidence.slice(0, 4).map((item) => ({
      runId: text(item.runId, 80),
      seq: count(item.seq),
      available: item.available === true,
    })),
  };
}

function projectLogs(logs: LogEvidence | undefined): LogEvidence | null {
  if (!logs) return null;
  const c = logs.coverage;
  return {
    scope: 'machine',
    coverage: {
      candidateFiles: count(c.candidateFiles),
      scannedFiles: count(c.scannedFiles),
      omittedFiles: count(c.omittedFiles),
      unreadableFiles: count(c.unreadableFiles),
      inspectedBytes: count(c.inspectedBytes),
      truncatedFiles: count(c.truncatedFiles),
      malformedLines: count(c.malformedLines),
      ignoredLines: count(c.ignoredLines),
      partialLines: count(c.partialLines),
      rowLimitReached: c.rowLimitReached === true,
      groupLimitReached:
        c.groupLimitReached === true ||
        [logs.operations, logs.experience, logs.system, logs.memory].some((rows) => rows.length > 100),
      ...(date(c.earliestAt) ? { earliestAt: date(c.earliestAt) } : {}),
      ...(date(c.latestAt) ? { latestAt: date(c.latestAt) } : {}),
    },
    operations: logs.operations.slice(0, 100).map((row) => ({
      plugin: text(row.plugin, 160),
      ...(row.pluginVersion ? { pluginVersion: text(row.pluginVersion, 60) } : {}),
      operation: text(row.operation, 80),
      ...(row.surface ? { surface: text(row.surface, 40) } : {}),
      outcome: row.finishes > 0 ? text(row.outcome, 40) || 'unknown' : 'unknown',
      ...(row.code ? { code: text(row.code, 60) } : {}),
      starts: count(row.starts),
      finishes: count(row.finishes),
      totalMs: count(row.totalMs),
      maxMs: count(row.maxMs),
    })),
    experience: logs.experience.slice(0, 100).map((row) => ({
      plugin: text(row.plugin, 160),
      pluginVersion: text(row.pluginVersion, 60),
      event: text(row.event, 40),
      ...(row.surface ? { surface: text(row.surface, 40) } : {}),
      ...(row.action ? { action: text(row.action, 48) } : {}),
      ...(row.outcome ? { outcome: text(row.outcome, 40) } : {}),
      records: count(row.records),
      count: count(row.count),
    })),
    system: logs.system.slice(0, 100).map((row) => ({
      scope: text(row.scope, 80),
      event: text(row.event, 80),
      level: text(row.level, 16),
      count: count(row.count),
      crashes: count(row.crashes),
    })),
    memory: logs.memory.slice(0, 100).map((row) => ({
      ...(row.pid !== undefined ? { pid: count(row.pid) } : {}),
      samples: count(row.samples),
      peakRssMB: count(row.peakRssMB),
      ...(row.peakHeapMB !== undefined ? { peakHeapMB: count(row.peakHeapMB) } : {}),
    })),
    interpretation:
      'Machine-wide bounded log tails, not run/workspace attribution. Starts without finishes are unknown; success is not user validation. Counts/peaks cover inspected records only; raw errors, commands, URLs and bodies are omitted.',
  };
}

/** Pure one-way projection: never spread a RunSummary, finding, log envelope or health document. */
export function projectConsoleSnapshot(report: ReviewReport, options: ProjectionOptions): ConsoleSnapshot {
  const warnings = [...report.warnings.map(warningText), ...(options.warnings ?? []).map((value) => text(value, 320))];
  const totals: ConsoleSnapshot['totals'] = {
    mainRuns: 0,
    delegatedRuns: 0,
    helperRuns: 0,
    running: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    aborted: 0,
    paused: 0,
    requests: 0,
    tools: 0,
    toolErrors: 0,
    retries: 0,
    inputTokens: 0,
    outputTokens: 0,
    droppedEvents: 0,
  };
  for (const run of report.runs) {
    totals[run.helper ? 'helperRuns' : run.delegation ? 'delegatedRuns' : 'mainRuns']++;
    if (run.outcome === 'error') totals.failed++;
    else if (run.outcome in totals)
      totals[run.outcome as 'running' | 'completed' | 'interrupted' | 'aborted' | 'paused']++;
    totals.requests += count(run.requestCount);
    totals.tools += count(run.toolCalls);
    totals.toolErrors += count(run.toolErrors);
    totals.retries += count(run.retries);
    totals.inputTokens += count(run.inputTokens);
    totals.outputTokens += count(run.outputTokens);
    totals.droppedEvents += count(run.droppedEvents);
  }
  for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] = count(totals[key]);
  const c = report.coverage;
  const d = report.derivationCoverage;
  const snapshot: ConsoleSnapshot = {
    version: 1,
    generatedAt: date(report.generatedAt) ?? '',
    refreshAfterMs: CONSOLE_TTL_MS,
    classifierVersion: CLASSIFIER_VERSION,
    recording: {
      enabled: options.recording.enabled === true,
      captureContent: options.recording.captureContent === true,
    },
    totals,
    progress: summarizeProgress(report.findings),
    coverage: {
      totalRunDirectories: count(c.totalRunDirectories),
      scannedRunDirectories: count(c.scannedRunDirectories),
      includedRuns: count(c.includedRuns),
      scanLimitReached: c.scanLimitReached === true,
      runLimitReached: c.runLimitReached === true,
      unreadableSummaries: count(c.unreadableSummaries),
      directoryReadFailed: c.directoryReadFailed === true,
      windowStart: date(c.windowStart) ?? '',
      windowEnd: date(c.windowEnd) ?? '',
      ...(date(c.earliestRunStartedAt) ? { earliestRunStartedAt: date(c.earliestRunStartedAt) } : {}),
      ...(date(c.latestRunFinishedAt) ? { latestRunFinishedAt: date(c.latestRunFinishedAt) } : {}),
    },
    toolHealthCoverage: {
      includedRuns: count(report.toolHealthCoverage.includedRuns),
      excludedRuns: count(report.toolHealthCoverage.excludedRuns),
      unknownResults: count(report.toolHealthCoverage.unknownResults),
    },
    derivationCoverage: {
      limitedRuns: count(d.limitedRuns),
      callObservationsNotTracked: count(d.callObservationsNotTracked),
      findingSignalsNotRecorded: count(d.findingSignalsNotRecorded),
      unknownRuns: count(d.unknownRuns),
    },
    limits: {
      runs: count(report.limits.runs),
      findingsPerRun: count(report.limits.findingsPerRun),
      distinctCallKeysPerRun: count(report.limits.distinctCallKeysPerRun),
      evidencePerFinding: count(report.limits.evidencePerFinding),
    },
    runs: report.runs.slice(0, LIMITS.runs).map(projectRun),
    findings: prioritizeFindings(report.findings).slice(0, LIMITS.findings).map(projectFinding),
    toolHealth: report.toolHealth.slice(0, LIMITS.toolHealth).map((row) => ({
      name: text(row.name, 120),
      calls: count(row.calls),
      errors: count(row.errors),
      errorRate: Math.min(1, count(row.errorRate)),
      categories: row.categories
        .slice(0, 3)
        .map((entry) => ({ category: text(entry.category, 80), count: count(entry.count) })),
    })),
    pluginFailures: report.pluginFailures.slice(0, LIMITS.pluginFailures).map((row) => ({
      pluginId: text(row.pluginId, 160),
      taskId: text(row.taskId, 160),
      count: count(row.count),
      lastAt: date(row.lastAt) ?? '',
      lastError: '',
    })),
    plugins: options.plugins.slice(0, LIMITS.plugins).map((row) => ({
      id: text(row.id, 160),
      name: text(row.name, 100),
      ...(row.version ? { version: text(row.version, 60) } : {}),
      enabled: row.enabled === true,
      loading: row.loading,
      health: row.health
        ? { level: row.health.level, message: text(row.health.message, 200), at: date(row.health.at) ?? '' }
        : null,
      operationStarts: count(row.operationStarts),
      operationFinishes: count(row.operationFinishes),
      operationErrors: count(row.operationErrors),
      impressions: count(row.impressions),
      clicks: count(row.clicks),
    })),
    assembly: {
      host: options.assembly.host ? text(options.assembly.host, 40) : null,
      updatedAt: date(options.assembly.updatedAt) ?? null,
      unreadable: options.assembly.unreadable === true,
    },
    logEvidence: projectLogs(report.logEvidence),
    warnings: [],
    counts: {
      runs: report.runs.length,
      findings: report.findings.length,
      toolHealth: report.toolHealth.length,
      pluginFailures: report.pluginFailures.length,
      plugins: options.pluginCount ?? options.plugins.length,
      warnings: 0,
    },
    interpretation: INTERPRETATION,
  };
  const omitted = (warningRoom: number): string => {
    const arrays = (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).filter((key) => key !== 'warnings');
    const rows = arrays.map((key) => `${key}=${snapshot.counts[key] - snapshot[key].length}`).join(', ');
    const logs = snapshot.logEvidence;
    const source = report.logEvidence;
    const logRows =
      source && logs
        ? (['operations', 'experience', 'system', 'memory'] as const)
            .map((key) => `${key}=${source[key].length - logs[key].length}`)
            .join(', ')
        : 'none';
    return `展示省略：${rows}；日志分组：${logRows}；warnings=${Math.max(0, warnings.length - warningRoom)}。总量与覆盖口径不变，每项证据最多展示 4 条，不返回错误原文。`;
  };
  let warningLimit: number = LIMITS.warnings;
  const syncWarnings = (): void => {
    const arraysOmitted = (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).some(
      (key) => key !== 'warnings' && snapshot.counts[key] > snapshot[key].length,
    );
    const logsOmitted =
      snapshot.logEvidence &&
      report.logEvidence &&
      (['operations', 'experience', 'system', 'memory'] as const).some(
        (key) => snapshot.logEvidence![key].length < report.logEvidence![key].length,
      );
    const needsNote = Boolean(arraysOmitted || logsOmitted || warnings.length > warningLimit);
    const room = Math.max(0, warningLimit - Number(needsNote));
    snapshot.warnings = [...(needsNote ? [omitted(room)] : []), ...warnings.slice(0, room)];
    snapshot.counts.warnings = warnings.length + Number(needsNote);
  };
  syncWarnings();
  // Worst-case UTF-8 and JSON escaping are measured, not estimated. Optional
  // detail yields gradually; totals/counts and coverage always survive.
  while (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > CONSOLE_MAX_BYTES) {
    const arrays: unknown[][] = [
      snapshot.findings,
      snapshot.runs,
      snapshot.plugins,
      snapshot.pluginFailures,
      snapshot.toolHealth,
    ];
    if (snapshot.logEvidence)
      arrays.push(
        snapshot.logEvidence.operations,
        snapshot.logEvidence.experience,
        snapshot.logEvidence.system,
        snapshot.logEvidence.memory,
      );
    const largest = arrays
      .filter((rows) => rows.length)
      .sort((a, b) => Buffer.byteLength(JSON.stringify(b)) - Buffer.byteLength(JSON.stringify(a)))[0];
    if (largest) {
      largest.splice(Math.max(0, largest.length - Math.max(1, Math.ceil(largest.length / 8))));
      if (snapshot.logEvidence)
        snapshot.logEvidence.coverage.groupLimitReached ||= (
          ['operations', 'experience', 'system', 'memory'] as const
        ).some((key) => snapshot.logEvidence![key].length < (report.logEvidence?.[key].length ?? 0));
    } else if (warningLimit > 1) warningLimit = Math.max(1, Math.floor(warningLimit / 2));
    else break; // The fixed scalar core is < 8 KiB, even after JSON escaping.
    syncWarnings();
  }
  return snapshot;
}

async function readAssembly(configDir: string, signal: AbortSignal): Promise<Assembly> {
  const empty = (): Assembly => ({
    assembly: { host: null, updatedAt: null, unreadable: false },
    loading: new Map(),
    warnings: [],
  });
  checkAbort(signal);
  let handle;
  try {
    handle = await open(
      join(configDir, 'plugin-status.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_STATUS_BYTES) throw new Error('Invalid assembly file');
    const buffer = Buffer.alloc(MAX_STATUS_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      checkAbort(signal);
      const { bytesRead } = await handle.read(buffer, size, Math.min(128 * 1024, buffer.length - size), size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    checkAbort(signal);
    if (size > MAX_STATUS_BYTES || fileSignature(before) !== fileSignature(await handle.stat()))
      throw new Error('Unstable assembly file');
    const value = JSON.parse(buffer.toString('utf8', 0, size)) as Record<string, unknown>;
    if (
      !value ||
      !['tui', 'app-server'].includes(String(value.host)) ||
      !date(value.updatedAt) ||
      !Array.isArray(value.plugins)
    )
      throw new Error('Invalid assembly schema');
    const result = empty();
    result.assembly.host = String(value.host);
    result.assembly.updatedAt = date(value.updatedAt)!;
    for (const [index, entry] of value.plugins.entries()) {
      if (index % 128 === 0) await yieldImmediate(undefined, { signal });
      if (!entry || !pluginId(entry.id) || !['loaded', 'failed', 'skipped'].includes(entry.status))
        throw new Error('Invalid assembly entry');
      result.loading.set(entry.id, entry.status);
    }
    return result;
  } catch (error) {
    rethrowAbort(error, signal);
    const result = empty();
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.assembly.unreadable = true;
      result.warnings.push(
        'Shared plugin assembly snapshot is unreadable, invalid, changing or larger than 1 MiB; loading states are unknown.',
      );
    }
    return result;
  } finally {
    await handle?.close();
  }
}

async function readPlugins(
  context: PluginWebContext,
  report: ReviewReport,
  assembly: Assembly,
  signal: AbortSignal,
): Promise<{ plugins: ConsolePlugin[]; total: number }> {
  const known = new Map(context.catalog.filter((item) => pluginId(item.id)).map((item) => [item.id, item]));
  const ids = new Set([...known.keys(), ...assembly.loading.keys()]);
  for (const row of [...(report.logEvidence?.operations ?? []), ...(report.logEvidence?.experience ?? [])])
    if (pluginId(row.plugin)) ids.add(row.plugin);
  for (const row of report.pluginFailures) if (pluginId(row.pluginId)) ids.add(row.pluginId);
  checkAbort(signal);
  const disabled = readDisabledPluginIds({ path: join(context.paths.config, 'plugins-state.json') });
  const plugins: ConsolePlugin[] = [];
  for (const id of [...ids].sort().slice(0, LIMITS.plugins)) {
    await yieldImmediate(undefined, { signal });
    const manifest = known.get(id);
    let health: ConsolePlugin['health'] = null;
    try {
      const info = await lstat(join(context.paths.config, 'plugin-health', `${id}.json`));
      if (!info.isFile() || info.size > MAX_STATUS_BYTES) throw new Error('Invalid health file');
      checkAbort(signal);
      const last = readPluginHealth(id, {
        configDir: context.paths.config,
        ...(manifest?.version ? { version: manifest.version } : {}),
      });
      if (last)
        health = {
          level: last.level,
          at: date(last.at) ?? '',
          message: `${manifest?.version ? '' : '上次上报（当前版本未知）：'}${text(last.message, 160)}`,
        };
    } catch (error) {
      rethrowAbort(error, signal);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        assembly.warnings.push(`Health report for ${id} could not be read within its size limit; health is unknown.`);
    }
    const operations = report.logEvidence?.operations.filter((row) => row.plugin === id) ?? [];
    const experience = report.logEvidence?.experience.filter((row) => row.plugin === id) ?? [];
    plugins.push({
      id,
      name: manifest?.name ?? id,
      ...(manifest?.version ? { version: manifest.version } : {}),
      enabled: !disabled.has(id),
      loading: assembly.loading.get(id) ?? 'unknown',
      health,
      operationStarts: operations.reduce((sum, row) => sum + count(row.starts), 0),
      operationFinishes: operations.reduce((sum, row) => sum + count(row.finishes), 0),
      operationErrors: operations.reduce(
        (sum, row) => sum + (row.outcome === 'error' || row.outcome === 'timeout' ? count(row.finishes) : 0),
        0,
      ),
      impressions: experience.reduce((sum, row) => sum + (row.event === 'impression' ? count(row.count) : 0), 0),
      clicks: experience.reduce((sum, row) => sum + (row.event === 'click' ? count(row.count) : 0), 0),
    });
  }
  return { plugins, total: ids.size };
}

type Flight = { controller: AbortController; promise: Promise<ConsoleSnapshot>; waiters: number };

/** Lazy per-host read service. No setup, recording, timers, child processes or report export. */
export class HarnessConsoleService {
  private readonly now: () => number;
  private readonly readReport: (signal: AbortSignal) => Promise<ReviewReport>;
  private cached: { value: ConsoleSnapshot; expiresAt: number } | null = null;
  private flight: Flight | null = null;
  private readonly lifetime = new AbortController();
  private disposed = false;

  constructor(
    private readonly context: PluginWebContext,
    options: ConsoleServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    // The recorder constructor is IO-free; do not call setup or dispose/flush on
    // this read-only instance. Its only retained data are bounded derived indexes.
    const recorder = options.readReport ? null : new HarnessRecorder(context.paths.data);
    this.readReport = options.readReport ?? ((signal) => recorder!.review(undefined, { readOnly: true, signal }));
  }

  async snapshot(signal?: AbortSignal): Promise<ConsoleSnapshot> {
    checkAbort(signal);
    if (this.disposed) throw abortError();
    if (this.cached && this.now() < this.cached.expiresAt) return this.cached.value;
    if (this.flight?.controller.signal.aborted) {
      // Drain a cancelled scan before starting another. A caller arriving while
      // it drains can itself cancel, and must never leave a queued orphan scan.
      await this.waitForDrain(this.flight.promise, signal);
      return this.snapshot(signal);
    }
    if (!this.flight) this.start();
    return this.join(this.flight!, signal);
  }

  private start(): void {
    const controller = new AbortController();
    const flight: Flight = { controller, waiters: 0, promise: undefined! };
    this.flight = flight;
    flight.promise = Promise.resolve()
      .then(async () => {
        checkAbort(controller.signal);
        const report = await this.readReport(controller.signal);
        checkAbort(controller.signal);
        const assembly = await readAssembly(this.context.paths.config, controller.signal);
        const { plugins, total } = await readPlugins(this.context, report, assembly, controller.signal);
        checkAbort(controller.signal);
        const settings = this.context.settings.get();
        const value = projectConsoleSnapshot(report, {
          recording: { enabled: settings.enabled !== 'false', captureContent: settings.captureContent !== 'false' },
          plugins,
          pluginCount: total,
          assembly: assembly.assembly,
          warnings: assembly.warnings,
        });
        // Deliver disconnect/dispose events that arrived during the bounded
        // synchronous projection before publishing its result.
        await yieldImmediate(undefined, { signal: controller.signal });
        checkAbort(controller.signal);
        if (this.disposed || this.flight !== flight || flight.waiters === 0) throw abortError();
        freeze(value);
        this.cached = { value, expiresAt: this.now() + CONSOLE_TTL_MS };
        return value;
      })
      .finally(() => {
        if (this.flight === flight) this.flight = null;
      });
    // All clients may disconnect before the cooperative reader settles.
    void flight.promise.catch(() => {});
  }

  private join(flight: Flight, signal?: AbortSignal): Promise<ConsoleSnapshot> {
    flight.waiters++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const settle = (value?: ConsoleSnapshot, error?: unknown): void => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', cancel);
        flight.controller.signal.removeEventListener('abort', cancel);
        flight.waiters--;
        if (flight.waiters === 0 && !value) flight.controller.abort();
        if (error !== undefined) reject(error);
        else resolve(value!);
      };
      const cancel = (): void => settle(undefined, abortError());
      signal?.addEventListener('abort', cancel, { once: true });
      flight.controller.signal.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted || flight.controller.signal.aborted) cancel();
      flight.promise.then(
        (value) => settle(value),
        (error) => settle(undefined, error),
      );
    });
  }

  private waitForDrain(promise: Promise<ConsoleSnapshot>, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        signal?.removeEventListener('abort', cancel);
        this.lifetime.signal.removeEventListener('abort', cancel);
      };
      const cancel = (): void => {
        cleanup();
        reject(abortError());
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.lifetime.signal.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted || this.lifetime.signal.aborted) cancel();
      promise.then(done, done);
      function done(): void {
        cleanup();
        resolve();
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cached = null;
    this.lifetime.abort();
    this.flight?.controller.abort();
    // Lifecycle completion means the cooperative readers have actually stopped,
    // not merely that HTTP waiters received cancellation.
    await this.flight?.promise.catch(() => {});
  }
}

function freeze(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  Object.freeze(value);
  for (const item of Object.values(value)) freeze(item);
}
