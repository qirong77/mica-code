import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import { resolvePathRepoIdentity } from './repo.js';
import {
  MAX_OPERATIONS,
  entryText,
  isPinned,
  type MemoryOperation,
  type MemoryRejection,
  type MemoryRepository,
  type MemoryStoreSnapshot,
} from './store.js';
import type { MemoryContext, MemoryScope } from './scope.js';

const TOOL_NAME = 'memory';

const MAX_CANDIDATES = 10;
const MAX_CANDIDATE_CHARS = 240;

const SCOPE_KINDS = ['profile', 'project', 'domain'] as const;
export type MemoryToolScope = (typeof SCOPE_KINDS)[number];

export type ParsedMemoryInput =
  | { ok: true; scope: MemoryScope; operations: MemoryOperation[] }
  | { ok: false; message: string };

/**
 * `memory` 工具：把跨会话该记住的事实写进对应作用域。
 *
 * 它负责协议，不负责存储策略——去重、字符上限、安全扫描、唯一匹配都在
 * `MemoryRepository.apply` 里，工具只是把失败原因翻译成模型能照着改的一段话。
 *
 * 与旧版的关键差别是**必须选作用域，且默认最窄**：省略 `scope` 就是当前仓库，
 * 想写全局必须先证明这条事实真的与仓库无关。这个默认值决定了「一个需求里挖出来的
 * 东西」不会漏进之后所有会话。
 */
export class MemoryTool extends MicaTool {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly context: () => MemoryContext,
    private readonly enabled: () => boolean = () => true,
  ) {
    super(
      TOOL_NAME,
      [
        'Manage persistent memory: facts that must survive across sessions and are injected into the system prompt when they apply.',
        'Memory is split by scope, and you must pick the narrowest one that holds:',
        '`project` (default) = facts about this repository — layout, commands, test setup, architecture decisions and their reasons, non-obvious pitfalls;',
        '`domain` = facts shared by a group of related repositories (same backend / same app suite / same internal system); requires `domain` and the group must already exist;',
        '`profile` = stable facts about the user themselves (name, language, communication preferences). Do NOT put project rules, workflows or conventions here.',
        'Before writing, apply three tests — if any fails, do not write:',
        '(1) will it still matter in an unrelated task three months from now? (2) does it read correctly with no reference to this conversation? (3) is it a fact rather than a rule?',
        'Rules — "always reuse component X", "run Y after changing Z", "never do W" — belong to role files, AGENTS.md or project conventions, NOT memory.',
        'Do not store: secrets, one-off paths and debugging context, task progress or TODOs, anything obvious from the code, anything already in AGENTS.md.',
        'Each memory is one short paragraph (separate memories with a blank line). Most sessions end with nothing worth saving — an empty call is a correct outcome.',
        'Prefix an entry with `! ` to pin it: pinned entries are injected first and survive budget pressure.',
        'Omit `operations` to read the current entries and usage.',
        'Patches use a unique substring (`old_text`); if it matches more than one entry the call fails and lists candidates, so pass a longer excerpt or the whole entry.',
        'Scope `project` defaults to the repository this task is actually working in (the code you are editing), not the shell directory. When the session was opened in one repository but the work belongs to another, pass `repo` with a path inside the target repository.',
      ].join(' '),
      {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: [...SCOPE_KINDS],
            description:
              'Which memory scope to read or write. Omit for `project` (the repository this task is working in). `domain` also needs `domain`.',
          },
          repo: {
            type: 'string',
            description:
              'scope=project: a path inside the repository the fact belongs to. Defaults to the repository this task is working in. Pass it when the work targets a different repository than the session directory.',
          },
          domain: {
            type: 'string',
            description: 'scope=domain: which domain group. Call without operations first to list the available names.',
          },
          operations: {
            type: 'array',
            description: `Operations applied atomically (max ${MAX_OPERATIONS}). Omit to read the store.`,
            items: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['add', 'patch', 'remove'],
                  description: 'add a new entry, patch a span of an existing entry, or remove an entry.',
                },
                old_text: {
                  type: 'string',
                  description: 'patch / remove: a unique substring of the target entry. The whole entry also works.',
                },
                content: {
                  type: 'string',
                  description: 'add: the new entry. patch: replacement text for the matched span.',
                },
                pin: {
                  type: 'boolean',
                  description: 'add: keep this entry injected even when the budget is tight.',
                },
              },
              required: ['action'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      { readOnly: false },
    );
  }

  override validateInput(input: unknown) {
    const base = super.validateInput(input);
    if (!base.valid) return base;
    const parsed = parseMemoryToolInput(input, this.context());
    return parsed.ok ? { valid: true } : { valid: false, message: parsed.message };
  }

  async execute(input: ToolInput, _callbacks?: ToolExecuteCallbacks): Promise<string> {
    if (!this.enabled()) throw new Error('Memory is disabled in plugin settings.');
    const parsed = parseMemoryToolInput(input, this.context());
    if (!parsed.ok) throw new Error(parsed.message);

    const { scope, operations } = parsed;
    if (operations.length === 0) return describeScope(this.repository, scope, this.context());

    const result = this.repository.apply(scope, operations);
    if (!result.ok) throw new Error(formatRejection(result.error));

    const usage = `${result.store.entries.length} entries · ${result.store.chars}/${result.store.budget} characters`;
    const lines = [
      `Memory updated (${result.store.title}): ${result.applied.join('; ') || 'no changes'}.`,
      `Usage: ${usage}. Saved to ${result.store.label}.`,
    ];
    if (result.store.chars > result.store.budget) {
      lines.push(
        `This scope is over its injection budget: only part of it reaches the system prompt. Consolidate it (merge similar entries, remove stale ones) when convenient.`,
      );
    }
    lines.push(
      'The system prompt of this session keeps the snapshot it loaded at session start; the next session reads this file immediately. Ask the user to run /memory refresh if it must be reloaded now.',
    );
    return lines.join('\n');
  }

  onToolUseDisplayText(input: ToolInput): string {
    const scope = typeof input.scope === 'string' ? input.scope : 'project';
    const domain = typeof input.domain === 'string' ? `:${input.domain}` : '';
    const operations = Array.isArray(input.operations) ? input.operations : [];
    if (operations.length === 0) return `Reviewing memory (${scope}${domain})`;
    const actions = operations
      .map((operation) =>
        operation && typeof operation === 'object' ? String((operation as Record<string, unknown>).action ?? '') : '',
      )
      .filter(Boolean);
    return `Saving memory (${scope}${domain}, ${actions.join(', ')})`;
  }
}

