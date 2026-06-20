import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  RewindApplyResult,
  RewindFileAction,
  RewindFileChange,
  RewindPreviewResult,
  RuntimeInput,
} from '@packages/mica-runtime/index.js';
import type { AgentRuntime, AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';

type FileSnapshotEntry =
  | { kind: 'absent' }
  | { kind: 'file'; data: Buffer; mode: number }
  | { kind: 'symlink'; target: string };

type FileStateSnapshot =
  | {
      available: true;
      root: string;
      entries: Map<string, FileSnapshotEntry>;
    }
  | {
      available: false;
      root: string;
      error: string;
      entries: Map<string, FileSnapshotEntry>;
    };

type RewindCheckpoint = {
  id: string;
  createdAt: string;
  conversationLabel: string;
  snapshot: AgentRuntimeSnapshot;
  fileState: FileStateSnapshot;
};

const MAX_CHECKPOINTS_PER_AGENT = 20;
const MAX_LABEL_CHARS = 80;

export class RewindCheckpointManager {
  private readonly checkpoints = new WeakMap<AgentRuntime, RewindCheckpoint[]>();

  capture(agent: AgentRuntime, input: RuntimeInput): void {
    const checkpoint: RewindCheckpoint = {
      id: `${input.id}-${Date.now()}`,
      createdAt: new Date().toISOString(),
      conversationLabel: labelForInput(input.text),
      snapshot: cloneSnapshot(agent.getSnapshot()),
      fileState: captureFileState(),
    };
    const next = [...(this.checkpoints.get(agent) ?? []), checkpoint].slice(-MAX_CHECKPOINTS_PER_AGENT);
    this.checkpoints.set(agent, next);
  }

  clear(agent: AgentRuntime): void {
    this.checkpoints.delete(agent);
  }

  preview(agent: AgentRuntime): RewindPreviewResult {
    const checkpoint = this.latest(agent);
    if (!checkpoint) return { ok: false, message: 'rewind: 没有可回退的上一轮对话' };

    const files = previewFileChanges(checkpoint.fileState);
    return {
      ok: true,
      id: checkpoint.id,
      conversationLabel: checkpoint.conversationLabel,
      createdAt: checkpoint.createdAt,
      messageCountBefore: checkpoint.snapshot.messages.length,
      messageCountNow: agent.getSnapshot().messages.length,
      fileStateAvailable: checkpoint.fileState.available,
      fileStateError: checkpoint.fileState.available ? undefined : checkpoint.fileState.error,
      files,
    };
  }

  apply(agent: AgentRuntime, id: string): RewindApplyResult {
    const stack = this.checkpoints.get(agent) ?? [];
    const index = stack.findIndex((checkpoint) => checkpoint.id === id);
    if (index === -1) throw new Error('rewind checkpoint not found');

    const checkpoint = stack[index]!;
    const files = restoreFileState(checkpoint.fileState);
    agent.loadSnapshot(cloneSnapshot(checkpoint.snapshot));
    this.checkpoints.set(agent, stack.slice(0, index));

    return {
      id: checkpoint.id,
      conversationLabel: checkpoint.conversationLabel,
      messageCount: checkpoint.snapshot.messages.length,
      fileStateAvailable: checkpoint.fileState.available,
      fileStateError: checkpoint.fileState.available ? undefined : checkpoint.fileState.error,
      files,
    };
  }

  private latest(agent: AgentRuntime): RewindCheckpoint | null {
    return this.checkpoints.get(agent)?.at(-1) ?? null;
  }
}

function captureFileState(): FileStateSnapshot {
  try {
    const root = gitText(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    const paths = collectDirtyPaths(root);
    const entries = new Map<string, FileSnapshotEntry>();
    for (const path of paths) {
      const entry = snapshotPath(root, path);
      if (entry) entries.set(path, entry);
    }
    return { available: true, root, entries };
  } catch (error) {
    return {
      available: false,
      root: process.cwd(),
      error: error instanceof Error ? error.message : String(error),
      entries: new Map(),
    };
  }
}

function previewFileChanges(state: FileStateSnapshot): RewindFileChange[] {
  if (!state.available) return [];
  return describeFileChanges(state, collectDirtyPaths(state.root));
}

function restoreFileState(state: FileStateSnapshot): RewindFileChange[] {
  if (!state.available) return [];
  const currentDirtyPaths = collectDirtyPaths(state.root);
  const files = describeFileChanges(state, currentDirtyPaths);
  if (files.length === 0) return files;

  const headPaths = new Set(files.map((file) => file.path).filter((path) => pathExistsInHead(state.root, path)));
  const headTracked = files.map((file) => file.path).filter((path) => headPaths.has(path));
  if (headTracked.length > 0) {
    gitBuffer(state.root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...headTracked]);
  }

  for (const file of files) {
    const entry = state.entries.get(file.path);
    if (entry) {
      restoreEntry(state.root, file.path, entry);
      continue;
    }
    if (!headPaths.has(file.path)) {
      removePath(state.root, file.path);
    }
  }

  return files;
}

function describeFileChanges(
  state: Extract<FileStateSnapshot, { available: true }>,
  currentDirtyPaths: string[],
): RewindFileChange[] {
  const paths = new Set([...state.entries.keys(), ...currentDirtyPaths]);
  const headPaths = new Set([...paths].filter((path) => pathExistsInHead(state.root, path)));
  return [...paths]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const entry = state.entries.get(path);
      const action: RewindFileAction =
        entry?.kind === 'absent' || (!entry && !headPaths.has(path)) ? 'delete' : 'restore';
      return { path, action };
    });
}

