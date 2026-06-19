import { copyFile, access } from 'fs/promises';
import { dirname, basename, join } from 'path';
import { mkdir } from 'fs/promises';

export async function backupFile(filePath: string): Promise<void> {
  try {
    await access(filePath);
    const dir = dirname(filePath);
    const name = basename(filePath);
    const backupDir = join(dir, '.backups');
    await mkdir(backupDir, { recursive: true });
    const timestamp = Date.now();
    await copyFile(filePath, join(backupDir, `${name}.${timestamp}`));
  } catch {
    // file doesn't exist, nothing to backup
  }
}
