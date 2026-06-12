import { existsSync } from 'fs';
import { join, dirname } from 'path';

export function findGitRoot(startPath: string): string | null {
  let dir = startPath;
  const root = dirname(dir);
  while (dir !== root) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}
