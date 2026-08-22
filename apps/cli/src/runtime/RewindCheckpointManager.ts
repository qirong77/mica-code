import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { micaContext } from '@packages/mica-context/index.js';
import type { RewindFileAction, RewindFileChange, RuntimeInput } from '@packages/mica-runtime/index.js';
import type {
  RewindApplyRequest,
  RewindApplyResult,
  RewindCheckpointSummary,
  RewindPreviewResult,
} from '@packages/mica-runtime/Rewind.js';
import { gitBuffer, gitText } from '@packages/mica-common/index.js';
import type { AgentRuntime, AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';

type FileSnapshotEntry =
  | { kind: 'absent' }
  | { kind: 'file'; data: Buffer; mode: number }
  | { kind: 'symlink'; target: string };

type FileStateSnapshot =
  | {
      available: true;
      root: string;
      headOid: string;
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
  /** Owning agent identity (agent.taskOwnerId); used to scope disk-backed checkpoints. */
  agentId: string;
  createdAt: string;
  conversationLabel: string;
  inputText: string;
  conversationMessages: unknown[];
  snapshot: AgentRuntimeSnapshot;
  fileState: FileStateSnapshot;
};

type CurrentFileState =
  | {
      available: true;
      dirtyPaths: string[];
      headPaths: Set<string>;
      indexPaths: Set<string>;
      headOid: string;
      previewToken: string;
    }
  | {
      available: false;
      error: string;
      previewToken: string;
    };

type RewindPreviewPlan = {
  checkpointId: string;
  fileStateAvailable: boolean;
  fileStateError?: string;
  files: RewindFileChange[];
  headPaths: Set<string>;
  indexPaths: Set<string>;
  previewToken: string;
};

const MAX_CHECKPOINTS_PER_AGENT = 20;
const MAX_LABEL_CHARS = 80;
const GIT_MAX_BUFFER = 100 * 1024 * 1024;
const MAX_CHECKPOINT_SNAPSHOT_CHARS = 1_500_000;
const MAX_DIRTY_FILES = 120;
const MAX_FILE_SNAPSHOT_BYTES = 1 * 1024 * 1024;
const MAX_FILE_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024;
/** Checkpoints older than this are pruned on every write. */
const REWIND_RETENTION_MS = 24 * 60 * 60 * 1000;
const REWIND_DIR = resolve(process.env.MICA_HOME || resolve(homedir(), '.mica'), 'rewind');
const REWIND_FILE_VERSION = 1;

type SerializedCheckpoint = {
  version: number;
  id: string;
  agentId: string;
  createdAt: string;
  conversationLabel: string;
  inputText: string;
  conversationMessages: unknown[];
  snapshot: AgentRuntimeSnapshot;
  fileState: SerializedFileState;
};

type SerializedFileState = {
  available: boolean;
  root: string;
  headOid?: string;
  error?: string;
  entries: Array<[string, SerializedFileSnapshotEntry]>;
};

type SerializedFileSnapshotEntry =
  | { kind: 'absent' }
  | { kind: 'symlink'; target: string }
  | { kind: 'file'; data: string; mode: number };

function checkpointFileName(agentId: string, id: string): string {
  const safeAgent = agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${safeAgent}__${safeId}.json`;
}

function serializeCheckpoint(checkpoint: RewindCheckpoint): SerializedCheckpoint {
  return {
    version: REWIND_FILE_VERSION,
    id: checkpoint.id,
    agentId: checkpoint.agentId,
    createdAt: checkpoint.createdAt,
    conversationLabel: checkpoint.conversationLabel,
    inputText: checkpoint.inputText,
    conversationMessages: checkpoint.conversationMessages,
    snapshot: checkpoint.snapshot,
    fileState: {
      available: checkpoint.fileState.available,
      root: checkpoint.fileState.root,
      headOid: checkpoint.fileState.available ? checkpoint.fileState.headOid : undefined,
      error: checkpoint.fileState.available ? undefined : checkpoint.fileState.error,
      entries: [...checkpoint.fileState.entries.entries()].map(([path, entry]) => [
        path,
        entry.kind === 'file' ? { kind: 'file' as const, data: entry.data.toString('base64'), mode: entry.mode } : entry,
      ]),
    },
  };
}

function deserializeCheckpoint(data: SerializedCheckpoint): RewindCheckpoint {
  const fileState: FileStateSnapshot = data.fileState.available
    ? {
        available: true,
        root: data.fileState.root,
        headOid: data.fileState.headOid ?? '',
        entries: new Map(
          data.fileState.entries.map(([path, entry]) => [
            path,
            entry.kind === 'file'
              ? { kind: 'file' as const, data: Buffer.from(entry.data, 'base64'), mode: entry.mode }
              : entry,
          ]),
        ),
      }
    : {
        available: false,
        root: data.fileState.root,
        error: data.fileState.error ?? 'unknown error',
        entries: new Map(),
      };
  return {
    id: data.id,
    agentId: data.agentId,
    createdAt: data.createdAt,
    conversationLabel: data.conversationLabel,
    inputText: data.inputText,
    conversationMessages: data.conversationMessages,
    snapshot: data.snapshot,
    fileState,
  };
}

function agentIdOf(agent: AgentRuntime): string {
  return agent.taskOwnerId ?? 'agent-default';
}

export class RewindCheckpointManager {
  private readonly previewPlans = new WeakMap<AgentRuntime, Map<string, RewindPreviewPlan>>();
  private nextCheckpointId = 1;

  constructor(private readonly dir: string = REWIND_DIR) {}

  capture(agent: AgentRuntime, input: RuntimeInput, conversationMessages: unknown[] = []): string | null {
    if (this.listCheckpoints(agent).length === 0) {
      try {
        this.restoreConversationHistory(agent, conversationMessages);
      } catch {
        // History recovery is best-effort and must never prevent a new live checkpoint.
        this.previewPlans.delete(agent);
      }
    }
    try {
      const snapshot = agent.getSnapshot();
      const checkpointChars =
        estimateJsonLikeChars(snapshot, MAX_CHECKPOINT_SNAPSHOT_CHARS) +
        estimateJsonLikeChars(input.text, MAX_CHECKPOINT_SNAPSHOT_CHARS) +
        estimateJsonLikeChars(conversationMessages, MAX_CHECKPOINT_SNAPSHOT_CHARS);
      if (checkpointChars > MAX_CHECKPOINT_SNAPSHOT_CHARS) {
        this.previewPlans.delete(agent);
        return null;
      }

      const checkpoint: RewindCheckpoint = {
        id: `${input.id}-${Date.now()}-${this.nextCheckpointId++}`,
        agentId: agentIdOf(agent),
        createdAt: new Date().toISOString(),
        conversationLabel: labelForInput(input.displayText ?? input.text),
        inputText: input.text,
        conversationMessages: cloneJson(conversationMessages),
        snapshot: cloneSnapshot(snapshot),
        fileState: captureFileState(),
      };
      this.writeCheckpoint(checkpoint);
      this.previewPlans.delete(agent);
      return checkpoint.id;
    } catch {
      this.previewPlans.delete(agent);
      return null;
    }
  }

  finalize(agent: AgentRuntime, id: string, conversationMessages: unknown[] = []): void {
    const checkpoint = this.readCheckpoint(agentIdOf(agent), id);
    if (!checkpoint) return;
    try {
      const snapshot = agent.getSnapshot();
      const checkpointChars =
        estimateJsonLikeChars(snapshot, MAX_CHECKPOINT_SNAPSHOT_CHARS) +
        estimateJsonLikeChars(conversationMessages, MAX_CHECKPOINT_SNAPSHOT_CHARS);
      if (checkpointChars > MAX_CHECKPOINT_SNAPSHOT_CHARS) {
        this.remove(agent, id);
        return;
      }
      const updated: RewindCheckpoint = {
        ...checkpoint,
        snapshot: cloneSnapshot(snapshot),
        conversationMessages: cloneJson(conversationMessages),
        fileState: captureFileState(),
      };
      this.writeCheckpoint(updated);
      this.previewPlans.delete(agent);
    } catch {
      // Never expose a checkpoint with the old pre-turn semantics.
      this.remove(agent, id);
    }
  }

  clear(agent: AgentRuntime): void {
    this.removeAgentCheckpoints(agentIdOf(agent));
    this.previewPlans.delete(agent);
  }

  restoreConversationHistory(agent: AgentRuntime, conversationMessages: unknown[] = []): number {
    const snapshot = agent.getSnapshot();
    const providerMessages = cloneJson(snapshot.messages);
    const usageHistory = cloneJson(snapshot.usageHistory);
    const uiMessages = cloneJson(conversationMessages);
    const turnBoundaries = visibleUserTurnBoundaries(providerMessages, uiMessages).slice(-MAX_CHECKPOINTS_PER_AGENT);
    const restored: RewindCheckpoint[] = [];
    const restoredAt = Date.now();

    for (let turn = 0; turn < turnBoundaries.length; turn++) {
      const { messageIndex, uiMessageIndex } = turnBoundaries[turn]!;
      const nextBoundary = turnBoundaries[turn + 1];
      const messageEndIndex = nextBoundary?.messageIndex ?? providerMessages.length;
      const uiMessageEndIndex = nextBoundary?.uiMessageIndex ?? uiMessages.length;
      const providerMessage = providerMessages[messageIndex];
      const uiMessage = uiMessageIndex === undefined ? undefined : uiMessages[uiMessageIndex];
      const inputText = messageText(uiMessage ?? providerMessage);
      const displayText = displayMessageText(uiMessage) || inputText;
      const checkpointUsage = nextBoundary
        ? usageBeforeMessage(snapshot.protocol, usageHistory, messageEndIndex)
        : usageHistory;

      restored.push({
        id: `history-${restoredAt}-${this.nextCheckpointId++}`,
        agentId: agentIdOf(agent),
        createdAt: new Date(restoredAt - (turnBoundaries.length - turn) * 1000).toISOString(),
        conversationLabel: labelForInput(displayText),
        inputText,
        conversationMessages: uiMessageIndex === undefined ? [] : uiMessages.slice(0, uiMessageEndIndex),
        snapshot: {
          providerId: snapshot.providerId,
          protocol: snapshot.protocol,
          model: snapshot.model,
          effort: snapshot.effort,
          role: snapshot.role,
          messages: providerMessages.slice(0, messageEndIndex),
          usageHistory: checkpointUsage,
          lastUsage: checkpointUsage.at(-1),
        },
        fileState: unavailableFileState('该节点由现有对话恢复，未记录历史文件状态；本次仅回退对话'),
      });
    }

    this.removeAgentCheckpoints(agentIdOf(agent));
    for (const checkpoint of restored) {
      this.writeCheckpoint(checkpoint);
    }
    this.previewPlans.delete(agent);
    return restored.length;
  }

  list(agent: AgentRuntime): RewindCheckpointSummary[] {
    return this.listCheckpoints(agent).map(checkpointSummary);
  }

  preview(agent: AgentRuntime, id?: string): RewindPreviewResult {
    const checkpoint = id ? this.find(agent, id) : this.latest(agent);
    if (!checkpoint) {
      return {
        ok: false,
        message: id ? 'rewind: 找不到指定的回退点' : 'rewind: 没有可回退的上一轮对话',
      };
    }

    const plan = createPreviewPlan(checkpoint);
    const plans = this.previewPlans.get(agent) ?? new Map<string, RewindPreviewPlan>();
    for (const [token, existing] of plans) {
      if (existing.checkpointId === checkpoint.id) plans.delete(token);
    }
    plans.set(plan.previewToken, plan);
    this.previewPlans.set(agent, plans);

    return {
      ok: true,
      ...checkpointSummary(checkpoint),
      messageCountNow: agent.getSnapshot().messages.length,
      fileStateAvailable: plan.fileStateAvailable,
      fileStateError: plan.fileStateError,
      files: plan.files,
      previewToken: plan.previewToken,
    };
  }

  apply(agent: AgentRuntime, request: RewindApplyRequest): RewindApplyResult {
    const agentId = agentIdOf(agent);
    const stack = this.listCheckpoints(agent);
    const index = stack.findIndex((checkpoint) => checkpoint.id === request.id);
    if (index === -1) throw new Error('rewind checkpoint not found');

    const checkpoint = stack[index]!;
    const messageCountNow = agent.getSnapshot().messages.length;
    const requestedPlan = this.previewPlans.get(agent)?.get(request.previewToken);
    const matchingPlan = requestedPlan?.checkpointId === checkpoint.id ? requestedPlan : undefined;
    if (!matchingPlan) {
      throw new Error('rewind stale preview: preview token is missing or belongs to another checkpoint');
    }
    let files: RewindFileChange[] = [];
    let fileStateAvailable = checkpoint.fileState.available;
    let fileStateError = checkpoint.fileState.available ? undefined : checkpoint.fileState.error;
    if (matchingPlan) {
      fileStateAvailable = matchingPlan.fileStateAvailable;
      fileStateError = matchingPlan.fileStateError;
    }

    if (request.mode === 'conversation_and_files') {
      const plan = matchingPlan;
      if (!checkpoint.fileState.available) {
        throw new Error(`rewind file state unavailable: ${checkpoint.fileState.error}`);
      }
      if (!plan.fileStateAvailable) {
        throw new Error(`rewind file state unavailable: ${plan.fileStateError ?? 'unknown file state error'}`);
      }

      const current = captureCurrentFileState(checkpoint.id, checkpoint.fileState.root);
      if (!current.available || current.previewToken !== request.previewToken) {
        throw new Error('rewind stale preview: workspace changed after preview; preview again before applying');
      }

      // All stale checks happen before the first file or conversation mutation.
      // The restore receives the exact path set shown by preview.
      try {
        files = restoreFileState(checkpoint.fileState, plan.files, plan.headPaths, plan.indexPaths);
      } catch (error) {
        throw new Error(`rewind file restore failed; workspace may be partially restored: ${errorMessage(error)}`);
      }
      fileStateAvailable = true;
      fileStateError = undefined;
    }

    try {
      agent.loadSnapshot(cloneSnapshot(checkpoint.snapshot));
    } catch (error) {
      const prefix = files.length > 0 ? 'rewind files changed, but conversation restore failed' : 'rewind failed';
      throw new Error(`${prefix}: ${errorMessage(error)}`);
    }
    this.keepCheckpointsUpTo(agentId, stack[index]!);
    this.previewPlans.delete(agent);

    return {
      id: checkpoint.id,
      mode: request.mode,
      conversationLabel: checkpoint.conversationLabel,
      inputText: checkpoint.inputText,
      messageCountBefore: checkpoint.snapshot.messages.length,
      messageCountNow,
      messageCountRemoved: Math.max(0, messageCountNow - checkpoint.snapshot.messages.length),
      conversationMessagesBefore: cloneJson(checkpoint.conversationMessages),
      fileStateAvailable,
      fileStateError,
      files,
    };
  }

  private find(agent: AgentRuntime, id: string): RewindCheckpoint | null {
    return this.readCheckpoint(agentIdOf(agent), id);
  }

  private latest(agent: AgentRuntime): RewindCheckpoint | null {
    return this.listCheckpoints(agent).at(-1) ?? null;
  }

  private remove(agent: AgentRuntime, id: string): void {
    const path = this.checkpointPath(agentIdOf(agent), id);
    if (existsSync(path)) rmSync(path, { force: true });
    this.previewPlans.delete(agent);
  }

  /** Read all checkpoints for an agent from disk, oldest first, capped to the retention window. */
  private listCheckpoints(agent: AgentRuntime): RewindCheckpoint[] {
    const agentId = agentIdOf(agent);
    const cutoff = Date.now() - REWIND_RETENTION_MS;
    const result: RewindCheckpoint[] = [];
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((file) => file.startsWith(`${safeAgentPrefix(agentId)}__`));
    } catch {
      return [];
    }
    for (const file of files) {
      const checkpoint = readCheckpointFile(resolve(this.dir, file));
      if (!checkpoint) continue;
      if (Date.parse(checkpoint.createdAt) < cutoff) continue;
      result.push(checkpoint);
    }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private writeCheckpoint(checkpoint: RewindCheckpoint): void {
    mkdirSync(this.dir, { recursive: true });
    const path = this.checkpointPath(checkpoint.agentId, checkpoint.id);
    const tmpPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(serializeCheckpoint(checkpoint))}\n`, 'utf-8');
    renameSync(tmpPath, path);
    this.pruneExpired();
  }

  private readCheckpoint(agentId: string, id: string): RewindCheckpoint | null {
    return readCheckpointFile(this.checkpointPath(agentId, id));
  }

  private removeAgentCheckpoints(agentId: string): void {
    const prefix = `${safeAgentPrefix(agentId)}__`;
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((file) => file.startsWith(prefix));
    } catch {
      return;
    }
    for (const file of files) rmSync(resolve(this.dir, file), { force: true });
  }

  /** After applying a rewind, drop every checkpoint created after the selected one. */
  private keepCheckpointsUpTo(agentId: string, selected: RewindCheckpoint): void {
    const prefix = `${safeAgentPrefix(agentId)}__`;
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((file) => file.startsWith(prefix));
    } catch {
      return;
    }
    for (const file of files) {
      const checkpoint = readCheckpointFile(resolve(this.dir, file));
      if (!checkpoint) continue;
      if (checkpoint.createdAt > selected.createdAt) rmSync(resolve(this.dir, file), { force: true });
    }
  }

  /** Remove checkpoints older than the retention window and cap each agent to the max count. */
  private pruneExpired(): void {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((file) => file.endsWith('.json'));
    } catch {
      return;
    }
    const cutoff = Date.now() - REWIND_RETENTION_MS;
    const byAgent = new Map<string, Array<{ file: string; createdAt: string }>>();
    for (const file of files) {
      const checkpoint = readCheckpointFile(resolve(this.dir, file));
      if (!checkpoint) continue;
      if (Date.parse(checkpoint.createdAt) < cutoff) {
        rmSync(resolve(this.dir, file), { force: true });
        continue;
      }
      const bucket = byAgent.get(checkpoint.agentId) ?? [];
      bucket.push({ file, createdAt: checkpoint.createdAt });
      byAgent.set(checkpoint.agentId, bucket);
    }
    for (const bucket of byAgent.values()) {
      bucket.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const entry of bucket.slice(0, Math.max(0, bucket.length - MAX_CHECKPOINTS_PER_AGENT))) {
        rmSync(resolve(this.dir, entry.file), { force: true });
      }
    }
  }

  private checkpointPath(agentId: string, id: string): string {
    return resolve(this.dir, checkpointFileName(agentId, id));
  }
}

