import { randomUUID } from 'node:crypto';

export const MAX_BYTES = 48 * 1024;
export type ReportStatus = 'unknown' | 'pending' | 'done' | 'failed' | 'skipped';
export type Evidence = {
  id: string;
  tool: string;
  runId: number;
  observedAt: string;
  kind: 'returned' | 'command-exit';
  exitCode?: number;
};
export type Delivery = {
  version: 1;
  revision: string;
  savedAt: string;
  sourceSessionId: string;
  summary: string;
  changedFiles: string[];
  reports: { code: ReportStatus; validation: ReportStatus; build: ReportStatus; deploy: ReportStatus };
  validationClaims: string[];
  deploymentReport: string;
  evidence: Evidence[];
  dismissedRevision?: string;
};
export type DeliveryInput = {
  summary: string;
  changedFiles: string[];
  reports: Delivery['reports'];
  validationClaims: string[];
  deploymentReport: string;
  evidenceIds: string[];
};

export function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
export function bounded(value: unknown, limit = MAX_BYTES): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= limit;
  } catch {
    return false;
  }
}
export function text(value: unknown, limit: number, empty = true): value is string {
  return (
    typeof value === 'string' &&
    value.length <= limit &&
    (empty || !!value.trim()) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}
export function list(value: unknown, count: number, limit: number): value is string[] {
  return Array.isArray(value) && value.length <= count && value.every((item) => text(item, limit, false));
}
export function revision(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}
export function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 32 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
}
function status(value: unknown): value is ReportStatus {
  return ['unknown', 'pending', 'done', 'failed', 'skipped'].includes(value as string);
}
function reports(value: unknown): value is Delivery['reports'] {
  return (
    record(value) &&
    Object.keys(value).length === 4 &&
    ['code', 'validation', 'build', 'deploy'].every((key) => status(value[key]))
  );
}
function paths(value: unknown): value is string[] {
  return list(value, 40, 320) && value.every((path) => !/[\r\n]/.test(path) && !/^[a-z]+:\/\//i.test(path));
}
export function parseSet(value: unknown): DeliveryInput {
  if (!record(value) || !bounded(value)) throw new Error('Delivery must be a bounded JSON object (48 KiB maximum).');
  const allowed = [
    'action',
    'summary',
    'changedFiles',
    'reports',
    'validationClaims',
    'deploymentReport',
    'evidenceIds',
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Unknown delivery field.');
  if (!text(value.summary, 3000, false)) throw new Error('summary must contain 1–3000 characters.');
  if (value.changedFiles !== undefined && !paths(value.changedFiles))
    throw new Error('changedFiles must contain at most 40 bounded file paths.');
  if (value.reports !== undefined && !reports(value.reports))
    throw new Error(
      'reports must provide code, validation, build and deploy using unknown/pending/done/failed/skipped.',
    );
  if (value.validationClaims !== undefined && !list(value.validationClaims, 12, 600))
    throw new Error('validationClaims must contain at most 12 claims of 600 characters.');
  if (value.deploymentReport !== undefined && !text(value.deploymentReport, 1500))
    throw new Error('deploymentReport must contain at most 1500 characters.');
  if (value.evidenceIds !== undefined && (!list(value.evidenceIds, 12, 160) || !value.evidenceIds.every(identifier)))
    throw new Error('evidenceIds must contain at most 12 actual tool call IDs.');
  return {
    summary: value.summary.trim(),
    changedFiles: (value.changedFiles as string[] | undefined) ?? [],
    reports: (value.reports as Delivery['reports'] | undefined) ?? {
      code: 'unknown',
      validation: 'unknown',
      build: 'unknown',
      deploy: 'unknown',
    },
    validationClaims: (value.validationClaims as string[] | undefined) ?? [],
    deploymentReport: (value.deploymentReport as string | undefined) ?? '',
    evidenceIds: (value.evidenceIds as string[] | undefined) ?? [],
  };
}
export function sanitizeDelivery(value: unknown): Delivery | undefined {
  if (
    !record(value) ||
    value.version !== 1 ||
    !bounded(value, 64 * 1024) ||
    !revision(value.revision) ||
    !timestamp(value.savedAt) ||
    !identifier(value.sourceSessionId)
  )
    return;
  if (
    !text(value.summary, 3000, false) ||
    !paths(value.changedFiles) ||
    !reports(value.reports) ||
    !list(value.validationClaims, 12, 600) ||
    !text(value.deploymentReport, 1500)
  )
    return;
  if (!Array.isArray(value.evidence) || value.evidence.length > 12) return;
  const evidence: Evidence[] = [];
  for (const item of value.evidence) {
    if (
      !record(item) ||
      !identifier(item.id) ||
      !identifier(item.tool) ||
      !Number.isSafeInteger(item.runId) ||
      (item.runId as number) < 0 ||
      !timestamp(item.observedAt)
    )
      return;
    if (item.kind !== 'returned' && item.kind !== 'command-exit') return;
    if (item.kind === 'command-exit' && (item.tool !== 'run_shell' || !Number.isSafeInteger(item.exitCode))) return;
    evidence.push({
      id: item.id,
      tool: item.tool,
      runId: item.runId as number,
      observedAt: item.observedAt,
      kind: item.kind,
      ...(item.kind === 'command-exit' ? { exitCode: item.exitCode as number } : {}),
    });
  }
  return {
    version: 1,
    revision: value.revision,
    savedAt: value.savedAt,
    sourceSessionId: value.sourceSessionId,
    summary: value.summary,
    changedFiles: [...value.changedFiles],
    reports: { ...value.reports },
    validationClaims: [...value.validationClaims],
    deploymentReport: value.deploymentReport,
    evidence,
    ...(value.dismissedRevision === value.revision ? { dismissedRevision: value.revision } : {}),
  };
}
export function createDelivery(
  input: DeliveryInput,
  sourceSessionId: string,
  evidence: Evidence[],
  now = new Date(),
): Delivery {
  return {
    version: 1,
    revision: randomUUID(),
    savedAt: now.toISOString(),
    sourceSessionId,
    summary: input.summary,
    changedFiles: [...input.changedFiles],
    reports: { ...input.reports },
    validationClaims: [...input.validationClaims],
    deploymentReport: input.deploymentReport,
    evidence: evidence.map((item) => ({ ...item })),
  };
}
