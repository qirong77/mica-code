import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Never follow a data-directory symlink while migrating private histories. */
export function hasDataDirectory(home: string, ...parts: string[]): boolean {
  let path = home;
  for (const part of parts) {
    path = join(path, part);
    try {
      if (!lstatSync(path).isDirectory()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

export function readBoundedPrivateFile(path: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) throw new Error('Private migration file exceeds bounds');
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (count === 0) break;
      size += count;
    }
    // A growing file is not a stable, complete migration input, even below the cap.
    if (size > info.size || fstatSync(fd).size !== info.size) throw new Error('Private migration file changed');
    return buffer.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

/** Parse whole, contiguous lines, never a tail fragment or an unbounded line. */
export function privateJsonLines(original: Buffer, maxLineBytes = 64 * 1024, maxLines = 50_000): unknown[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(original);
  const lines = text.split('\n');
  if (lines.length > maxLines + 1) throw new Error('Private migration has too many lines');
  const records: unknown[] = [];
  for (const line of lines) {
    if (Buffer.byteLength(line) > maxLineBytes) throw new Error('Private migration line exceeds bounds');
    if (line.trim()) {
      if (records.length >= maxLines) throw new Error('Private migration has too many lines');
      records.push(JSON.parse(line) as unknown);
    }
  }
  return records;
}

function archiveDirectory(home: string, category: string): string {
  let directory = home;
  for (const part of ['plugin-data', 'evolution', category]) {
    directory = join(directory, part);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!lstatSync(directory).isDirectory()) throw new Error('Invalid private migration archive directory');
    chmodSync(directory, 0o700);
  }
  return directory;
}

/** Content-addressed, atomic, private original-byte archive; a retry never overwrites it. */
export function archivePrivateOriginal(home: string, category: string, name: string, original: Buffer): void {
  const directory = archiveDirectory(home, category);
  const digest = createHash('sha256').update(original).digest('hex');
  const target = join(directory, `${name}.${digest}`);
  const temporary = join(directory, `.archive-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(fd, original);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const archived = readBoundedPrivateFile(target, original.length);
      if (!archived?.equals(original)) throw new Error('Conflicting private migration archive');
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      fchmodSync(fd, 0o600);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) unlinkSync(temporary);
  }
}

/** Unlike a settings write, private histories must not inherit an old broad mode. */
export function replacePrivateFile(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    created = false;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) unlinkSync(temporary);
  }
}