function safeAgentPrefix(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function readCheckpointFile(path: string): RewindCheckpoint | null {
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf-8')) as SerializedCheckpoint;
    if (!data || data.version !== REWIND_FILE_VERSION) return null;
    return deserializeCheckpoint(data);
  } catch {
    return null;
  }
}

function checkpointSummary(checkpoint: RewindCheckpoint): RewindCheckpointSummary {
  return {
    id: checkpoint.id,
    conversationLabel: checkpoint.conversationLabel,
    createdAt: checkpoint.createdAt,
    messageCountBefore: checkpoint.snapshot.messages.length,
  };
}

function createPreviewPlan(checkpoint: RewindCheckpoint): RewindPreviewPlan {
  if (!checkpoint.fileState.available) {
    return {
      checkpointId: checkpoint.id,
      fileStateAvailable: false,
      fileStateError: checkpoint.fileState.error,
      files: [],
      headPaths: new Set(),
      indexPaths: new Set(),
      previewToken: unavailablePreviewToken(checkpoint.id, checkpoint.fileState.error),
    };
  }

  const current = captureCurrentFileState(checkpoint.id, checkpoint.fileState.root);
  if (!current.available) {
    return {
      checkpointId: checkpoint.id,
      fileStateAvailable: false,
      fileStateError: current.error,
      files: [],
      headPaths: new Set(),
      indexPaths: new Set(),
      previewToken: current.previewToken,
    };
  }

  if (current.headOid !== checkpoint.fileState.headOid) {
    return {
      checkpointId: checkpoint.id,
      fileStateAvailable: false,
      fileStateError: 'Git HEAD changed since this checkpoint; only conversation rewind is safe',
      files: [],
      headPaths: new Set(),
      indexPaths: new Set(),
      previewToken: current.previewToken,
    };
  }

  const files = describeFileChanges(checkpoint.fileState, current.dirtyPaths, current.headPaths);
  if (hasNestedPathConflict(files)) {
    return {
      checkpointId: checkpoint.id,
      fileStateAvailable: false,
      fileStateError: 'file/directory replacement cannot be restored safely; use conversation-only rewind',
      files: [],
      headPaths: new Set(),
      indexPaths: new Set(),
      previewToken: current.previewToken,
    };
  }

  return {
    checkpointId: checkpoint.id,
    fileStateAvailable: true,
    files,
    headPaths: current.headPaths,
    indexPaths: current.indexPaths,
    previewToken: current.previewToken,
  };
}

