import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { acquireMemoryLock } from './locking.js';
import { scopeFile, scopeKey, scopeLabel, scopeTitle, type MemoryScope } from './scope.js';

/**
 * 记忆的存储层。
 *
 * 每个作用域一个 markdown 文件，一条记忆就是一个自然段，空行分隔——用户可以直接在
 * 编辑器里读、改、删，不需要界面。文件里没有元数据、没有数据库、没有向量索引。
 *
 * **存储与注入是解耦的**：文件里可以放多少条不受限制（只有 20000 字符的失控保护），
 * 注入按各层的预算挑选。旧设计把「预算」同时当写入硬限制，结果是三块全写满之后
 * 写入永远失败，模型只能 `patch` 覆盖它读不懂的旧条目，把记忆改得千奇百怪。
 *
 * 条目前缀 `! ` 表示 pin：注入时优先保留，预算紧张也不会被挤掉。
 */

export const MEMORY_DIR_NAME = 'memory';

export type MemoryBudgetKey = 'profile' | 'project' | 'domain';

export type MemoryBudgets = Record<MemoryBudgetKey, number>;

/**
 * 注入预算：每个请求都要为它付一次 token，所以按作用域分别给额度。
 * 真实用法里绝大多数会话只有 profile 这一层有内容，约 300 tokens。
 */
export const DEFAULT_MEMORY_BUDGETS: MemoryBudgets = {
  profile: 1600,
  project: 2400,
  domain: 2400,
};

/** 单条记忆的上限：一条占满全部预算时，整理器就没法只删掉一部分了。 */
export const MAX_ENTRY_CHARS = 1000;

/**
 * 单层字符数的失控保护。它不是「预算」——超出注入预算不会写不进去，
 * 但一层长到几十 KB 说明没人管，宁可失败也不要让它继续在提示词里滚雪球。
 */
export const MAX_STORE_CHARS = 20_000;

/** 一次工具调用的操作上限，避免模型用一条调用重写整个仓库。 */
export const MAX_OPERATIONS = 10;

export type MemoryOperation =
  | { action: 'add'; content: string; pin?: boolean }
  | { action: 'patch'; old_text: string; content: string }
  | { action: 'remove'; old_text: string };

