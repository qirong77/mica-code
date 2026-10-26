import { MAX_SESSION_NOTES_LENGTH, normalizeSessionNotes, sessionNotesSummary } from '@packages/mica-common/index.js';
import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';

const TOOL_NAME = 'session_notes';

export type NotesAction = 'read' | 'append' | 'replace';

export type ParsedNotesInput =
  | { ok: true; action: 'read' }
  | { ok: true; action: 'append' | 'replace'; content: string }
  | { ok: false; message: string };

/**
 * 读 / 追加 / 覆盖本会话的笔记。
 *
 * 笔记不在对话历史里，所以这个工具改动的东西不会被 compact 吃掉——这正是它存在的
 * 理由。工具本身零 IO：读写走构造注入的回调，存储位置由插件决定（现在是会话快照的
 * `pluginState`），因此这个类对「笔记存在哪」完全无感。
 */
export class SessionNotesTool extends MicaTool {
  constructor(
    private readonly read: () => string = () => '',
    private readonly write: (notes: string) => void = () => undefined,
  ) {
    super(
      TOOL_NAME,
      [
        "Read or update this session's notes: a markdown scratchpad shared with the user and shown in the desktop notes panel.",
        'The notes live outside the conversation history, so they are never lost to context compaction and are re-attached to the system prompt at the start of every turn.',
        'Keep there what must survive a compact: decisions and their reasons, user constraints and preferences, paths/commands that took effort to find, and open questions.',
        'Read before a large rewrite, append instead of replacing when you are only adding, and keep it deduplicated and organized under headings rather than a chronological dump.',
        'The user edits the same document in the UI, so their edits are authoritative — do not copy the notes back into the chat, the user can already see them.',
      ].join(' '),
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'append', 'replace'],
            description:
              'read returns the current notes; append adds content below what is already there; replace overwrites the whole document.',
          },
          content: {
            type: 'string',
            description: `Markdown to write. Required for append and replace, ignored for read. At most ${MAX_SESSION_NOTES_LENGTH} characters in total.`,
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
    );
  }

  override validateInput(input: unknown) {
    const base = super.validateInput(input);
    if (!base.valid) return base;
    const parsed = parseNotesInput(input);
    return parsed.ok ? { valid: true } : { valid: false, message: parsed.message };
  }

  async execute(input: ToolInput, _callbacks?: ToolExecuteCallbacks): Promise<string> {
    const parsed = parseNotesInput(input);
    if (!parsed.ok) throw new Error(parsed.message);

    if (parsed.action === 'read') {
      const current = normalizeSessionNotes(this.read());
      return current ? current : 'Session notes are empty.';
    }

    const base = normalizeSessionNotes(this.read());
    const addition = normalizeSessionNotes(parsed.content);
    const combined = parsed.action === 'append' ? (base ? `${base}\n\n${addition}` : addition) : addition;
    // 归一化会静默截断，那是给损坏数据和面板输入兜底的；工具这边要明说，
    // 否则模型以为写进去了，实际上尾巴被砍掉了。
    if (combined.length > MAX_SESSION_NOTES_LENGTH) {
      throw new Error(
        `session notes would be ${combined.length} characters, over the ${MAX_SESSION_NOTES_LENGTH} limit; consolidate them first (replace with a shorter version) instead of appending.`,
      );
    }
    const next = normalizeSessionNotes(combined);
    this.write(next);

    const { chars, lines } = sessionNotesSummary(next);
    const summary = `${chars} characters, ${lines} lines`;
    if (parsed.action === 'append') {
      return `Session notes updated: appended, now ${summary}. They reach the model with the next turn's system prompt.`;
    }
    return `Session notes replaced: now ${summary}.`;
  }

  onToolUseDisplayText(input: ToolInput): string {
    const action = typeof input.action === 'string' ? input.action : 'read';
    return action === 'read' ? 'Reading session notes' : `Updating session notes (${action})`;
  }
}

export function parseNotesInput(input: unknown): ParsedNotesInput {
  if (!isRecord(input)) return { ok: false, message: 'input must be an object' };

  const unknownKey = Object.keys(input).find((key) => key !== 'action' && key !== 'content');
  if (unknownKey) return { ok: false, message: `unknown input field: ${unknownKey}` };

  if (input.action === 'read') return { ok: true, action: 'read' };
  if (input.action !== 'append' && input.action !== 'replace') {
    return { ok: false, message: 'action must be read, append, or replace' };
  }
  if (typeof input.content !== 'string') {
    return { ok: false, message: `${input.action} requires content to be a string` };
  }
  if (!input.content.trim()) {
    return { ok: false, message: `${input.action} requires non-empty content` };
  }
  if (input.content.length > MAX_SESSION_NOTES_LENGTH) {
    return {
      ok: false,
      message: `content must contain at most ${MAX_SESSION_NOTES_LENGTH} characters`,
    };
  }
  return { ok: true, action: input.action, content: input.content };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
