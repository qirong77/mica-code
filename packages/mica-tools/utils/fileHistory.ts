import { access, copyFile, mkdir } from 'fs/promises';
import { basename, resolve } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

const FILE_HISTORY_DIR = resolve(process.env.MICA_HOME || resolve(homedir(), '.mica'), 'file-history');

function historyEntryDir(filePath: string): string {
  const resolvedPath = resolve(filePath);
  const hash = createHash('sha256').update(resolvedPath).digest('hex').slice(0, 16);
  return resolve(FILE_HISTORY_DIR, hash);
}

export async function backupFile(filePath: string): Promise<void> {
  try {
    await access(filePath);
    const backupDir = historyEntryDir(filePath);
    await mkdir(backupDir, { recursive: true });
    const timestamp = Date.now();
    await copyFile(filePath, resolve(backupDir, `${basename(filePath)}.${timestamp}`));
  } catch {
    // file doesn't exist, nothing to backup
  }
}
