import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * 记忆的存储层：三块按字符预算约束的 markdown 文件。
 *
 * 形态刻意做得和 Hermes 一致——`USER.md` / `MEMORY.md` 是人和模型都能直接读写的
 * 纯文本，一条记忆就是一个自然段，空行分隔。没有数据库、没有向量索引、没有后台
 * 迁移：用户在编辑器里删掉一段，下一轮就真的少一条。
 *
 * 预算（字符数）不是可选的礼貌提示，而是整个设计的前提：注入 system prompt 的内容
 * 必须在每个请求里都付一次 token，所以写满之后必须先整理再写，而不是无限追加。
 */

export const MEMORY_DIR_NAME = 'memory';

export type MemoryTarget = 'user' | 'memory' | 'project';

export const MEMORY_TARGETS: readonly MemoryTarget[] = ['user', 'memory', 'project'] as const;

export type MemoryBudgets = Record<MemoryTarget, number>;

/** 默认预算沿用 Hermes 的量级：用户档案约 500 tokens，笔记约 800 tokens。 */
export const DEFAULT_MEMORY_BUDGETS: MemoryBudgets = {
  user: 1375,
  memory: 2200,
  project: 2200,
};

/** 单条记忆的上限：一条占满全部预算时，整理器就没法只删掉一部分了。 */
export const MAX_ENTRY_CHARS = 1000;

/** 一次工具调用的操作上限，避免模型用一条调用重写整个仓库。 */
export const MAX_OPERATIONS = 10;

export type MemoryOperation =
  | { action: 'add'; content: string }
  | { action: 'patch'; old_text: string; content: string }
  | { action: 'remove'; old_text: string };

export type MemoryStoreSnapshot = {
  target: MemoryTarget;
  /** 文件路径（绝对）。 */
  path: string;
  /** 给人看的相对路径，例如 `memory/USER.md`。 */
  label: string;
  entries: string[];
  chars: number;
  limit: number;
  /** project store 对应的目录；其它 store 为 null。 */
  projectDir: string | null;
};

export type MemoryRejection = {
  kind: 'not-found' | 'ambiguous' | 'rejected' | 'budget' | 'unavailable';
  message: string;
  /** 候选条目（not-found / ambiguous 时给出，方便模型改写 old_text）。 */
  candidates?: string[];
  /** 还差多少字符（budget 时给出）。 */
  overflow?: number;
  /** 操作失败时的当前状态（budget 时给出全文，模型据此决定删哪条）。 */
  store?: MemoryStoreSnapshot;
};

export type MemoryApplyResult =
  | { ok: true; store: MemoryStoreSnapshot; applied: string[] }
  | { ok: false; error: MemoryRejection };

export type MemoryRepositoryOptions = {
  /** `$MICA_HOME/memory`。 */
  rootDir: string;
  budgets?: MemoryBudgets;
  /** 每次读取预算时重新求值；设置页改完立刻生效，不需要重开会话。 */
  resolveBudgets?: () => MemoryBudgets;
  /**
   * 当前会话的工作目录。每次调用都会重新求值：会话可以 `/cd`，
   * 项目记忆应该跟着走。
   */
  resolveProjectDir?: () => string | null | undefined;
};

export type MemoryRuntimeState = {
  /** 上一次整理尝试（成功或失败）的时间，节流的基线。 */
  lastRunAt: string | null;
  lastMode: 'subagent' | 'direct' | null;
  /** 上一次尝试应用的操作数；失败时为 0。 */
  lastApplied: number;
  lastError: string | null;
};

export const EMPTY_MEMORY_STATE: MemoryRuntimeState = {
  lastRunAt: null,
  lastMode: null,
  lastApplied: 0,
  lastError: null,
};

export class MemoryRepository {
  private readonly rootDir: string;
  private readonly budgets: MemoryBudgets;
  private readonly resolveBudgets?: () => MemoryBudgets;
  private readonly resolveProjectDir?: () => string | null | undefined;

  constructor(options: MemoryRepositoryOptions) {
    this.rootDir = resolve(options.rootDir);
    this.budgets = options.budgets ?? DEFAULT_MEMORY_BUDGETS;
    this.resolveBudgets = options.resolveBudgets;
    this.resolveProjectDir = options.resolveProjectDir;
  }

  get root(): string {
    return this.rootDir;
  }