export type MemoryStoreSnapshot = {
  scope: MemoryScope;
  /** 稳定的作用域键，缓存与 UI 用它。 */
  key: string;
  /** 段落标题：`用户档案` / `项目记忆 · mica-code` / `领域记忆 · 租车`。 */
  title: string;
  /** 文件路径（绝对）。 */
  path: string;
  /** 给人看的相对路径，例如 `PROFILE.md`、`projects/mica-code-12de4a5d.md`。 */
  label: string;
  entries: string[];
  chars: number;
  /** 注入预算（字符）。 */
  budget: number;
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

/** domain 文件头部的 `match` 不能被写操作吃掉。 */
const FRONTMATTER = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/;

export class MemoryRepository {
  private readonly rootDir: string;
  private readonly budgets: MemoryBudgets;
  private readonly resolveBudgets?: () => MemoryBudgets;

  constructor(options: { rootDir: string; budgets?: MemoryBudgets; resolveBudgets?: () => MemoryBudgets }) {
    this.rootDir = resolve(options.rootDir);
    this.budgets = options.budgets ?? DEFAULT_MEMORY_BUDGETS;
    this.resolveBudgets = options.resolveBudgets;
  }

  get root(): string {
    return this.rootDir;
  }

  acquireCuratorLock(): (() => void) | null {
    return acquireMemoryLock(join(this.rootDir, 'curator.lock'));
  }

  pathFor(scope: MemoryScope): string {
    return scopeFile(this.rootDir, scope);
  }

  labelFor(scope: MemoryScope): string {
    return scopeLabel(this.rootDir, scope);
  }

  budgetFor(scope: MemoryScope): number {
    const budgets = this.resolveBudgets?.() ?? this.budgets;
    return budgets[scope.kind];
  }

  read(scope: MemoryScope): string[] {
    const path = this.pathFor(scope);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (error) {
      if (isMissingFile(error)) return [];
      // 读不出来不能当成空：apply 会接着把「空 + 新条目」写回去，等于抹掉用户已有记忆。
      throw error;
    }
    return splitEntries(stripFrontmatter(raw).body);
  }

  /** 展示用读取：坏文件或权限问题当作空，不让渲染和状态查询挂掉。 */
  tryRead(scope: MemoryScope): string[] {
    try {
      return this.read(scope);
    } catch {
      return [];
    }
  }

  snapshot(scope: MemoryScope): MemoryStoreSnapshot {
    return this.snapshotFrom(scope, this.tryRead(scope));
  }

  snapshots(scopes: MemoryScope[]): MemoryStoreSnapshot[] {
    return scopes.map((scope) => this.snapshot(scope));
  }

  /**
   * 整批应用：要么全部生效，要么一行都不写。
   *
   * 原子性不是为了好看——模型会一次提交「删掉两条旧的、加上一条新的」来腾预算，
   * 如果按顺序写盘，预算检查失败时前两条已经被删了，用户就白丢了两条记忆。
   */
  apply(scope: MemoryScope, operations: MemoryOperation[]): MemoryApplyResult {
    const path = this.pathFor(scope);
    if (operations.length > MAX_OPERATIONS) {
      return {
        ok: false,
        error: {
          kind: 'rejected',
          message: `too many operations in one call (${operations.length} > ${MAX_OPERATIONS}); split them`,
        },
      };
    }

    const release = acquireMemoryLock(`${path}.lock`);
    if (!release) {
      return {
        ok: false,
        error: { kind: 'unavailable', message: `${scopeKey(scope)} is being updated; retry shortly` },
      };
    }
    try {
      return this.applyLocked(scope, path, operations);
    } finally {
      release();
    }
  }

  private applyLocked(scope: MemoryScope, path: string, operations: MemoryOperation[]): MemoryApplyResult {
    let head = '';
    let entries: string[];
    try {
      const raw = existsSync(path) ? readFileSync(path, 'utf-8') : '';
      const parts = stripFrontmatter(raw);
      head = parts.head;
      entries = splitEntries(parts.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: {
          kind: 'unavailable',
          message: `cannot read ${this.labelFor(scope)} (${message}); refusing to overwrite it`,
        },
      };
    }
    const before = [...entries];
    const current = this.snapshotFrom(scope, [...entries]);
    const applied: string[] = [];

    for (const operation of operations) {
      const result = applyOperation(entries, operation);
      if (!result.ok) {
        return { ok: false, error: { ...result.error, store: current } };
      }
      if (result.summary) applied.push(result.summary);
    }

    const chars = joinEntries(entries).length;
    if (chars > MAX_STORE_CHARS) {
      return {
        ok: false,
        error: {
          kind: 'budget',
          message: `${scopeKey(scope)} would be ${chars} characters, over the ${MAX_STORE_CHARS} safety limit; consolidate it first`,
          overflow: chars - MAX_STORE_CHARS,
          store: current,
        },
      };
    }

    const changed = entries.length !== before.length || entries.some((entry, index) => entry !== before[index]);
    if (changed) this.write(path, head, entries);
    return { ok: true, store: this.snapshotFrom(scope, entries), applied };
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

  private snapshotFrom(scope: MemoryScope, entries: string[]): MemoryStoreSnapshot {
    return {
      scope,
      key: scopeKey(scope),
      title: scopeTitle(scope),
      path: this.pathFor(scope),
      label: this.labelFor(scope),
      entries,
      chars: joinEntries(entries).length,
      budget: this.budgetFor(scope),
    };
  }

  private write(path: string, head: string, entries: string[]): void {
    const body = joinEntries(entries);
    const text = head ? `${head}${body ? `\n${body}\n` : ''}` : `${body}\n`.replace(/^\n$/, '');
    this.writeText(path, text);
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
      return applyAdd(entries, operation.content, operation.pin === true);
    case 'patch':
      return applyPatch(entries, operation.old_text, operation.content);
    case 'remove':
      return applyRemove(entries, operation.old_text);
  }
}

/** `! ` 前缀表示 pin：预算紧张时优先保留。 */
export function isPinned(entry: string): boolean {
  return /^!\s/.test(entry);
}

export function entryText(entry: string): string {
  return isPinned(entry) ? entry.replace(/^!\s+/, '') : entry;
}

export function pinEntry(entry: string): string {
  return isPinned(entry) ? entry : `! ${entry}`;
}

function applyAdd(entries: string[], content: string, pin: boolean): OperationOutcome {
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

  const existing = new Set(entries.map((entry) => entryKey(entry)));
  const fresh: string[] = [];
  for (const addition of additions) {
    const key = entryKey(addition);
    if (existing.has(key)) continue;
    existing.add(key);
    fresh.push(pin ? pinEntry(addition) : addition);
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
  const needle = normalizeInline(stripPin(oldText));
  if (!needle) return { ok: false, error: { kind: 'rejected', message: 'patch requires old_text' } };

  let next: string;
  if (normalizeInline(stripPin(original)) === needle) {
    // 整条替换：保留 content 的行结构，这是唯一能变成多行条目的入口。
    next = normalizeEntry(content);
  } else {
    // 片段替换：必须逐字命中原文，否则替换位置只能靠猜。模型一般会复制原文，
    // 真复制错了就明确让它重来，比默默改错一条记忆便宜。
    const body = stripPin(original);
    const occurrences = countOccurrences(body, oldText);
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
    next = body.replace(oldText, () => replacement);
  }

  if (next.length > MAX_ENTRY_CHARS) {
    return {
      ok: false,
      error: { kind: 'rejected', message: `entry would be ${next.length} characters, over ${MAX_ENTRY_CHARS}` },
    };
  }
  // patch 不改变 pin 状态：pin 是用户的意图，不该被一次内容改写顺手抹掉。
  entries[located.index] = isPinned(original) ? pinEntry(normalizeEntry(next)) : normalizeEntry(next);
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
  const needle = normalizeInline(stripPin(oldText));
  if (!needle) {
    return { ok: false, error: { kind: 'rejected', message: 'old_text is required' } };
  }

  const exact = entries.findIndex((entry) => normalizeInline(stripPin(entry)) === needle);
  if (exact >= 0) return { ok: true, index: exact };

  const matches = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => normalizeInline(stripPin(entry)).includes(needle));

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
  return entries.join('\n\n');
}

function stripFrontmatter(raw: string): { head: string; body: string } {
  const match = FRONTMATTER.exec(raw);
  if (!match) return { head: '', body: raw };
  return { head: match[1]!, body: raw.slice(match[0].length) };
}

function stripPin(entry: string): string {
  return entryText(entry);
}

function entryKey(entry: string): string {
  return normalizeInline(entryText(entry)).toLowerCase();
}

/** 内联归一化：只收敛空白，不动正文——正文里的缩进与代码片段是有意义的。 */
function normalizeInline(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function normalizeEntry(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function normalizeRuntimeState(raw: unknown): MemoryRuntimeState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_MEMORY_STATE };
  const record = raw as Record<string, unknown>;
  return {
    lastRunAt: typeof record.lastRunAt === 'string' ? record.lastRunAt : null,
    lastMode: record.lastMode === 'direct' ? 'direct' : record.lastMode === 'subagent' ? 'subagent' : null,
    lastApplied: typeof record.lastApplied === 'number' ? record.lastApplied : 0,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
  };
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT');
}