function hasNestedPathConflict(files: RewindFileChange[]): boolean {
  const paths = files.map((file) => file.path).sort((a, b) => a.localeCompare(b));
  return paths.some((path, index) => paths[index + 1]?.startsWith(`${path}/`));
}

function captureCurrentFileState(checkpointId: string, root: string): CurrentFileState {
  try {
    const head = gitBuffer(['rev-parse', '--verify', 'HEAD'], { cwd: root, maxBuffer: GIT_MAX_BUFFER });
    const staged = gitBuffer(['diff', '--cached', '--raw', '--no-abbrev', '-z', 'HEAD', '--'], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
    });
    const unstaged = gitBuffer(['diff', '--raw', '--no-abbrev', '-z', '--'], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
    });
    const status = gitBuffer(['status', '--porcelain=v2', '-z', '--untracked-files=all'], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
    });
    const dirtyAgainstHead = gitBuffer(['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--'], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
    });
    const untracked = gitBuffer(['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
    });
    const dirtyPaths = [...new Set([...splitNul(dirtyAgainstHead), ...splitNul(untracked)])]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (dirtyPaths.length > MAX_DIRTY_FILES) {
      throw new Error(`too many dirty files for rewind preview: ${dirtyPaths.length} > ${MAX_DIRTY_FILES}`);
    }
    const headPaths = pathsExistingInHead(root, dirtyPaths);
    const indexPaths = new Set(
      dirtyPaths.length === 0
        ? []
        : splitNul(gitBuffer(['ls-files', '-z', '--', ...dirtyPaths], { cwd: root, maxBuffer: GIT_MAX_BUFFER })),
    );
    const hash = createHash('sha256');
    hashField(hash, 'checkpoint', Buffer.from(checkpointId));
    hashField(hash, 'head', head);
    hashField(hash, 'status', status);
    hashField(hash, 'staged', staged);
    hashField(hash, 'unstaged', unstaged);
    hashField(hash, 'untracked', untracked);
    const budget = { totalBytes: 0 };
    for (const path of dirtyPaths) hashCurrentPath(hash, root, path, budget);
    return {
      available: true,
      dirtyPaths,
      headPaths,
      indexPaths,
      headOid: head.toString('utf-8').trim(),
      previewToken: `sha256:${hash.digest('hex')}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      error: message,
      previewToken: unavailablePreviewToken(checkpointId, message),
    };
  }
}

function unavailablePreviewToken(checkpointId: string, error: string): string {
  const hash = createHash('sha256');
  hashField(hash, 'checkpoint', Buffer.from(checkpointId));
  hashField(hash, 'unavailable', Buffer.from(error));
  return `sha256:${hash.digest('hex')}`;
}

function hashCurrentPath(
  hash: ReturnType<typeof createHash>,
  root: string,
  path: string,
  budget: { totalBytes: number },
): void {
  const absolute = safePath(root, path);
  hashField(hash, 'path', Buffer.from(path));
  const stat = tryLstat(absolute);
  if (!stat) {
    hashField(hash, 'type', Buffer.from('absent'));
    return;
  }

  hashField(hash, 'mode', Buffer.from(String(stat.mode & 0o7777)));
  if (stat.isSymbolicLink()) {
    hashField(hash, 'type', Buffer.from('symlink'));
    hashField(hash, 'target', Buffer.from(readlinkSync(absolute)));
  } else if (stat.isFile()) {
    if (stat.size > MAX_FILE_SNAPSHOT_BYTES) {
      throw new Error(`dirty file too large for rewind preview: ${path} (${stat.size} bytes)`);
    }
    if (budget.totalBytes + stat.size > MAX_FILE_SNAPSHOT_TOTAL_BYTES) {
      throw new Error(
        `dirty files exceed rewind preview budget: ${budget.totalBytes + stat.size} > ${MAX_FILE_SNAPSHOT_TOTAL_BYTES} bytes`,
      );
    }
    budget.totalBytes += stat.size;
    hashField(hash, 'type', Buffer.from('file'));
    hashField(hash, 'content', readFileSync(absolute));
  } else if (stat.isDirectory()) {
    hashField(hash, 'type', Buffer.from('directory'));
  } else {
    hashField(hash, 'type', Buffer.from('other'));
  }
}

function hashField(hash: ReturnType<typeof createHash>, name: string, value: Buffer): void {
  hash.update(`${name.length}:${name}:${value.length}:`);
  hash.update(value);
}

function captureFileState(): FileStateSnapshot {
  try {
    const root = gitText(['rev-parse', '--show-toplevel'], { cwd: process.cwd(), maxBuffer: GIT_MAX_BUFFER }).trim();
    const headOid = gitText(['rev-parse', '--verify', 'HEAD'], { cwd: root, maxBuffer: GIT_MAX_BUFFER }).trim();
    const staged = gitBuffer(['diff', '--cached', '--name-only', '-z', 'HEAD', '--'], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
    });
    if (staged.length > 0) {
      throw new Error('staged or partially-staged changes cannot be restored safely');
    }
    const paths = collectDirtyPaths(root);
    if (paths.length > MAX_DIRTY_FILES) {
      throw new Error(`too many dirty files for rewind snapshot: ${paths.length} > ${MAX_DIRTY_FILES}`);
    }
    const entries = new Map<string, FileSnapshotEntry>();
    const budget = { totalBytes: 0 };
    for (const path of paths) {
      const entry = snapshotPath(root, path, budget);
      entries.set(path, entry);
    }
    return { available: true, root, headOid, entries };
  } catch (error) {
    return {
      available: false,
      root: process.cwd(),
      error: error instanceof Error ? error.message : String(error),
      entries: new Map(),
    };
  }
}

function unavailableFileState(error: string): FileStateSnapshot {
  return {
    available: false,
    root: process.cwd(),
    error,
    entries: new Map(),
  };
}

function restoreFileState(
  state: Extract<FileStateSnapshot, { available: true }>,
  files: RewindFileChange[],
  headPaths: Set<string>,
  indexPaths: Set<string>,
): RewindFileChange[] {
  if (files.length === 0) return files;
  for (const file of files) safePath(state.root, file.path);

  const headTracked = files.map((file) => file.path).filter((path) => headPaths.has(path));
  if (headTracked.length > 0) {
    gitBuffer(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...headTracked], {
      cwd: state.root,
      maxBuffer: GIT_MAX_BUFFER,
    });
  }
  const indexOnly = files.map((file) => file.path).filter((path) => indexPaths.has(path) && !headPaths.has(path));
  if (indexOnly.length > 0) {
    gitBuffer(['restore', '--source=HEAD', '--staged', '--', ...indexOnly], {
      cwd: state.root,
      maxBuffer: GIT_MAX_BUFFER,
    });
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
  headPaths: Set<string>,
): RewindFileChange[] {
  const paths = new Set([...state.entries.keys(), ...currentDirtyPaths]);
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
  const tracked = splitNul(
    gitBuffer(['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--'], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER,
    }),
  );
  const untracked = splitNul(
    gitBuffer(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: GIT_MAX_BUFFER }),
  );
  return [...new Set([...tracked, ...untracked])].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function snapshotPath(root: string, path: string, budget: { totalBytes: number }): FileSnapshotEntry {
  const absolute = safePath(root, path);
  const stat = tryLstat(absolute);
  if (!stat) return { kind: 'absent' };

  if (stat.isSymbolicLink()) {
    return { kind: 'symlink', target: readlinkSync(absolute) };
  }
  if (stat.isFile()) {
    if (stat.size > MAX_FILE_SNAPSHOT_BYTES) {
      throw new Error(`dirty file too large for rewind snapshot: ${path} (${stat.size} bytes)`);
    }
    if (budget.totalBytes + stat.size > MAX_FILE_SNAPSHOT_TOTAL_BYTES) {
      throw new Error(
        `dirty files exceed rewind snapshot budget: ${budget.totalBytes + stat.size} > ${MAX_FILE_SNAPSHOT_TOTAL_BYTES} bytes`,
      );
    }
    budget.totalBytes += stat.size;
    return { kind: 'file', data: readFileSync(absolute), mode: stat.mode & 0o777 };
  }
  throw new Error(`unsupported file type for rewind snapshot: ${path}`);
}

function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
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

function pathsExistingInHead(root: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const output = gitBuffer(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...paths], {
    cwd: root,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return new Set(splitNul(output));
}

function safePath(root: string, path: string): string {
  const resolvedRoot = resolve(root);
  const absolute = resolve(resolvedRoot, path);
  const rel = relative(resolvedRoot, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Unsafe rewind path: ${path}`);
  }
  let current = resolvedRoot;
  const parentRel = relative(resolvedRoot, dirname(absolute));
  for (const part of parentRel ? parentRel.split(sep) : []) {
    current = resolve(current, part);
    const stat = tryLstat(current);
    if (stat?.isSymbolicLink()) {
      throw new Error(`Unsafe rewind path through symbolic-link parent: ${path}`);
    }
  }
  return absolute;
}