export function parseMemoryToolInput(input: unknown, context: MemoryContext): ParsedMemoryInput {
  if (!isRecord(input)) return { ok: false, message: 'input must be an object' };

  const unknownKey = Object.keys(input).find(
    (key) => key !== 'scope' && key !== 'repo' && key !== 'domain' && key !== 'operations',
  );
  if (unknownKey) return { ok: false, message: `unknown input field: ${unknownKey}` };

  const requested = input.scope;
  if (
    requested !== undefined &&
    (typeof requested !== 'string' || !SCOPE_KINDS.includes(requested as MemoryToolScope))
  ) {
    return { ok: false, message: `scope must be one of ${SCOPE_KINDS.join(', ')}` };
  }
  const kind = (requested as MemoryToolScope | undefined) ?? 'project';

  const resolved = resolveScope(
    kind,
    typeof input.domain === 'string' ? input.domain : undefined,
    typeof input.repo === 'string' ? input.repo : undefined,
    context,
  );
  if (!resolved.ok) return { ok: false, message: resolved.message };

  if (input.operations === undefined) return { ok: true, scope: resolved.scope, operations: [] };
  if (!Array.isArray(input.operations)) return { ok: false, message: 'operations must be an array' };
  if (input.operations.length > MAX_OPERATIONS) {
    return { ok: false, message: `operations must contain at most ${MAX_OPERATIONS} items` };
  }

  const operations: MemoryOperation[] = [];
  for (const [index, raw] of input.operations.entries()) {
    if (!isRecord(raw)) return { ok: false, message: `operations[${index}] must be an object` };
    const extra = Object.keys(raw).find(
      (key) => key !== 'action' && key !== 'old_text' && key !== 'content' && key !== 'pin',
    );
    if (extra) return { ok: false, message: `operations[${index}] has unknown field: ${extra}` };

    if (raw.action === 'add') {
      if (typeof raw.content !== 'string' || !raw.content.trim()) {
        return { ok: false, message: `operations[${index}].content must be a non-empty string for add` };
      }
      operations.push({ action: 'add', content: raw.content, ...(raw.pin === true ? { pin: true } : {}) });
      continue;
    }
    if (raw.action === 'patch') {
      if (typeof raw.old_text !== 'string' || !raw.old_text.trim()) {
        return { ok: false, message: `operations[${index}].old_text is required for patch` };
      }
      if (typeof raw.content !== 'string' || !raw.content.trim()) {
        return { ok: false, message: `operations[${index}].content must be a non-empty string for patch` };
      }
      operations.push({ action: 'patch', old_text: raw.old_text, content: raw.content });
      continue;
    }
    if (raw.action === 'remove') {
      if (typeof raw.old_text !== 'string' || !raw.old_text.trim()) {
        return { ok: false, message: `operations[${index}].old_text is required for remove` };
      }
      operations.push({ action: 'remove', old_text: raw.old_text });
      continue;
    }
    return { ok: false, message: `operations[${index}].action must be add, patch, or remove` };
  }

  return { ok: true, scope: resolved.scope, operations };
}

