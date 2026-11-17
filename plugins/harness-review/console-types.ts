import type { ReviewReport, ReviewFinding, RunSummary, ToolHealthRow, PluginFailureSummary } from './engine.js';
import type { LogEvidence } from './log-evidence.js';
import type { ReviewProgress } from './progress.js';

/** JSON-only, bounded console projection; never exposes trace/input/prompt bodies. */
export type ConsoleRun = Pick<
  RunSummary,
  | 'id'
  | 'sessionTitle'
  | 'cwd'
  | 'outcome'
  | 'startedAt'
  | 'finishedAt'
  | 'elapsedMs'
  | 'requestCount'
  | 'toolCalls'
  | 'toolErrors'
  | 'retries'
  | 'inputTokens'
  | 'outputTokens'
  | 'droppedEvents'
> & { source: 'main' | 'delegation' | 'helper'; sourceLabel: string; providerId: string; model: string };

export type ConsoleFinding = Pick<
  ReviewFinding,
  | 'id'
  | 'kind'
  | 'title'
  | 'module'
  | 'status'
  | 'cwd'
  | 'occurrences'
  | 'recentOccurrences'
  | 'recentRuns'
  | 'firstSeenAt'
  | 'lastSeenAt'
  | 'reviewNeeded'
  | 'suggestion'
  | 'evaluation'
  | 'note'
> & {
  group: keyof ReviewProgress;
  evidenceCount: number;
  evidence: { runId: string; seq: number; available: boolean }[];
};

export type ConsolePlugin = {
  id: string;
  name: string;
  version?: string;
  enabled: boolean;
  /** Last shared assembly snapshot, not a claim about all live hosts. */
  loading: 'loaded' | 'failed' | 'skipped' | 'unknown';
  health: { level: 'ok' | 'warn' | 'error'; message: string; at: string } | null;
  operationStarts: number;
  operationFinishes: number;
  operationErrors: number;
  impressions: number;
  clicks: number;
};

export type ConsoleSnapshot = {
  version: 1;
  generatedAt: string;
  refreshAfterMs: number;
  classifierVersion: number;
  recording: { enabled: boolean; captureContent: boolean };
  totals: {
    mainRuns: number;
    delegatedRuns: number;
    helperRuns: number;
    running: number;
    completed: number;
    failed: number;
    interrupted: number;
    aborted: number;
    paused: number;
    requests: number;
    tools: number;
    toolErrors: number;
    retries: number;
    inputTokens: number;
    outputTokens: number;
    droppedEvents: number;
  };
  progress: ReviewProgress;
  coverage: ReviewReport['coverage'];
  toolHealthCoverage: ReviewReport['toolHealthCoverage'];
  derivationCoverage: ReviewReport['derivationCoverage'];
  limits: ReviewReport['limits'];
  runs: ConsoleRun[];
  findings: ConsoleFinding[];
  toolHealth: ToolHealthRow[];
  pluginFailures: PluginFailureSummary[];
  plugins: ConsolePlugin[];
  assembly: { host: string | null; updatedAt: string | null; unreadable: boolean };
  logEvidence: LogEvidence | null;
  warnings: string[];
  counts: {
    runs: number;
    findings: number;
    toolHealth: number;
    pluginFailures: number;
    plugins: number;
    warnings: number;
  };
  interpretation: string;
};
