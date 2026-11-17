import type { ReviewFinding, ReviewReport, RunSummary, ToolHealthRow } from './engine.js';
import { prioritizeFindings, summarizeProgress } from './progress.js';

/** Includes JSON indentation and escaping: a count limit alone is not a context budget. */
export const LIST_MAX_CHARS = 24_000;
const short = (text: string | undefined, max: number): string | undefined =>
  text === undefined || text.length <= max ? text : `${text.slice(0, max - 1)}…`;

function runSummary(run: RunSummary) {
  return {
    id: run.id,
    outcome: run.outcome,
    startedAt: short(run.startedAt, 40),
    finishedAt: short(run.finishedAt, 40),
    elapsedMs: run.elapsedMs,
    config: {
      providerId: short(run.config.providerId, 80),
      model: short(run.config.model, 120),
    },
    requestCount: run.requestCount,
    requestMsTotal: run.requestMsTotal,
    requestMsMax: run.requestMsMax,
    toolCalls: run.toolCalls,
    toolErrors: run.toolErrors,
    expectedExits: run.expectedExits,
    retries: run.retries,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cachedInputTokens: run.cachedInputTokens,
    droppedEvents: run.droppedEvents,
    compactions: run.compactions,
    corrections: run.corrections,
    mode: short(run.mode, 40),
    host: short(run.host, 40),
    plugins: run.plugins
      ? {
          host: short(run.plugins.host, 40),
          loaded: run.plugins.loaded,
          hash: run.plugins.hash,
          failed: run.plugins.failed.slice(0, 3).map((id) => short(id, 80)),
          failedCount: run.plugins.failed.length,
          skipped: run.plugins.skipped.slice(0, 3).map((id) => short(id, 80)),
          skippedCount: run.plugins.skipped.length,
        }
      : undefined,
    traceFile: short(run.traceFile, 512),
  };
}

function findingSummary(finding: ReviewFinding) {
  return {
    id: finding.id,
    kind: finding.kind,
    title: short(finding.title, 180),
    module: short(finding.module, 120),
    status: finding.status,
    occurrences: finding.occurrences,
    recentOccurrences: finding.recentOccurrences,
    recentRuns: finding.recentRuns,
    firstSeenAt: short(finding.firstSeenAt, 40),
    lastSeenAt: short(finding.lastSeenAt, 40),
    timing: finding.timing,
    reviewNeeded: finding.reviewNeeded,
    suggestion: short(finding.suggestion, 240),
    evaluation: short(finding.evaluation, 200),
    note: short(finding.note, 160),
    assessmentCount: finding.assessments?.length ?? 0,
    evidenceCount: finding.evidence.length,
    evidence: finding.evidence.slice(0, 1).map(({ runId, seq, available, detail }) => ({
      runId: short(runId, 80),
      seq,
      available,
      detail: short(detail, 160),
    })),
  };
}

function toolSummary(row: ToolHealthRow) {
  return {
    name: short(row.name, 160),
    calls: row.calls,
    errors: row.errors,
    errorRate: row.errorRate,
    categories: row.categories.slice(0, 3).map(({ category, count }) => ({ category: short(category, 80), count })),
    categoryCount: row.categories.length,
  };
}

/** The full report is exported once from the same snapshot; no unbounded report object is spread here. */
export function summarizeList(report: ReviewReport, reportPath: string) {
  const runs = report.runs.filter((run) => !run.helper);
  const result = {
    version: report.version,
    generatedAt: report.generatedAt,
    cwd: short(report.cwd, 240),
    coverage: report.coverage,
    progress: summarizeProgress(report.findings),
    toolHealthCoverage: report.toolHealthCoverage,
    derivationCoverage: report.derivationCoverage,
    totalRuns: runs.length,
    totalFindings: report.findings.length,
    metrics: runs.reduce(
      (sum, run) => ({
        requests: sum.requests + run.requestCount,
        tools: sum.tools + run.toolCalls,
        toolErrors: sum.toolErrors + run.toolErrors,
        retries: sum.retries + run.retries,
      }),
      { requests: 0, tools: 0, toolErrors: 0, retries: 0 },
    ),
    runs: runs.slice(0, 20).map(runSummary),
    findings: prioritizeFindings(report.findings).slice(0, 20).map(findingSummary),
    toolHealth: report.toolHealth.slice(0, 15).map(toolSummary),
    delegation: {
      parents: report.delegation.parents.length,
      types: report.delegation.parents.reduce((sum, parent) => sum + parent.types.length, 0),
      runs: report.delegation.parents.reduce(
        (sum, parent) => sum + parent.types.reduce((total, row) => total + row.runs, 0),
        0,
      ),
    },
    helpers: { total: report.helpers.total, sources: report.helpers.kinds.length },
    pluginFailureCount: report.pluginFailures.length,
    pluginFailureCountInterpretation:
      'lower-bound; machine-wide; host restarts, forced exits and rotation may leave history incomplete',
    pluginFailures: report.pluginFailures.slice(0, 5).map((failure) => ({
      pluginId: short(failure.pluginId, 120),
      taskId: short(failure.taskId, 120),
      count: failure.count,
      lastAt: short(failure.lastAt, 40),
      lastError: short(failure.lastError, 200),
    })),
    logEvidence: report.logEvidence
      ? {
          scope: report.logEvidence.scope,
          coverage: report.logEvidence.coverage,
          operations: report.logEvidence.operations.slice(0, 5),
          experience: report.logEvidence.experience.slice(0, 5),
          system: report.logEvidence.system.slice(0, 5),
          memory: report.logEvidence.memory.slice(0, 5),
          groups: {
            operations: report.logEvidence.operations.length,
            experience: report.logEvidence.experience.length,
            system: report.logEvidence.system.length,
            memory: report.logEvidence.memory.length,
          },
          interpretation: short(report.logEvidence.interpretation, 600),
        }
      : undefined,
    warningCount: report.warnings.length,
    warnings: report.warnings.slice(0, 3).map((warning) => short(warning, 240)!),
    reportPath,
    interpretation: short(report.interpretation, 600),
    displayLimit: '摘要含截断字段与计数；完整 warnings、证据、评估历史、委派与 helper 明细见 reportPath。',
    outputBudget: { maxChars: LIST_MAX_CHARS, omittedRuns: 0, omittedFindings: 0, omittedTools: 0, omittedWarnings: 0 },
  };
  const counts = () => {
    result.outputBudget.omittedRuns = runs.length - result.runs.length;
    result.outputBudget.omittedFindings = report.findings.length - result.findings.length;
    result.outputBudget.omittedTools = report.toolHealth.length - result.toolHealth.length;
    result.outputBudget.omittedWarnings = report.warnings.length - result.warnings.length;
  };
  counts();
  // Drop the largest optional section first, retaining the highest-priority finding
  // and a tool-health row. The core coverage/progress facts never get squeezed out.
  while (JSON.stringify(result, null, 2).length > LIST_MAX_CHARS) {
    const sections: unknown[][] = [
      result.runs,
      result.findings,
      result.toolHealth,
      result.pluginFailures,
      result.warnings,
      ...(result.logEvidence
        ? [
            result.logEvidence.operations,
            result.logEvidence.experience,
            result.logEvidence.system,
            result.logEvidence.memory,
          ]
        : []),
    ];
    const largest = sections
      .filter((items) => items.length > 1)
      .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (!largest) throw new Error('复盘摘要的固定元数据超过字符预算，请用 action=report 读取详情路径。');
    largest.pop();
    counts();
  }
  return result;
}