function collectDirtyPaths(root: string): string[] {
  const tracked = splitNul(gitBuffer(root, ['diff', '--name-only', '-z', 'HEAD', '--']));
  const untracked = splitNul(gitBuffer(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  return [...new Set([...tracked, ...untracked])].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function snapshotPath(root: string, path: string): FileSnapshotEntry | null {
  const absolute = safePath(root, path);
  if (!existsSync(absolute)) return { kind: 'absent' };

  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    return { kind: 'symlink', target: readlinkSync(absolute) };
  }
  if (stat.isFile()) {
    return { kind: 'file', data: readFileSync(absolute), mode: stat.mode & 0o777 };
  }
  return null;
}

function restoreEntry(root: string, path: string, entry: FileSnapshotEntry): void {
  if (entry.kind === 'absent') {
    removePath(root, path);
    return;
  }

  const absolute = safePath(root, path);
  rmSync(absolute, { recursive: true, force: true });
  mkdirSync(dirname(absolute), { recursive: true });

  if (entry.kind === 'symlink') {
    symlinkSync(entry.target, absolute);
    return;
  }

  writeFileSync(absolute, entry.data);
  chmodSync(absolute, entry.mode);
}

function removePath(root: string, path: string): void {
  const absolute = safePath(root, path);
  rmSync(absolute, { recursive: true, force: true });
  pruneEmptyParents(dirname(absolute), root);
}

function pruneEmptyParents(start: string, root: string): void {
  let current = start;
  while (current !== root && current.startsWith(root)) {
    try {
      rmSync(current, { recursive: false });
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function pathExistsInHead(root: string, path: string): boolean {
  const output = gitBuffer(root, ['ls-tree', '-z', '--name-only', 'HEAD', '--', path]);
  return splitNul(output).includes(path);
}

function safePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Unsafe rewind path: ${path}`);
  }
  return absolute;
}

function gitText(cwd: string, args: string[]): string {
  return gitBuffer(cwd, args).toString('utf-8');
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 100 * 1024 * 1024,
  }) as Buffer;
}

function splitNul(buffer: Buffer): string[] {
  if (buffer.length === 0) return [];
  return buffer.toString('utf-8').split('\0').filter(Boolean);
}

function cloneSnapshot(snapshot: AgentRuntimeSnapshot): AgentRuntimeSnapshot {
  return {
    providerId: snapshot.providerId,
    model: snapshot.model,
    effort: snapshot.effort,
    messages: cloneJson(snapshot.messages),
    usageHistory: cloneJson(snapshot.usageHistory),
    lastUsage: cloneJson(snapshot.lastUsage),
  };
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function labelForInput(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '(empty input)';
  return oneLine.length > MAX_LABEL_CHARS ? `${oneLine.slice(0, MAX_LABEL_CHARS - 3)}...` : oneLine;
}