function splitNul(buffer: Buffer): string[] {
  if (buffer.length === 0) return [];
  return buffer.toString('utf-8').split('\0').filter(Boolean);
}

function cloneSnapshot(snapshot: AgentRuntimeSnapshot): AgentRuntimeSnapshot {
  return {
    providerId: snapshot.providerId,
    protocol: snapshot.protocol,
    model: snapshot.model,
    effort: snapshot.effort,
    role: snapshot.role,
    messages: cloneJson(snapshot.messages),
    usageHistory: cloneJson(snapshot.usageHistory),
    lastUsage: cloneJson(snapshot.lastUsage),
    subagentUsageHistory: cloneJson(snapshot.subagentUsageHistory),
  };
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function userMessageIndexes(messages: unknown[]): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || !('role' in message) || message.role !== 'user') continue;
    const text = comparableMessageText(message);
    if (text.startsWith(micaContext.COMPACT_BOUNDARY_PREFIX) || text.startsWith(micaContext.COMPACT_SUMMARY_PREFIX)) {
      continue;
    }
    indexes.push(index);
  }
  return indexes;
}

function visibleUserTurnBoundaries(
  providerMessages: unknown[],
  uiMessages: unknown[],
): Array<{ messageIndex: number; uiMessageIndex?: number }> {
  const providerUserIndexes = userMessageIndexes(providerMessages);
  const uiUserIndexes = userMessageIndexes(uiMessages);
  if (uiUserIndexes.length === 0) return providerUserIndexes.map((messageIndex) => ({ messageIndex }));

  const reversed: Array<{ messageIndex: number; uiMessageIndex: number }> = [];
  let uiCursor = uiUserIndexes.length - 1;
  for (let providerCursor = providerUserIndexes.length - 1; providerCursor >= 0 && uiCursor >= 0; providerCursor--) {
    const messageIndex = providerUserIndexes[providerCursor]!;
    const providerText = comparableMessageText(providerMessages[messageIndex]);
    let matchedUiCursor = -1;
    for (let candidate = uiCursor; candidate >= 0; candidate--) {
      const uiMessageIndex = uiUserIndexes[candidate]!;
      if (comparableMessageText(uiMessages[uiMessageIndex]) === providerText) {
        matchedUiCursor = candidate;
        break;
      }
    }
    if (matchedUiCursor === -1) continue;
    reversed.push({ messageIndex, uiMessageIndex: uiUserIndexes[matchedUiCursor]! });
    uiCursor = matchedUiCursor - 1;
  }
  return reversed.reverse();
}

