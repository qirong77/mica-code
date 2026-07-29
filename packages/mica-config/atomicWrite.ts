import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeTextFileAtomic(filePath: string, content: string, defaultMode = 0o600): void {
  const targetPath = resolveWriteTarget(filePath);
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const mode = existsSync(targetPath) ? statSync(targetPath).mode & 0o777 : defaultMode;
  try {
    writeFileSync(tempPath, content, { encoding: 'utf-8', mode });
    renameSync(tempPath, targetPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function resolveWriteTarget(filePath: string): string {
  return existsSync(filePath) && lstatSync(filePath).isSymbolicLink() ? realpathSync(filePath) : filePath;
}
