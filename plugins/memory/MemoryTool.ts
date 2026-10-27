import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import {
  MAX_OPERATIONS,
  MEMORY_TARGETS,
  type MemoryOperation,
  type MemoryRejection,
  type MemoryRepository,
  type MemoryTarget,
} from './store.js';
const TOOL_NAME = 'memory';

const MAX_CANDIDATES = 10;
const MAX_CANDIDATE_CHARS = 240;

export type ParsedMemoryInput =
  | { ok: true; target: MemoryTarget; operations: MemoryOperation[] }
  | { ok: false; message: string };

/**
 * `memory` 工具：把跨会话该记住的东西写进三块记忆文件。
 *
 * 它负责协议，不负责存储策略——去重、预算、安全扫描、唯一匹配都在
 * `MemoryRepository.apply` 里，工具只是把失败原因翻译成模型能照着改的一段话。
 * 省略 `operations` 就是查询：模型在覆盖一条记忆前需要先看到它。
 */
export class MemoryTool extends MicaTool {
  constructor(private readonly repository: MemoryRepository) {
    super(
      TOOL_NAME,
      [
        'Manage persistent memory: facts that must survive across sessions and are injected into the system prompt at the start of every session.',
        'Targets: `user` = who the user is (name, role, language, communication preferences, recurring expectations);',
        '`memory` = environment facts, tool quirks, lessons learned, conventions that are not tied to one repository;',
        '`project` = this working directory’s conventions, commands, architecture decisions and their reasons.',
        'Use it proactively when you learn something durable: a correction, a preference, a non-obvious command, a decision with its rationale, a mistake worth not repeating.',
        'Do not store: secrets or credentials, one-off file paths or debugging context, facts that are obvious from the code or easily re-discovered, or anything already in AGENTS.md.',
        'Each memory is one short paragraph (separate memories with a blank line) and stores are capped: writing over the limit fails and returns the current entries, so consolidate with `patch` / `remove` in the same batch and retry.',
        'Omit `operations` to read the current entries and usage.',
        `Patches use a unique substring (\`old_text\`); if it matches more than one entry the call fails and lists candidates, so pass a longer excerpt or the whole entry.`,
      ].join(' '),
      {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: [...MEMORY_TARGETS],
            description: 'Which memory store to read or write.',
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
              },
              required: ['action'],
              additionalProperties: false,
            },
          },
        },
        required: ['target'],
        additionalProperties: false,
      },
      { readOnly: false },
    );
  }

  override validateInput(input: unknown) {
    const base = super.validateInput(input);
    if (!base.valid) return base;
    const parsed = parseMemoryInput(input);
    return parsed.ok ? { valid: true } : { valid: false, message: parsed.message };
  }

  async execute(input: ToolInput, _callbacks?: ToolExecuteCallbacks): Promise<string> {
    const parsed = parseMemoryInput(input);
    if (!parsed.ok) throw new Error(parsed.message);

    const { target, operations } = parsed;
    if (operations.length === 0) return describeStore(this.repository, target);

    const result = this.repository.apply(target, operations);
    if (!result.ok) throw new Error(formatRejection(target, result.error));

    const usage = `${result.store.entries.length} entries · ${result.store.chars}/${result.store.limit} characters`;
    return [
      `Memory updated (${target}): ${result.applied.join('; ') || 'no changes'}.`,
      `Usage: ${usage}. Saved to ${result.store.label}.`,
      'The system prompt of this session keeps the snapshot it loaded at session start; the next session reads this file immediately. Ask the user to run /memory refresh if it must be reloaded now.',
    ].join('\n');
  }

  onToolUseDisplayText(input: ToolInput): string {
    const target = typeof input.target === 'string' ? input.target : 'memory';
    const operations = Array.isArray(input.operations) ? input.operations : [];
    if (operations.length === 0) return `Reviewing memory (${target})`;
    const actions = operations
      .map((operation) =>
        operation && typeof operation === 'object' ? String((operation as Record<string, unknown>).action ?? '') : '',
      )
      .filter(Boolean);
    return `Saving memory (${target}, ${actions.join(', ')})`;
  }
}

export function parseMemoryInput(input: unknown): ParsedMemoryInput {
  if (!isRecord(input)) return { ok: false, message: 'input must be an object' };

  const unknownKey = Object.keys(input).find((key) => key !== 'target' && key !== 'operations');
  if (unknownKey) return { ok: false, message: `unknown input field: ${unknownKey}` };

  const target = input.target;
  if (typeof target !== 'string' || !MEMORY_TARGETS.includes(target as MemoryTarget)) {
    return { ok: false, message: `target must be one of ${MEMORY_TARGETS.join(', ')}` };
  }

  if (input.operations === undefined) return { ok: true, target: target as MemoryTarget, operations: [] };
  if (!Array.isArray(input.operations)) return { ok: false, message: 'operations must be an array' };
  if (input.operations.length > MAX_OPERATIONS) {
    return { ok: false, message: `operations must contain at most ${MAX_OPERATIONS} items` };
  }

  const operations: MemoryOperation[] = [];
  for (const [index, raw] of input.operations.entries()) {
    if (!isRecord(raw)) return { ok: false, message: `operations[${index}] must be an object` };
    const extra = Object.keys(raw).find((key) => key !== 'action' && key !== 'old_text' && key !== 'content');
    if (extra) return { ok: false, message: `operations[${index}] has unknown field: ${extra}` };

    if (raw.action === 'add') {
      if (typeof raw.content !== 'string' || !raw.content.trim()) {
        return { ok: false, message: `operations[${index}].content must be a non-empty string for add` };
      }
      operations.push({ action: 'add', content: raw.content });
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

  return { ok: true, target: target as MemoryTarget, operations };
}

function describeStore(repository: MemoryRepository, target: MemoryTarget): string {
  const snapshot = repository.snapshot(target);
  const header = `${target} · ${snapshot.entries.length} entries · ${snapshot.chars}/${snapshot.limit} characters · ${snapshot.label}`;
  if (snapshot.entries.length === 0) return `${header}\n(empty)`;
  return [header, '', ...snapshot.entries.map((entry, index) => `${index + 1}. ${entry}`)].join('\n');
}

function formatRejection(target: MemoryTarget, error: MemoryRejection): string {
  const lines = [`memory write rejected (${target}): ${error.message}`];
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
      `Current entries (${error.store.chars}/${error.store.limit} chars):`,
      ...error.store.entries.map((entry, index) => `${index + 1}. ${truncate(entry)}`),
    );
  }
  return lines.join('\n');
}

function truncate(text: string): string {
  return text.length > MAX_CANDIDATE_CHARS ? `${text.slice(0, MAX_CANDIDATE_CHARS)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