function resolveScope(
  kind: MemoryToolScope,
  domainName: string | undefined,
  repoPath: string | undefined,
  context: MemoryContext,
): { ok: true; scope: MemoryScope } | { ok: false; message: string } {
  if (kind === 'profile') return { ok: true, scope: { kind: 'profile' } };

  if (kind === 'project') {
    const requestedPath = (repoPath ?? '').trim();
    if (requestedPath) {
      const identity = resolvePathRepoIdentity(requestedPath);
      if (!identity) {
        return {
          ok: false,
          message: `'${requestedPath}' is not inside a recognizable repository. Pass a path inside the repository the fact belongs to (any path in it works, including a file that does not exist yet).`,
        };
      }
      return {
        ok: true,
        scope: {
          kind: 'project',
          repo: identity,
          ...(identity.slug === context.repo?.slug ? {} : { note: '本次任务目标' }),
        },
      };
    }
    if (!context.project) {
      return {
        ok: false,
        message:
          'no repository in the current working directory, so there is no default project scope. Pass `repo` with a path inside the repository this fact belongs to, use scope=domain with an existing domain, or scope=profile for facts about the user themselves.',
      };
    }
    return { ok: true, scope: context.project };
  }

  const name = (domainName ?? '').trim();
  const names = context.knownDomains.map((domain) => domain.name);
  if (!name) {
    return {
      ok: false,
      message:
        names.length > 0
          ? `scope=domain requires a domain name; available: ${names.join(', ')}. Leave scope out to write to the current project instead.`
          : 'scope=domain requires a domain name, and no domains are defined yet. Domains are created by the user with /memory domain new <name>. Use scope=project instead.',
    };
  }
  const domain = context.knownDomains.find((candidate) => candidate.name === name);
  if (!domain) {
    return {
      ok: false,
      message:
        names.length > 0
          ? `unknown domain '${name}'; available: ${names.join(', ')}`
          : `unknown domain '${name}'; no domains are defined yet (the user creates them with /memory domain new <name>)`,
    };
  }
  // 领域可以写，但只在它覆盖当前会话时才有意义：否则这条事实下次也注入不到这里。
  const inContext = context.domains.some((candidate) => candidate.name === name);
  if (!inContext) {
    return {
      ok: false,
      message: `domain '${name}' does not cover the current working directory (${context.cwd ?? 'unknown'}); it would never be injected here. Write to scope=project instead, or ask the user to add this directory to that domain.`,
    };
  }
  return { ok: true, scope: { kind: 'domain', domain } };
}

function describeScope(repository: MemoryRepository, scope: MemoryScope, context: MemoryContext): string {
  const snapshot = repository.snapshot(scope);
  const header = `${snapshot.title} · ${snapshot.entries.length} entries · ${snapshot.chars}/${snapshot.budget} characters · ${snapshot.label}`;
  const lines = [header];
  if (snapshot.entries.length === 0) {
    lines.push('(empty)');
  } else {
    lines.push('', ...snapshot.entries.map((entry, index) => `${index + 1}. ${formatEntry(entry)}`));
  }
  if (scope.kind === 'profile') {
    lines.push('', 'Reminder: profile is for facts about the user themselves; project rules belong elsewhere.');
  }
  if (scope.kind === 'project' && context.domains.length > 0) {
    lines.push(
      '',
      `Domains covering this directory: ${context.domains.map((domain) => domain.name).join(', ')} (use scope=domain to read or write one).`,
    );
  }
  return lines.join('\n');
}

function formatEntry(entry: string): string {
  return `${isPinned(entry) ? '[pinned] ' : ''}${entryText(entry)}`;
}

function formatRejection(error: MemoryRejection): string {
  const lines = [`memory write rejected: ${error.message}`];
  if (error.overflow !== undefined) {
    lines.push(
      `Free at least ${error.overflow} characters by removing or shortening entries, then retry the same batch.`,
    );
  }
  if (error.candidates?.length) {
    lines.push('', 'Candidates:', ...error.candidates.slice(0, MAX_CANDIDATES).map((entry) => `- ${truncate(entry)}`));
  }
  if (error.store && error.store.entries.length > 0) {
    lines.push(
      '',
      `Current entries of ${error.store.title} (${error.store.chars}/${error.store.budget} chars):`,
      ...error.store.entries.map((entry, index) => `${index + 1}. ${truncate(entry)}`),
    );
  }
  return lines.join('\n');
}

function truncate(text: string): string {
  return text.length <= MAX_CANDIDATE_CHARS ? text : `${text.slice(0, MAX_CANDIDATE_CHARS - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function summarizeSnapshot(snapshot: MemoryStoreSnapshot): string {
  return `${snapshot.title}: ${snapshot.entries.length} 条 · ${snapshot.chars}/${snapshot.budget} 字符 · ${snapshot.label}`;
}
