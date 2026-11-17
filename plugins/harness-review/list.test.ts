import { describe, expect, it } from 'vitest';
import type { ReviewFinding, ReviewReport, RunSummary } from './engine.js';
import { LIST_MAX_CHARS, summarizeList } from './list.js';

const at = '2026-06-01T12:00:00.000Z';
const run: RunSummary = {
  version: 1,
  id: 'run',
  sourceRunId: 1,
  sessionId: 'session',
  sessionTitle: 'Task',
  config: { providerId: 'provider', model: 'model', protocol: 'openai', effort: 'none', role: 'default' },
  startedAt: at,
  finishedAt: at,
  outcome: 'completed',
  requestCount: 1,
  toolCalls: 1,
  toolErrors: 1,
  expectedExits: 0,
  retries: 1,
  compactions: { local: 0, llm: 0, idle: 0 },
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 10,
  droppedEvents: 0,
  eventCount: 4,
  traceFile: '/capture/runs/run/events.jsonl',
  promptHashes: [],
  findings: [],
};
const finding: ReviewFinding = {
  id: 'finding',
  kind: 'tool-error',
  title: 'Tool failed',
  module: 'test',
  status: 'open',
  suggestion: 'Check the failure',
  evaluation: 'Replay the request',
  occurrences: 1,
  recentOccurrences: 1,
  recentRuns: 1,
  firstSeenAt: at,
  lastSeenAt: at,
  evidence: [{ runId: run.id, seq: 3, available: true, traceFile: run.traceFile }],
};
function fixture(): ReviewReport {
  return {
    version: 1,
    root: '/capture',
    cwd: '/workspace',
    generatedAt: at,
    coverage: {
      totalRunDirectories: 1,
      scannedRunDirectories: 1,
      includedRuns: 1,
      scanLimitReached: false,
      runLimitReached: false,
      unreadableSummaries: 0,
      directoryReadFailed: false,
      windowStart: '2026-05-31T12:00:00.000Z',
      windowEnd: at,
    },
    runs: [run],
    findings: [finding],
    delegation: { parents: [] },
    helpers: { total: 0, kinds: [] },
    pluginFailures: [],
    toolHealth: [
      { name: 'test', calls: 1, errors: 1, errorRate: 1, categories: [{ category: 'permission', count: 1 }] },
    ],
    toolHealthCoverage: { includedRuns: 1, excludedRuns: 0, unknownResults: 0 },
    derivationCoverage: { limitedRuns: 0, unknownRuns: 0, callObservationsNotTracked: 0, findingSignalsNotRecorded: 0 },
    warnings: [],
    scannedRuns: 1,
    limits: { runs: 2000, findingsPerRun: 100, distinctCallKeysPerRun: 1000, evidencePerFinding: 20 },
    interpretation: 'Candidates are not confirmed defects.',
  };
}

describe('bounded harness-review list', () => {
  it('retains coverage, progress, metrics and top evidence with a report path', () => {
    const report = fixture();
    const summary = summarizeList(report, '/capture/reports/review.md');
    expect(summary.coverage).toEqual(report.coverage);
    expect(summary.progress).toMatchObject({ recentSingle: 1 });
    expect(summary.metrics).toEqual({ requests: 1, tools: 1, toolErrors: 1, retries: 1 });
    expect(summary.findings[0]).toMatchObject({
      id: 'finding',
      evidenceCount: 1,
      evidence: [{ runId: 'run', seq: 3 }],
    });
    expect(summary.toolHealth[0]).toMatchObject({ name: 'test', calls: 1, errors: 1 });
    expect(summary.reportPath).toBe('/capture/reports/review.md');
    expect(summary.outputBudget).toMatchObject({ maxChars: LIST_MAX_CHARS, omittedRuns: 0, omittedWarnings: 0 });
    expect(JSON.stringify(summary, null, 2).length).toBeLessThanOrEqual(LIST_MAX_CHARS);
  });

  it('budgets escaped JSON, warnings, long evidence, assessments and delegation without spreading the report', () => {
    const report = fixture();
    const long = 'source-text-canary "\\\n'.repeat(400);
    report.runs = Array.from({ length: 100 }, (_, index) => ({
      ...run,
      id: `run-${index}`,
      promptHashes: [{ sha256: long, chars: 1 }],
      input: { sha256: long, chars: long.length, excerpt: long },
    }));
    report.findings = Array.from({ length: 60 }, (_, index) => ({
      ...finding,
      id: `finding-${index}`,
      title: long,
      suggestion: long,
      evaluation: long,
      note: long,
      evidence: Array.from({ length: 20 }, () => ({ ...finding.evidence[0], detail: long, traceFile: long })),
      assessments: Array.from({ length: 200 }, () => ({ status: 'accepted', note: long, updatedAt: at })),
      ...(index === 59 ? { reviewNeeded: { reason: 'new-evidence' as const, occurrences: 1, runs: 1 } } : {}),
    }));
    report.warnings = Array.from({ length: 3000 }, () => long);
    report.delegation.parents = Array.from({ length: 50 }, () => ({
      parentSessionId: long,
      runs: 20,
      types: Array.from({ length: 20 }, () => ({ type: long, runs: 1, completed: 1, failed: 0, aborted: 0 })),
    }));
    report.helpers = {
      total: 2000,
      kinds: Array.from({ length: 50 }, () => ({
        kind: long,
        pluginId: long,
        runs: 40,
        completed: 40,
        failed: 0,
        aborted: 0,
        requests: 40,
      })),
    };
    report.pluginFailures = Array.from({ length: 100 }, () => ({
      pluginId: long,
      taskId: long,
      count: 40,
      lastAt: at,
      lastError: long,
    }));
    report.toolHealth = Array.from({ length: 60 }, () => ({
      name: long,
      calls: 40,
      errors: 20,
      errorRate: 0.5,
      categories: Array.from({ length: 60 }, () => ({ category: long, count: 1 })),
    }));
    const path = '/capture/reports/full-review.md';
    const summary = summarizeList(report, path);
    const json = JSON.stringify(summary, null, 2);
    expect(json.length).toBeLessThanOrEqual(LIST_MAX_CHARS);
    expect(summary.reportPath).toBe(path);
    expect(summary.coverage).toEqual(report.coverage);
    expect(summary.totalRuns).toBe(100);
    expect(summary.totalFindings).toBe(60);
    expect(summary.progress.needsReview).toBe(1);
    expect(summary.findings[0].id).toBe('finding-59');
    expect(summary.findings[0].assessmentCount).toBe(200);
    expect(summary.findings[0].evidenceCount).toBe(20);
    expect(summary.toolHealth.length).toBeGreaterThan(0);
    expect(summary.runs.length).toBeGreaterThan(0);
    expect(summary.warningCount).toBe(3000);
    expect(summary.outputBudget.omittedWarnings).toBe(3000 - summary.warnings.length);
    expect(summary.delegation).toEqual({ parents: 50, types: 1000, runs: 1000 });
    expect(summary.helpers).toEqual({ total: 2000, sources: 50 });
    expect(summary.pluginFailureCountInterpretation).toContain('lower-bound');
    expect(summary.runs[0]).not.toHaveProperty('promptHashes');
    expect(summary.runs[0]).not.toHaveProperty('input');
    expect(summary.findings[0]).not.toHaveProperty('assessments');
    expect(report.findings[0].note).toBe(long);
    expect(report.findings[0].evidence).toHaveLength(20);
    expect(report.warnings).toHaveLength(3000);
  });
});