  /** 当前会话的项目目录；没有则项目记忆不可用。 */
  projectDir(): string | null {
    const dir = this.resolveProjectDir?.();
    const trimmed = typeof dir === 'string' ? dir.trim() : '';
    return trimmed ? resolve(trimmed) : null;
  }

  pathFor(target: MemoryTarget): string | null {
    switch (target) {
      case 'user':
        return join(this.rootDir, 'USER.md');
      case 'memory':
        return join(this.rootDir, 'MEMORY.md');
      case 'project': {
        const dir = this.projectDir();
        return dir ? join(this.rootDir, 'projects', projectSlug(dir), 'MEMORY.md') : null;
      }
    }
  }

  labelFor(target: MemoryTarget): string {
    const path = this.pathFor(target);
    if (!path) return `${MEMORY_DIR_NAME}/projects/<unavailable>/MEMORY.md`;
    const relative = path.slice(this.rootDir.length + 1);
    return `${MEMORY_DIR_NAME}/${relative}`;
  }

  limitFor(target: MemoryTarget): number {
    return (this.resolveBudgets?.() ?? this.budgets)[target];
  }

  read(target: MemoryTarget): string[] {
    const path = this.pathFor(target);
    if (!path) return [];
    try {
      return splitEntries(readFileSync(path, 'utf-8'));
    } catch (error) {
      if (isMissingFile(error)) return [];
      // 读不出来不能当成空：apply 会接着把「空 + 新条目」写回去，等于抹掉用户已有记忆。
      throw error;
    }
  }

  /** 展示用读取：坏文件或权限问题当作空，不让渲染和状态查询挂掉。 */
  tryRead(target: MemoryTarget): string[] {
    try {
      return this.read(target);
    } catch {
      return [];
    }
  }

  snapshot(target: MemoryTarget): MemoryStoreSnapshot {
    return this.snapshotFrom(target, this.tryRead(target));
  }

  /** 三块里能用的那些（没有项目目录时跳过 project）。 */
  snapshots(): MemoryStoreSnapshot[] {
    return MEMORY_TARGETS.filter((target) => this.pathFor(target) !== null).map((target) => this.snapshot(target));
  }

  /**
   * 整批应用：要么全部生效，要么一行都不写。
   *
   * 原子性不是为了好看——模型会一次提交「删掉两条旧的、加上一条新的」来腾预算，
   * 如果按顺序写盘，预算检查失败时前两条已经被删了，用户就白丢了两条记忆。
   */
  apply(target: MemoryTarget, operations: MemoryOperation[]): MemoryApplyResult {
    const path = this.pathFor(target);
    if (!path) {
      return {
        ok: false,
        error: { kind: 'unavailable', message: 'project memory is unavailable: no working directory' },
      };
    }
    if (operations.length > MAX_OPERATIONS) {
      return {
        ok: false,
        error: {
          kind: 'rejected',
          message: `too many operations in one call (${operations.length} > ${MAX_OPERATIONS}); split them`,
        },
      };
    }

    let entries: string[];
    try {
      entries = [...this.read(target)];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: {
          kind: 'unavailable',
          message: `cannot read ${this.labelFor(target)} (${message}); refusing to overwrite it`,
        },
      };
    }
    const applied: string[] = [];

    for (const operation of operations) {
      const result = applyOperation(entries, operation);
      if (!result.ok) {
        return {
          ok: false,
          error: {
            ...result.error,
            store: this.snapshotFrom(target, entries),
          },
        };
      }
      if (result.summary) applied.push(result.summary);
    }

    const limit = this.limitFor(target);
    const chars = joinEntries(entries).length;
    if (chars > limit) {
      return {
        ok: false,
        error: {
          kind: 'budget',
          message: `memory store '${target}' would be ${chars} characters, over the ${limit} limit`,
          overflow: chars - limit,
          store: this.snapshotFrom(target, entries),
        },
      };
    }

