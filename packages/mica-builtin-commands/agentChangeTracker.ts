import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gitBuffer, gitText } from '@packages/mica-common/index.js';
import type { ToolExecutionEvent, ToolExecutionObserver } from '@packages/mica-tools/index.js';

export type ChangeOwner = 'agent' | 'mixed' | 'other';

export type TrackedGitFile = {
  path: string;
  status: string;
  owner: ChangeOwner;
};

type FileVersion = { content: Buffer | null; mode: string };
type Transition = { ownerId: string; path: string; before: FileVersion; after: FileVersion };
type Snapshot = { ownerId?: string; root: string; files: Map<string, FileVersion>; dirty: Map<string, string> };

export type PreparedAgentIndex = {
  indexPath: string;
  files: string[];
  finish(): void;
  dispose(): void;
};

export class AgentChangeTracker {
  private readonly transitions: Transition[] = [];
  private readonly mixedPaths = new Map<string, Set<string>>();

  constructor(private readonly cwd = process.cwd()) {}

  createObserver(): ToolExecutionObserver {
    return {
      before: (event) => this.beforeTool(event),
      after: (event) => this.afterTool(event),
    };
  }

  list(ownerId?: string): TrackedGitFile[] {
    const root = gitRoot(this.cwd);
    const dirty = readStatus(root);
    return [...dirty.entries()]
      .filter(([, status]) => status !== '__')
      .map(([path, status]) => {
        const current = readWorktreeVersion(root, path);
        const own = ownerId ? this.transitions.filter((item) => item.ownerId === ownerId && item.path === path) : [];
        const others = this.transitions.some((item) => item.ownerId !== ownerId && item.path === path);
        if (own.length === 0) return { path, status, owner: 'other' };
        const latest = own.at(-1)!;
        const unchangedSinceAgent = sameVersion(current, latest.after);
        const intervened = ownerId ? this.mixedPaths.get(ownerId)?.has(path) === true : false;
        return { path, status, owner: unchangedSinceAgent && !others && !intervened ? 'agent' : 'mixed' };
      });
  }

  prepareIndex(ownerId: string): PreparedAgentIndex {
    const root = gitRoot(this.cwd);
    const transitions = this.transitions.filter((item) => item.ownerId === ownerId);
    if (transitions.length === 0) throw new Error('当前 Agent 没有可提交的改动');

    const touched = [...new Set(transitions.map((item) => item.path))].sort();
    const headTree = gitText(['rev-parse', 'HEAD^{tree}'], { cwd: root }).trim();
    const indexTree = gitText(['write-tree'], { cwd: root }).trim();
    const owned = applyTransitions(root, headTree, transitions);
    const mergedIndex = applyTransitions(root, indexTree, transitions);
    const changed = touched.filter((path) => !sameVersion(readTreeVersion(root, headTree, path), owned.get(path)!));
    if (changed.length === 0) throw new Error('当前 Agent 的改动已不再产生可提交差异');

    const tempDir = mkdtempSync(join(tmpdir(), 'mica-agent-index-'));
    const commitIndex = join(tempDir, 'commit.index');
    const nextRealIndex = join(tempDir, 'real.index');
    writeIndex(root, commitIndex, headTree, changed, owned);
    writeIndex(root, nextRealIndex, indexTree, touched, mergedIndex);

    let finished = false;
    return {
      indexPath: commitIndex,
      files: changed,
      finish: () => {
        if (finished) return;
        const realIndex = resolveGitPath(root, gitText(['rev-parse', '--git-path', 'index'], { cwd: root }).trim());
        copyFileSync(nextRealIndex, realIndex);
        this.consume(ownerId);
        finished = true;
      },
      dispose: () => rmSync(tempDir, { recursive: true, force: true }),
    };
  }

  private beforeTool(event: ToolExecutionEvent): Snapshot | undefined {
    if (event.readOnly) return undefined;
    const ownerId = readOwnerId(event.callbacks?.context);
    if (!ownerId) return undefined;
    const root = gitRoot(this.cwd);
    this.markInterveningChanges(ownerId, root);
    const dirty = readStatus(root);
    return {
      ownerId,
      root,
      dirty,
      files: new Map([...dirty.keys()].map((path) => [path, readWorktreeVersion(root, path)])),
    };
  }

  private afterTool(event: ToolExecutionEvent & { state?: unknown }): void {
    const before = event.state as Snapshot | undefined;
    if (!before?.ownerId) return;
    const afterDirty = readStatus(before.root);
    const paths = new Set([...before.dirty.keys(), ...afterDirty.keys()]);
    for (const path of paths) {
      const beforeVersion = before.files.get(path) ?? readHeadVersion(before.root, path);
      const afterVersion = readWorktreeVersion(before.root, path);
      if (!sameVersion(beforeVersion, afterVersion)) {
        this.transitions.push({ ownerId: before.ownerId, path, before: beforeVersion, after: afterVersion });
      }
    }
  }

  private consume(ownerId: string): void {
    for (let index = this.transitions.length - 1; index >= 0; index--) {
      if (this.transitions[index]?.ownerId === ownerId) this.transitions.splice(index, 1);
    }
    this.mixedPaths.delete(ownerId);
  }