function comparableMessageText(message: unknown): string {
  return messageText(message).replace(/\s+/g, ' ').trim();
}

function usageBeforeMessage(
  protocol: AgentRuntimeSnapshot['protocol'],
  usageHistory: AgentRuntimeSnapshot['usageHistory'],
  messageIndex: number,
): AgentRuntimeSnapshot['usageHistory'] {
  const messageCountLimit = protocol === 'openai_chat_completions' ? messageIndex + 1 : messageIndex;
  return usageHistory.filter((usage) => usage.messageCount <= messageCountLimit);
}

function displayMessageText(message: unknown): string {
  if (!message || typeof message !== 'object' || !('displayContent' in message)) return '';
  return contentText(message.displayContent);
}

function messageText(message: unknown): string {
  if (!message || typeof message !== 'object' || !('content' in message)) return '';
  return contentText(message.content);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if ('text' in part && typeof part.text === 'string') return part.text;
      if ('type' in part && typeof part.type === 'string' && part.type.includes('image')) return '[Image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function estimateJsonLikeChars(value: unknown, maxChars: number): number {
  const seen = new WeakSet<object>();
  let total = 0;

  function walk(current: unknown): void {
    if (total > maxChars) return;
    if (current === null || current === undefined) {
      total += 4;
      return;
    }
    if (typeof current === 'string') {
      total += current.length;
      return;
    }
    if (typeof current === 'number' || typeof current === 'boolean') {
      total += 8;
      return;
    }
    if (typeof current !== 'object') {
      total += String(current).length;
      return;
    }
    if (seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      total += 2;
      for (const item of current) walk(item);
      return;
    }
    total += 2;
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      total += key.length + 4;
      walk(item);
    }
  }

  walk(value);
  return total;
}

function labelForInput(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '(empty input)';
  return oneLine.length > MAX_LABEL_CHARS ? `${oneLine.slice(0, MAX_LABEL_CHARS - 3)}...` : oneLine;
}