    this.write(path, entries);
    return { ok: true, store: this.snapshotFrom(target, entries), applied };
  }

  readState(): MemoryRuntimeState {
    const path = join(this.rootDir, 'state.json');
    if (!existsSync(path)) return { ...EMPTY_MEMORY_STATE };
    try {
      return normalizeRuntimeState(JSON.parse(readFileSync(path, 'utf-8')));
    } catch {
      return { ...EMPTY_MEMORY_STATE };
    }
  }

  writeState(state: MemoryRuntimeState): void {
    this.writeText(join(this.rootDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  }

  private snapshotFrom(target: MemoryTarget, entries: string[]): MemoryStoreSnapshot {
    const path = this.pathFor(target);
    return {
      target,
      path: path ?? '',
      label: this.labelFor(target),
      entries,
      chars: joinEntries(entries).length,
      limit: this.limitFor(target),
      projectDir: target === 'project' ? this.projectDir() : null,
    };
  }

  private write(path: string, entries: string[]): void {
    this.writeText(path, `${joinEntries(entries)}\n`.replace(/^\n$/, ''));
  }

  /**
   * 临时文件 + rename：进程被杀也不会留下半截文件。
   *
   * 权限给到 0600 / 0700——记忆里可能有人名、团队约定这类不该被同机其他用户读到的东西，
   * 而默认的 0644 在共享机器上是可读的。
   */
  private writeText(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, text, { encoding: 'utf-8', mode: 0o600 });
    renameSync(temp, path);
  }
}

export type OperationOutcome = { ok: true; summary: string } | { ok: false; error: MemoryRejection };

export function applyOperation(entries: string[], operation: MemoryOperation): OperationOutcome {
  switch (operation.action) {
    case 'add':
      return applyAdd(entries, operation.content);
    case 'patch':
      return applyPatch(entries, operation.old_text, operation.content);
    case 'remove':
      return applyRemove(entries, operation.old_text);
  }
}

function applyAdd(entries: string[], content: string): OperationOutcome {
  const issue = scanEntry(content);
  if (issue) return { ok: false, error: { kind: 'rejected', message: issue } };

  const additions = splitEntries(content);
  if (additions.length === 0) {
    return { ok: false, error: { kind: 'rejected', message: 'add requires non-empty content' } };
  }
  if (additions.some((entry) => entry.length > MAX_ENTRY_CHARS)) {
    return {
      ok: false,
      error: { kind: 'rejected', message: `each entry must be at most ${MAX_ENTRY_CHARS} characters` },
    };
  }

  const existing = new Set(entries.map(entryKey));
  const fresh: string[] = [];
  for (const entry of additions) {
    const key = entryKey(entry);
    if (existing.has(key)) continue;
    existing.add(key);
    fresh.push(entry);
  }
  if (fresh.length === 0) return { ok: true, summary: 'duplicate ignored' };
  entries.push(...fresh);
  return { ok: true, summary: fresh.length === 1 ? 'added 1 entry' : `added ${fresh.length} entries` };
}

function applyPatch(entries: string[], oldText: string, content: string): OperationOutcome {
  const issue = scanEntry(content);
  if (issue) return { ok: false, error: { kind: 'rejected', message: issue } };
  if (!normalizeEntry(content)) {
    return { ok: false, error: { kind: 'rejected', message: 'patch requires non-empty content' } };
  }

  const located = locateEntry(entries, oldText);
  if (!located.ok) return located;

  const original = entries[located.index] ?? '';
  const needle = normalizeInline(oldText);
  if (!needle) return { ok: false, error: { kind: 'rejected', message: 'patch requires old_text' } };

  let next: string;
  if (normalizeInline(original) === needle) {
    // 整条替换：保留 content 的行结构，这是唯一能变成多行条目的入口。
    next = normalizeEntry(content);
  } else {
    // 片段替换：必须逐字命中原文，否则替换位置只能靠猜。模型一般会复制原文，
    // 真复制错了就明确让它重来，比默默改错一条记忆便宜。
    const occurrences = countOccurrences(original, oldText);
    if (occurrences === 0) {
      return {
        ok: false,
        error: {
          kind: 'rejected',
          message:
            'old_text is not a verbatim substring of the matched entry; pass an exact excerpt or the whole entry',
          candidates: [original],
        },
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        error: {
          kind: 'ambiguous',
          message: `old_text appears ${occurrences} times in the matched entry; include more surrounding text`,
          candidates: [original],
        },
      };
    }
    // 片段替换后条目内不能出现空行，否则一条记忆会裂成两条。
    // 用函数式替换：字符串替换会把内容里的 `$&` / `$1` 当成替换模式，
    // 写入 `$&` 这类正文（价格、shell 变量）时会插进被替换的原文。
    const replacement = normalizeInline(content);
    next = original.replace(oldText, () => replacement);
  }

  if (next.length > MAX_ENTRY_CHARS) {
    return {
      ok: false,
      error: { kind: 'rejected', message: `entry would be ${next.length} characters, over ${MAX_ENTRY_CHARS}` },
    };
  }
  entries[located.index] = normalizeEntry(next);
  return { ok: true, summary: 'patched 1 entry' };
}