  private markInterveningChanges(ownerId: string, root: string): void {
    const latest = new Map<string, FileVersion>();
    for (const transition of this.transitions) {
      if (transition.ownerId === ownerId) latest.set(transition.path, transition.after);
    }
    for (const [path, version] of latest) {
      if (sameVersion(readWorktreeVersion(root, path), version)) continue;
      const paths = this.mixedPaths.get(ownerId) ?? new Set<string>();
      paths.add(path);
      this.mixedPaths.set(ownerId, paths);
    }
  }
}

function applyTransitions(root: string, tree: string, transitions: Transition[]): Map<string, FileVersion> {
  const result = new Map<string, FileVersion>();
  for (const transition of transitions) {
    const current = result.get(transition.path) ?? readTreeVersion(root, tree, transition.path);
    result.set(transition.path, mergeVersion(current, transition.before, transition.after, transition.path));
  }
  return result;
}

function mergeVersion(current: FileVersion, base: FileVersion, after: FileVersion, path: string): FileVersion {
  if (sameVersion(current, base) || sameVersion(current, after)) return cloneVersion(after);
  if (after.content === null) return cloneVersion(after);
  if (base.content === null) {
    if (current.content === null) return cloneVersion(after);
    throw new Error(`Agent 改动与现有内容冲突: ${path}`);
  }
  if (current.content === null || isBinary(current.content) || isBinary(base.content) || isBinary(after.content)) {
    throw new Error(`Agent 二进制改动与现有内容冲突: ${path}`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'mica-agent-merge-'));
  try {
    const currentPath = join(dir, 'current');
    const basePath = join(dir, 'base');
    const afterPath = join(dir, 'after');
    writeFileSync(currentPath, current.content);
    writeFileSync(basePath, base.content);
    writeFileSync(afterPath, after.content);
    const merged = spawnSync('git', ['merge-file', '-p', currentPath, basePath, afterPath], { encoding: 'buffer' });
    if (merged.status !== 0) throw new Error(`Agent 改动与现有内容冲突: ${path}`);
    return { content: Buffer.from(merged.stdout), mode: after.mode };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeIndex(
  root: string,
  indexPath: string,
  baseTree: string,
  paths: string[],
  versions: Map<string, FileVersion>,
): void {
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  execFileSync('git', ['read-tree', baseTree], { cwd: root, env, stdio: 'pipe' });
  for (const path of paths) {
    const version = versions.get(path)!;
    if (version.content === null) {
      execFileSync('git', ['update-index', '--force-remove', '--', path], { cwd: root, env, stdio: 'pipe' });
      continue;
    }
    const hash = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root,
      env,
      input: version.content,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `${version.mode},${hash},${path}`], {
      cwd: root,
      env,
      stdio: 'pipe',
    });
  }
}

function readStatus(root: string): Map<string, string> {
  const parts = gitBuffer(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root })
    .toString('utf8')
    .split('\0');
  const result = new Map<string, string>();
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    result.set(path, status);
    if (status.includes('R') || status.includes('C')) {
      const source = parts[++index];
      if (source) result.set(source, '__');
    }
  }
  return result;
}

function readWorktreeVersion(root: string, path: string): FileVersion {
  try {
    const fullPath = join(root, path);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) return { content: Buffer.from(readlinkSync(fullPath)), mode: '120000' };
    if (!stat.isFile()) return { content: null, mode: '100644' };
    return { content: readFileSync(fullPath), mode: stat.mode & 0o111 ? '100755' : '100644' };
  } catch {
    return { content: null, mode: '100644' };
  }
}

function readHeadVersion(root: string, path: string): FileVersion {
  return readTreeVersion(root, 'HEAD', path);
}

function readTreeVersion(root: string, tree: string, path: string): FileVersion {
  try {
    const line = gitBuffer(['ls-tree', tree, '--', path], { cwd: root }).toString('utf8').trim();
    if (!line) return { content: null, mode: '100644' };
    const match = /^(\d+)\s+blob\s+([0-9a-f]+)\t/.exec(line);
    if (!match) return { content: null, mode: '100644' };
    return { mode: match[1]!, content: gitBuffer(['cat-file', 'blob', match[2]!], { cwd: root }) };
  } catch {
    return { content: null, mode: '100644' };
  }
}

function readOwnerId(context: unknown): string | undefined {
  if (!context || typeof context !== 'object' || !('agent' in context)) return undefined;
  const agent = (context as { agent?: unknown }).agent;
  if (!agent || typeof agent !== 'object' || !('taskOwnerId' in agent)) return undefined;
  const id = (agent as { taskOwnerId?: unknown }).taskOwnerId;
  return typeof id === 'string' && id ? id : undefined;
}

function sameVersion(a: FileVersion, b: FileVersion): boolean {
  return a.mode === b.mode && fingerprint(a.content) === fingerprint(b.content);
}

function cloneVersion(version: FileVersion): FileVersion {
  return { mode: version.mode, content: version.content ? Buffer.from(version.content) : null };
}

function fingerprint(content: Buffer | null): string {
  return content === null ? 'deleted' : createHash('sha256').update(content).digest('hex');
}

function isBinary(content: Buffer): boolean {
  return content.includes(0);
}

function gitRoot(cwd: string): string {
  return gitText(['rev-parse', '--show-toplevel'], { cwd }).trim();
}

function resolveGitPath(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}
