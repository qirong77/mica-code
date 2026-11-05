import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type StoredCorrection = {
  id: string;
  sessionId: string;
  kind: 'edit' | 'recall' | 'retry';
  chars?: number;
  recordedAt: string;
};
export type CorrectionInput = Omit<StoredCorrection, 'id' | 'recordedAt'>;
type Claim = StoredCorrection & { runId: string };
type SummaryReceipt = {
  id: string;
  sessionId: string;
  correctionIds: string[];
  corrections: Record<StoredCorrection['kind'], number>;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_RECORDS = 2000;
const MAX_RECORD_BYTES = 10 * 1024;
const MAX_SUMMARY_BYTES = 4 * 1024 * 1024;
const KINDS = ['edit', 'recall', 'retry'] as const;

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

function uuid(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid correction or run UUID.');
  return value;
}

function session(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 300 && value.trim().length > 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function correction(value: unknown, id: string): StoredCorrection {
  if (
    !object(value) ||
    value.id !== id ||
    !session(value.sessionId) ||
    !KINDS.includes(value.kind as StoredCorrection['kind']) ||
    (value.chars !== undefined &&
      (typeof value.chars !== 'number' || !Number.isSafeInteger(value.chars) || value.chars < 0)) ||
    typeof value.recordedAt !== 'string' ||
    value.recordedAt.length !== 24 ||
    !Number.isFinite(Date.parse(value.recordedAt)) ||
    new Date(value.recordedAt).toISOString() !== value.recordedAt
  ) {
    throw new Error(`Invalid correction record ${id}.`);
  }
  return {
    id,
    sessionId: value.sessionId,
    kind: value.kind as StoredCorrection['kind'],
    ...(value.chars === undefined ? {} : { chars: value.chars as number }),
    recordedAt: value.recordedAt,
  };
}

function sameCorrection(left: StoredCorrection, right: StoredCorrection): boolean {
  return (
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.kind === right.kind &&
    left.chars === right.chars &&
    left.recordedAt === right.recordedAt
  );
}

export class CorrectionQueue {
  private readonly root: string;
  private readonly pending: string;
  private readonly claims: string;
  private readonly messages: string[] = [];

  constructor(
    root: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.root = resolve(root);
    this.pending = join(this.root, 'corrections');
    this.claims = join(this.pending, 'claims');
  }

  get warnings(): readonly string[] {
    return [...this.messages];
  }

  private report(error: unknown): void {
    if (this.messages.length < 100)
      this.messages.push(`Correction queue: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`);
    try {
      this.onError(error);
    } catch {
      // Reporting must not interrupt the recorder.
    }
  }

  private async directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await this.checkDirectory(path);
    await chmod(path, 0o700);
  }

  private async checkDirectory(path: string): Promise<boolean> {
    try {
      if (!(await lstat(path)).isDirectory()) throw new Error('Correction queue directory is not a directory.');
      return true;
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  private recordPath(id: string, claimed = false): string {
    return join(claimed ? this.claims : this.pending, `${uuid(id)}.json`);
  }

  private async publish(path: string, value: StoredCorrection | Claim, directory: string): Promise<boolean> {
    const temp = join(directory, `.${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try {
      try {
        await handle.chmod(0o600);
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temp, path);
        return true;
      } catch (error) {
        if (hasCode(error, 'EEXIST')) return false;
        throw error;
      }
    } finally {
      try {
        await unlink(temp);
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) this.report(error);
      }
    }
  }

  private async read(path: string, maxBytes = MAX_RECORD_BYTES): Promise<unknown | undefined> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid or oversized correction queue file.');
      const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
        if (result.bytesRead === 0) break;
        bytes += result.bytesRead;
      }
      if (bytes !== info.size) throw new Error('Correction queue file changed while reading.');
      try {
        return JSON.parse(buffer.subarray(0, bytes).toString('utf8')) as unknown;
      } catch {
        throw new Error('Invalid JSON in correction queue file.');
      }
    } finally {
      await handle.close();
    }
  }

  private async ids(): Promise<string[]> {
    if (!(await this.checkDirectory(this.pending))) return [];
    await this.checkDirectory(this.claims);
    let directory;
    try {
      directory = await opendir(this.pending);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    }
    const ids: string[] = [];
    let scanned = 0;
    for await (const entry of directory) {
      if (entry.name === 'claims') continue;
      if (scanned++ >= MAX_RECORDS) {
        this.report(new Error(`Correction scan limited to ${MAX_RECORDS} entries.`));
        break;
      }
      const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
      if (UUID.test(id) && entry.isFile()) ids.push(id);
      else if (!(entry.name.startsWith('.') && entry.name.endsWith('.tmp') && UUID.test(entry.name.slice(1, -4))))
        this.report(new Error('Invalid correction filename or file type.'));
    }
    return ids;
  }

  private async claim(id: string): Promise<Claim | undefined> {
    const value = await this.read(this.recordPath(id, true));
    if (value === undefined) return undefined;
    const stored = correction(value, id);
    if (!object(value) || typeof value.runId !== 'string') throw new Error(`Invalid correction claim ${id}.`);
    return { ...stored, runId: uuid(value.runId) };
  }

  private async receipt(runId: string): Promise<SummaryReceipt | undefined> {
    const value = await this.read(join(this.root, 'runs', uuid(runId), 'summary.json'), MAX_SUMMARY_BYTES);
    if (value === undefined) return undefined;
    const counts = object(value) && object(value.corrections) ? value.corrections : undefined;
    if (
      !object(value) ||
      value.id !== runId ||
      !session(value.sessionId) ||
      value.helper !== undefined ||
      value.delegation !== undefined ||
      !Array.isArray(value.correctionIds) ||
      value.correctionIds.length > MAX_RECORDS ||
      !value.correctionIds.every((id: unknown) => typeof id === 'string' && UUID.test(id)) ||
      new Set(value.correctionIds).size !== value.correctionIds.length ||
      !counts ||
      !KINDS.every(
        (kind) => typeof counts[kind] === 'number' && Number.isSafeInteger(counts[kind]) && counts[kind] >= 0,
      ) ||
      KINDS.reduce((sum, kind) => sum + (counts[kind] as number), 0) !== value.correctionIds.length
    ) {
      throw new Error(`Run ${runId} has no valid persisted correction receipt.`);
    }
    return {
      id: runId,
      sessionId: value.sessionId,
      correctionIds: value.correctionIds as string[],
      corrections: { edit: counts.edit as number, recall: counts.recall as number, retry: counts.retry as number },
    };
  }

  private committed(claim: Claim, receipt: SummaryReceipt | undefined): boolean {
    return (
      !!receipt &&
      receipt.sessionId === claim.sessionId &&
      receipt.correctionIds.includes(claim.id) &&
      receipt.corrections[claim.kind] > 0
    );
  }

  async append(input: CorrectionInput): Promise<void> {
    try {
      if (!object(input)) throw new Error('Invalid correction input.');
      const id = randomUUID();
      const stored = correction({ ...input, id, recordedAt: new Date().toISOString() }, id);
      await this.directory(this.root);
      await this.directory(this.pending);
      if (!(await this.publish(this.recordPath(id), stored, this.pending)))
        throw new Error(`Correction UUID collision ${id}.`);
    } catch (error) {
      this.report(error);
      throw error;
    }
  }

  async take(sessionId: string, runId: string): Promise<StoredCorrection[]> {
    try {
      uuid(runId);
      if (!session(sessionId)) throw new Error('Invalid correction session ID.');
      const taken: StoredCorrection[] = [];
      const receipts = new Map<string, Promise<SummaryReceipt | undefined>>();
      for (const id of await this.ids()) {
        try {
          const value = await this.read(this.recordPath(id));
          if (value === undefined) continue;
          const stored = correction(value, id);
          if (stored.sessionId !== sessionId) continue;
          let existing = await this.claim(id);
          if (!existing) {
            await this.directory(this.claims);
            if (await this.publish(this.recordPath(id, true), { ...stored, runId }, this.claims)) {
              taken.push(stored);
              continue;
            }
            existing = await this.claim(id);
          }
          if (!existing || !sameCorrection(stored, existing)) throw new Error(`Mismatched correction claim ${id}.`);
          if (!receipts.has(existing.runId)) receipts.set(existing.runId, this.receipt(existing.runId));
          if (!this.committed(existing, await receipts.get(existing.runId)))
            this.report(
              new Error(
                `Correction ${id} remains claimed by run ${existing.runId}; no persisted receipt. Not reassigned.`,
              ),
            );
        } catch (error) {
          this.report(error);
        }
      }
      return taken;
    } catch (error) {
      this.report(error);
      throw error;
    }
  }

  async ack(runId: string): Promise<void> {
    try {
      uuid(runId);
      const receipt = await this.receipt(runId);
      if (!receipt) {
        this.report(new Error(`Run ${runId} has no persisted correction receipt; pending events retained.`));
        return;
      }
      for (const id of await this.ids()) {
        try {
          const claimed = await this.claim(id);
          if (!claimed || claimed.runId !== runId) continue;
          const value = await this.read(this.recordPath(id));
          if (value === undefined) continue;
          if (!sameCorrection(correction(value, id), claimed) || !this.committed(claimed, receipt)) {
            this.report(new Error(`Correction ${id} does not match the persisted receipt; pending event retained.`));
            continue;
          }
          // Claims are immutable tombstones: deleting one could let a racing reader consume a stale event again.
          try {
            await unlink(this.recordPath(id));
          } catch (error) {
            if (!hasCode(error, 'ENOENT')) throw error;
          }
        } catch (error) {
          this.report(error);
        }
      }
    } catch (error) {
      this.report(error);
      throw error;
    }
  }
}
