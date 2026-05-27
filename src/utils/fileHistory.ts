import { tmpdir } from 'os';
import { join } from 'path';
import { copyFile, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID, createHash } from 'crypto';

const sessionId = randomUUID();
const backupDir = join(tmpdir(), 'mica-code-backups', sessionId);

const backups = new Map<string, string>();

async function ensureBackupDirectory() {
  try {
    await mkdir(backupDir, { recursive: true });
  } catch {}
}

export function hasBackups(): boolean {
  return backups.size > 0;
}

export async function backupFile(filePath: string): Promise<void> {
  if (!filePath || backups.has(filePath)) return;
  if (!existsSync(filePath)) return;

  await ensureBackupDirectory();
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 16);
  const backupPath = join(backupDir, hash);

  try {
    await copyFile(filePath, backupPath);
    backups.set(filePath, backupPath);
  } catch {}
}

export async function restoreFiles(): Promise<void> {
  for (const [originalPath, backupPath] of backups) {
    try {
      await mkdir(join(originalPath, '..'), { recursive: true });
      await copyFile(backupPath, originalPath);
    } catch {}
  }
  await cleanup();
}

export async function clearBackups(): Promise<void> {
  await cleanup();
}

async function cleanup(): Promise<void> {
  backups.clear();
  try {
    await rm(backupDir, { recursive: true, force: true });
  } catch {}
}

// Clean stale backup dirs from crashed/old sessions at startup
async function cleanupStaleDirectories(): Promise<void> {
  const parentDir = join(tmpdir(), 'mica-code-backups');
  try {
    const { readdir } = await import('fs/promises');
    const entries = await readdir(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== sessionId) {
        rm(join(parentDir, entry.name), { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {}
}
cleanupStaleDirectories();
