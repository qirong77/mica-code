import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type FindingStatus = 'open' | 'accepted' | 'dismissed' | 'validated' | 'regressed';
export type AssessmentBaseline = { runs: Record<string, number> } | { plugin: { count: number; lastAt: string } };
export type FindingAssessment = {
  version: 1;
  id: string;
  status: FindingStatus;
  note: string;
  updatedAt: string;
  baseline: AssessmentBaseline | null;
};

const STATUSES = new Set<string>(['open', 'accepted', 'dismissed', 'validated', 'regressed']);
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_RUNS = 2000;
const MAX_HISTORY = 1000;
const MAX_FILE_BYTES = 256 * 1024;
const JSON_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    (/^[a-f0-9]{64}$/.test(id) || /^plugin-background:[A-Za-z0-9._-]{1,80}:[A-Za-z0-9._-]{1,120}$/.test(id))
  );
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validBaseline(value: unknown): value is AssessmentBaseline | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (hasKeys(value, ['runs']) && isRecord(value.runs)) {
    const entries = Object.entries(value.runs);
    return entries.length <= MAX_RUNS && entries.every(([id, count]) => RUN_ID.test(id) && validCount(count));
  }
  return (
    hasKeys(value, ['plugin']) &&
    isRecord(value.plugin) &&
    hasKeys(value.plugin, ['count', 'lastAt']) &&
    validCount(value.plugin.count) &&
    validDate(value.plugin.lastAt)
  );
}

export function isFindingAssessment(value: unknown): value is FindingAssessment {
  return (
    isRecord(value) &&
    hasKeys(value, ['version', 'id', 'status', 'note', 'updatedAt', 'baseline']) &&
    value.version === 1 &&
    validId(value.id) &&
    typeof value.status === 'string' &&
    STATUSES.has(value.status) &&
    typeof value.note === 'string' &&
    value.note.trim().length > 0 &&
    value.note.length <= 8000 &&
    validDate(value.updatedAt) &&
    validBaseline(value.baseline)
  );
}

export function assessmentKey(id: string): string {
  if (!validId(id)) throw new Error('Invalid finding ID');
  return /^[a-f0-9]{64}$/.test(id) ? id : `h-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error('Invalid assessment directory path');
  await chmod(path, 0o700);
}

export async function writeAssessment(root: string, assessment: FindingAssessment): Promise<void> {
  if (!isFindingAssessment(assessment)) throw new Error('Invalid finding assessment schema');
  const key = assessmentKey(assessment.id);
  const data = `${JSON.stringify(assessment, null, 2)}\n`;
  if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error('Assessment exceeds size limit');
  const base = resolve(root);
  await privateDirectory(base);
  await privateDirectory(join(base, 'decisions'));
  const directory = join(base, 'decisions', key);
  await privateDirectory(directory);
  const id = randomUUID();
  const temporary = join(directory, `.${id}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(data, 'utf8');
    await file.sync();
    await file.close();
    await rename(temporary, join(directory, `${id}.json`));
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Invalid assessment file path');
    if (info.size > MAX_FILE_BYTES) throw new Error('Assessment exceeds size limit');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_FILE_BYTES) throw new Error('Assessment exceeds size limit');
    return JSON.parse(buffer.toString('utf8', 0, size)) as unknown;
  } finally {
    await file.close();
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function readAssessments(root: string, id: string, warnings: string[]): Promise<FindingAssessment[]> {
  const key = assessmentKey(id);
  const base = resolve(root);
  const decisions = join(base, 'decisions');
  const directory = join(decisions, key);
  try {
    for (const path of [base, decisions]) {
      if (!(await lstat(path)).isDirectory()) throw new Error('Invalid assessment directory path');
    }
    try {
      await lstat(join(decisions, `${key}.json`));
      warnings.push(
        `Legacy decision ${id}: single-file decisions are no longer supported; run /evolution run to migrate.`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid assessment directory path');
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.name.endsWith('.json'))
      .sort((a, b) => compareText(a.name, b.name));
    if (entries.length > MAX_HISTORY) {
      warnings.push(
        `Assessment history ${id} exceeds ${MAX_HISTORY} JSON files; only the latest ${MAX_HISTORY} valid assessments are returned.`,
      );
    }
    const history: { file: string; assessment: FindingAssessment }[] = [];
    const order = (a: (typeof history)[number], b: (typeof history)[number]) =>
      Date.parse(a.assessment.updatedAt) - Date.parse(b.assessment.updatedAt) || compareText(a.file, b.file);
    for (const entry of entries) {
      try {
        if (!JSON_FILE.test(entry.name) || !entry.isFile()) throw new Error('Invalid assessment file path');
        const assessment = await readJson(join(directory, entry.name));
        if (!isFindingAssessment(assessment) || assessment.id !== id)
          throw new Error('Invalid finding assessment schema');
        history.push({ file: entry.name, assessment });
        if (history.length > MAX_HISTORY) {
          history.sort(order);
          history.shift();
        }
      } catch (error) {
        warnings.push(`Unreadable assessment ${id}/${entry.name}: ${String(error)}`);
      }
    }
    return history.sort(order).map(({ assessment }) => assessment);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`Unreadable assessment history ${id}: ${String(error)}`);
    }
    return [];
  }
}