function applyRemove(entries: string[], oldText: string): OperationOutcome {
  const located = locateEntry(entries, oldText);
  if (!located.ok) return located;
  entries.splice(located.index, 1);
  return { ok: true, summary: 'removed 1 entry' };
}

type LocateResult = { ok: true; index: number } | { ok: false; error: MemoryRejection };

/**
 * 定位一条记忆：整条精确匹配优先，否则用唯一子串匹配。
 *
 * 只给唯一子串是为了让模型不必复述整条记忆（那条往往很长），但多个命中时必须
 * 报错而不是「猜一个」——删错记忆比不删难发现得多。
 */
export function locateEntry(entries: string[], oldText: string): LocateResult {
  const needle = normalizeInline(oldText);
  if (!needle) {
    return { ok: false, error: { kind: 'rejected', message: 'old_text is required' } };
  }

  const exact = entries.findIndex((entry) => normalizeInline(entry) === needle);
  if (exact >= 0) return { ok: true, index: exact };

  const matches = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => normalizeInline(entry).includes(needle));

  if (matches.length === 1) return { ok: true, index: matches[0]!.index };
  if (matches.length > 1) {
    return {
      ok: false,
      error: {
        kind: 'ambiguous',
        message: `old_text matches ${matches.length} entries; use a longer unique substring`,
        candidates: matches.map(({ entry }) => entry),
      },
    };
  }

  return {
    ok: false,
    error: {
      kind: 'not-found',
      message: 'no entry contains old_text',
      candidates: entries.slice(0, 20),
    },
  };
}

/**
 * 记忆会原样进 system prompt，所以写入前扫一遍明显不该进来的东西。
 *
 * 这里刻意只拦高置信度的模式：正常的技术笔记里「system prompt」「忽略」这类词
 * 都可能出现，规则太宽会让模型反复改写一句话也存不进去。
 */
export function scanEntry(text: string): string | null {
  if (/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/.test(text)) {
    return 'entry contains invisible or bidirectional formatting characters; remove them and retry';
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    return 'entry looks like a private key; never store secrets in memory';
  }
  if (/\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/.test(text)) {
    return 'entry looks like a credential; store where the secret lives, not the secret itself';
  }
  if (
    /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?)\b/i.test(
      text,
    ) ||
    /忽略(之前|以上|上述|前面)(的)?(指令|规则|提示)/.test(text)
  ) {
    return 'entry looks like a prompt-injection instruction; memory is data, not instructions';
  }
  return null;
}

export function splitEntries(raw: string): string[] {
  if (!raw) return [];
  return raw
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((entry) => normalizeEntry(entry))
    .filter((entry) => entry.length > 0);
}

export function joinEntries(entries: string[]): string {
  return entries
    .map((entry) => normalizeEntry(entry))
    .filter((entry) => entry.length > 0)
    .join('\n\n');
}

export function normalizeEntry(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function entryKey(text: string): string {
  return normalizeInline(text).toLowerCase();
}

function countOccurrences(haystack: string, needle: string): number {
  let index = 0;
  let count = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) return count;
    count += 1;
    index = found + needle.length;
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

/** 项目目录 → 稳定、可读、不会撞名的目录名。 */
export function projectSlug(dir: string): string {
  // 先解开符号链接：同一个仓库经 `/var/...` 和 `/private/var/...`（macOS）、
  // 或经软链路径进入时，`process.cwd()` 给出的形态并不总是同一个，
  // 不归一化就会为同一个工作区开出两份项目记忆。
  const normalized = safeRealpath(resolve(dir)).replace(/\\/g, '/').replace(/\/+$/, '');
  const name =
    basename(normalized)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project';
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

/** 目录还不存在时（例如刚 `/cd` 到一个待建目录）退回 `resolve` 的结果。 */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** 损坏的运行状态当作没跑过：多整理一次比永久停摆好。 */
export function normalizeRuntimeState(input: unknown): MemoryRuntimeState {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    lastRunAt: typeof source.lastRunAt === 'string' && source.lastRunAt ? source.lastRunAt : null,
    lastMode: source.lastMode === 'subagent' || source.lastMode === 'direct' ? source.lastMode : null,
    lastApplied: typeof source.lastApplied === 'number' && Number.isFinite(source.lastApplied) ? source.lastApplied : 0,
    lastError: typeof source.lastError === 'string' && source.lastError ? source.lastError : null,
  };
}
