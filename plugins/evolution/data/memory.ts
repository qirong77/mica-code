import { existsSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import type { DataMigration, DataMigrationContext } from './types.js';

/**
 * 记忆插件的旧布局。
 *
 * 旧形态是三块按「有没有项目」分开的文件：`USER.md`（用户档案）、`MEMORY.md`（全局笔记）、
 * `projects/<cwd 哈希>/MEMORY.md`（按会话当时的目录归档的项目记忆）。现在的形态按作用域
 * 分：`PROFILE.md`、`projects/<仓库身份>.md`、`domains/<领域>.md`——项目记忆跟着**仓库**
 * 走，所以同一仓库从子目录、worktree、另一个 clone 开会话读到的是同一份。
 *
 * 迁移做的事：
 * - `USER.md` 与 `MEMORY.md` 的条目并进 `PROFILE.md`（两者在旧设计里都是「每个会话都注入」
 *   的全局层，新设计里对应 profile）；
 * - `projects/<cwd 哈希>/MEMORY.md` 按目录名（`<仓库名>-<8 位哈希>`）找回同名的项目记忆
 *   文件并逐条并入。
 *
 * 找不回来的项目目录**原样留着**：旧哈希是 cwd 的 sha1，推不出仓库身份；仓库已经不用了
 * 的话新形态里也没有合法的落点（写进 profile 会把这些事实注入到所有会话里，比不注入更糟）。
 * 这种情况记一条日志，文件不动。
 */
export const memoryScopes: DataMigration = {
  id: 'memory-scopes',
  description:
    '把旧布局的记忆（USER.md / MEMORY.md / projects/<cwd 哈希>/MEMORY.md）并入 PROFILE.md 与对应的项目记忆文件',
  run(context) {
    const root = join(context.home, 'memory');
    if (!existsSync(root)) return 0;
    return mergeProfile(root) + mergeProjects(root, context);
  },
};

function mergeProfile(root: string): number {
  const additions: string[] = [];
  for (const name of ['USER.md', 'MEMORY.md']) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const entries = readEntries(path);
    // 空文件没有任何可搬的东西，直接收掉；否则它会以旧形态永远留在目录里。
    if (entries.length === 0) rmSync(path, { force: true });
    else additions.push(...entries);
  }
  if (additions.length === 0) return 0;
  const profilePath = join(root, 'PROFILE.md');
  const changed = mergeInto(profilePath, additions) ? 1 : 0;
  for (const name of ['USER.md', 'MEMORY.md']) {
    const path = join(root, name);
    if (existsSync(path)) rmSync(path, { force: true });
  }
  return changed;
}

function mergeProjects(root: string, context: DataMigrationContext): number {
  const projectsDir = join(root, 'projects');
  if (!existsSync(projectsDir)) return 0;
  let changed = 0;
  const known = projectStoreNames(projectsDir);
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const legacyFile = join(projectsDir, entry.name, 'MEMORY.md');
    if (!existsSync(legacyFile)) {
      // 只剩锁目录的旧项目目录（内容早先被清过）：没有可搬的东西，直接收掉。
      removeIfOnlyLockArtifacts(join(projectsDir, entry.name));
      continue;
    }
    const base = projectBaseName(entry.name);
    // 只在**唯一**同名项目文件时合并：同名仓库有两个 clone 时，把一份记忆塞进其中一个
    // 会变成「只有那个 clone 看得到」，比留着不动更难解释。
    const candidates = base === null ? [] : known.filter((name) => sameProject(name, base));
    if (candidates.length !== 1) {
      context.log('evolution:memory-project-unmatched', {
        project: entry.name,
        candidates: candidates.length,
      });
      continue;
    }
    const targetPath = join(projectsDir, `${candidates[0]}.md`);
    const entries = readEntries(legacyFile);
    if (entries.length > 0 && mergeInto(targetPath, entries)) changed += 1;
    rmSync(legacyFile, { force: true });
    // 记忆的跨进程锁在文件旁边留一个 `*.lock.owners` 空目录，那不是用户数据；
    // 不带走它，搬空的旧项目目录会一直留在 `projects/` 里。
    for (const name of readdirSync(join(projectsDir, entry.name))) {
      if (!name.startsWith('MEMORY.md.lock')) continue;
      rmSync(join(projectsDir, entry.name, name), { recursive: true, force: true });
    }
    // 旧目录里可能还有别的东西（用户自己放的文件）：只有空了才删掉目录。
    try {
      rmdirSync(join(projectsDir, entry.name));
    } catch {
      // 非空就留着，内容已经搬走了。
    }
  }
  return changed;
}

/** 目录里只剩记忆锁留下的空目录时删掉它，返回是否删了。 */
function removeIfOnlyLockArtifacts(dir: string): boolean {
  const names = readdirSync(dir);
  if (names.length === 0 || !names.every((name) => name.startsWith('MEMORY.md.lock'))) return false;
  for (const name of names) rmSync(join(dir, name), { recursive: true, force: true });
  try {
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** 新布局的项目记忆文件名（不含 `.md`）。 */
function projectStoreNames(projectsDir: string): string[] {
  return readdirSync(projectsDir).filter(
    (name) => name.endsWith('.md') && statSync(join(projectsDir, name)).isFile(),
  ).map((name) => name.slice(0, -'.md'.length));
}

/** 旧目录名 `mica-code-12de4a5d` → `mica-code`；不是这个形态时 null。 */
function projectBaseName(directory: string): string | null {
  const match = /^(.*)-[0-9a-f]{8}$/.exec(directory);
  return match?.[1] ? match[1] : null;
}

/**
 * 旧目录与当前项目记忆文件是不是同一个仓库。
 *
 * 旧哈希是 cwd 的 sha1、新哈希是仓库身份的 sha1，同一个仓库这两个值通常不同（甚至同机
 * 不同的 clone 也不同），唯一能对上的线索就是仓库名。名字本身可能带连字符，所以只把
 * 「名字 + `-` + 8 位哈希」这一整段当文件名。
 */
function sameProject(storeName: string, base: string): boolean {
  if (storeName === base) return true;
  return storeName.startsWith(`${base}-`) && /^[0-9a-f]{8}$/.test(storeName.slice(base.length + 1));
}

/** 记忆的一条约等于一个自然段（空行分隔），与记忆插件的读写保持一致。 */
function readEntries(path: string): string[] {
  const raw = readFileSync(path, 'utf-8').replace(/\r\n?/g, '\n');
  return raw
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** 把条目并进目标文件，返回是否真的写入了新内容（已存在的条目不再重复）。 */
function mergeInto(path: string, additions: string[]): boolean {
  const existing = existsSync(path) ? readEntries(path) : [];
  const seen = new Set(existing);
  const merged = [...existing];
  for (const entry of additions) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  if (merged.length === existing.length) return false;
  writeTextFileAtomic(path, `${merged.join('\n\n')}\n`);
  return true;
}
