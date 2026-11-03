import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { archiveLegacyFiles } from './commands.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-memory-archive-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('archiveLegacyFiles', () => {
  it('moves the old three-block layout into a timestamped archive', () => {
    const root = tempDir();
    writeFileSync(join(root, 'USER.md'), '用户档案\n', 'utf-8');
    writeFileSync(join(root, 'MEMORY.md'), '记忆\n', 'utf-8');
    mkdirSync(join(root, 'projects', 'mica-code-12de4a5d'), { recursive: true });
    writeFileSync(join(root, 'projects', 'mica-code-12de4a5d', 'MEMORY.md'), '项目\n', 'utf-8');

    const moved = archiveLegacyFiles(root);

    expect(moved.sort()).toEqual(['MEMORY.md', 'USER.md', 'projects/mica-code-12de4a5d'].sort());
    expect(existsSync(join(root, 'USER.md'))).toBe(false);
    expect(existsSync(join(root, 'MEMORY.md'))).toBe(false);
    expect(readdirSync(join(root, 'archive'))).toHaveLength(1);
  });

  it('leaves the new layout alone', () => {
    // `projects/<仓库>.md` 与 `PROFILE.md` 是当前布局，归档命令不能碰它们。
    const root = tempDir();
    writeFileSync(join(root, 'PROFILE.md'), '用户档案\n', 'utf-8');
    mkdirSync(join(root, 'projects'), { recursive: true });
    writeFileSync(join(root, 'projects', 'mica-code-2d7741c9.md'), '项目\n', 'utf-8');
    mkdirSync(join(root, 'domains'), { recursive: true });
    writeFileSync(join(root, 'domains', '租车.md'), '---\nmatch:\n  - /repo\n---\n', 'utf-8');

    expect(archiveLegacyFiles(root)).toEqual([]);
    expect(existsSync(join(root, 'PROFILE.md'))).toBe(true);
    expect(existsSync(join(root, 'projects', 'mica-code-2d7741c9.md'))).toBe(true);
    expect(existsSync(join(root, 'domains', '租车.md'))).toBe(true);
  });
});
