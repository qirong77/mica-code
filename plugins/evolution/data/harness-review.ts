import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { join } from 'node:path';
import { assessmentKey, isFindingAssessment, type FindingAssessment } from '../../harness-review/assessments.js';
import { harnessReviewAssessmentV1 } from '../migrations.js';
import type { DataMigration } from './types.js';

const MAX_FILE_BYTES = 256 * 1024;
const LEGACY_FILE = /^(?:[a-f0-9]{64}|h-[a-f0-9]{32})\.json$/;

function readJson(file: string): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const bytesRead = readSync(fd, buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    return size > MAX_FILE_BYTES ? undefined : (JSON.parse(buffer.toString('utf8', 0, size)) as unknown);
  } finally {
    closeSync(fd);
  }
}

function content(assessment: FindingAssessment): string {
  return `${JSON.stringify({
    version: assessment.version,
    id: assessment.id,
    status: assessment.status,
    note: assessment.note,
    updatedAt: assessment.updatedAt,
    baseline: assessment.baseline,
  })}\n`;
}

function ensureHistory(directory: string, assessment: FindingAssessment): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error('Invalid assessment directory path');
  chmodSync(directory, 0o700);
  const data = content(assessment);
  const digest = createHash('sha256').update(data).digest('hex');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const existing = readJson(join(directory, entry.name));
      if (isFindingAssessment(existing) && content(existing) === data) return;
    } catch {
      continue;
    }
  }
  const target = join(directory, `legacy-${digest}.json`);
  const temporary = join(directory, `.legacy-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(fd, data, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readJson(target);
      if (!isFindingAssessment(existing) || content(existing) !== data)
        throw new Error('Conflicting legacy assessment');
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) unlinkSync(temporary);
  }
}

function archive(file: string): boolean {
  const base = file.slice(0, -'.json'.length);
  for (let suffix = 0; ; suffix += 1) {
    const target = `${base}.legacy-v1${suffix ? `.${suffix}` : ''}.json`;
    try {
      linkSync(file, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    unlinkSync(file);
    return true;
  }
}

export const harnessReviewAssessments: DataMigration = {
  id: 'harness-review-assessments',
  description: 'Move legacy harness-review decisions into versioned assessment history and archive the originals',
  run({ home, log }) {
    const root = join(home, 'plugin-data', 'harness-review');
    const decisions = join(root, 'decisions');
    let entries: Dirent[];
    try {
      if (!lstatSync(join(home, 'plugin-data')).isDirectory() || !lstatSync(root).isDirectory()) return 0;
      if (!lstatSync(decisions).isDirectory()) return 0;
      entries = readdirSync(decisions, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    let changed = 0;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !LEGACY_FILE.test(entry.name)) continue;
      const file = join(decisions, entry.name);
      let assessment: unknown;
      try {
        assessment = readJson(file);
      } catch {
        continue;
      }
      if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) continue;
      if (harnessReviewAssessmentV1.apply(assessment as Record<string, unknown>) === 0) continue;
      if (!isFindingAssessment(assessment) || assessmentKey(assessment.id) !== entry.name.slice(0, -'.json'.length))
        continue;
      try {
        ensureHistory(join(decisions, assessmentKey(assessment.id)), assessment);
        if (archive(file)) changed += 1;
      } catch (error) {
        log('evolution:harness-review-assessment-skipped', { file: entry.name, error: String(error) });
      }
    }
    return changed;
  },
};
