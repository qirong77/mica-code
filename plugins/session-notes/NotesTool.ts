import {
  MAX_SESSION_NOTES_LENGTH,
  normalizeSessionNotes,
  removeNotesSection,
  replaceNotesSection,
  sessionNotesSummary,
} from '@packages/mica-common/index.js';
import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';

const TOOL_NAME = 'session_notes';

export type NotesAction = 'read' | 'append' | 'replace' | 'replace_section' | 'remove_section';

export type ParsedNotesInput =
  | { ok: true; action: 'read' }
  | { ok: true; action: 'append' | 'replace'; content: string }
  | { ok: true; action: 'replace_section'; section: string; content: string }
  | { ok: true; action: 'remove_section'; section: string }
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
        'Organize the notes under headings, and prefer the section-scoped actions: remove_section deletes one heading and its body, replace_section rewrites one section. Both leave the rest of the document untouched and only cost the text you actually change.',
        'When an append is refused for length, do not rewrite the whole document: delete or shrink the obsolete sections with remove_section / replace_section, then append again.',
        'The user edits the same document in the UI, so their edits are authoritative — do not copy the notes back into the chat, the user can already see them.',
      ].join(' '),
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'append', 'replace', 'replace_section', 'remove_section'],
            description:
              'read returns the current notes; append adds content below what is already there; replace overwrites the whole document (use empty content to clear it); replace_section rewrites the body of one heading; remove_section deletes one heading and its body.',
          },
          section: {
            type: 'string',
            description:
              'Heading to target for replace_section / remove_section, e.g. "Open questions" or "## Open questions". Must match exactly one heading; the error lists the existing ones.',
          },
          content: {
            type: 'string',
            description: `Markdown to write. Required for append, replace and replace_section; ignored for read and remove_section. The whole notes document stays at most ${MAX_SESSION_NOTES_LENGTH} characters.`,
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

    // 按节改：只写改动的那一段，其余原文不动。笔记到上限时这是唯一的低成本出路——
    // 整篇重写要重新生成两万字，还可能顺手丢掉别的章节。
    if (parsed.action === 'replace_section' || parsed.action === 'remove_section') {
      const result =
        parsed.action === 'replace_section'
          ? replaceNotesSection(base, parsed.section, parsed.content)
          : removeNotesSection(base, parsed.section);
      if (!result.ok) throw new Error(result.message);
      if (result.notes.length > MAX_SESSION_NOTES_LENGTH) {
        throw new Error(
          `session notes would be ${result.notes.length} characters, over the ${MAX_SESSION_NOTES_LENGTH} limit; shorten this section or remove another one.`,
        );
      }
      this.write(result.notes);
      const { chars, lines } = sessionNotesSummary(result.notes);
      const verb = parsed.action === 'replace_section' ? 'section replaced' : 'section removed';
      return `Session notes updated: ${verb} ("${result.heading}"), now ${chars} characters, ${lines} lines. They reach the model with the next turn's system prompt.`;
    }

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
    if (action === 'read') return 'Reading session notes';
    const section = typeof input.section === 'string' && input.section.trim() ? ` "${input.section.trim()}"` : '';
    return `Updating session notes (${action}${section})`;
  }
}

export function parseNotesInput(input: unknown): ParsedNotesInput {
  if (!isRecord(input)) return { ok: false, message: 'input must be an object' };

  const unknownKey = Object.keys(input).find((key) => key !== 'action' && key !== 'content' && key !== 'section');
  if (unknownKey) return { ok: false, message: `unknown input field: ${unknownKey}` };

  if (input.action === 'read') return { ok: true, action: 'read' };
  if (
    input.action !== 'append' &&
    input.action !== 'replace' &&
    input.action !== 'replace_section' &&
    input.action !== 'remove_section'
  ) {
    return { ok: false, message: 'action must be read, append, replace, replace_section, or remove_section' };
  }

  if (input.action === 'replace_section' || input.action === 'remove_section') {
    if (typeof input.section !== 'string' || !input.section.trim()) {
      return { ok: false, message: `${input.action} requires section to name a heading` };
    }
    if (input.action === 'remove_section') {
      return { ok: true, action: 'remove_section', section: input.section };
    }
    if (typeof input.content !== 'string') {
      return { ok: false, message: 'replace_section requires content to be a string' };
    }
    return { ok: true, action: 'replace_section', section: input.section, content: input.content };
  }

  if (input.section !== undefined) {
    // 显式拒绝而不是静默忽略：模型以为按节改，实际动了整篇是最糟的结果。
    return { ok: false, message: `section is only valid for replace_section / remove_section, not ${input.action}` };
  }
  if (typeof input.content !== 'string') {
    return { ok: false, message: `${input.action} requires content to be a string` };
  }
  if (input.action === 'append' && !input.content.trim()) {
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
