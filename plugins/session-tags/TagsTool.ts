import { MicaTool, type ToolInput } from '@packages/mica-tools/index.js';
import {
  TAG_COLORS,
  TAG_COLOR_HEX,
  addSessionTag,
  formatTagList,
  isTagColor,
  removeSessionTag,
  tagCounts,
  tagsOf,
  type TagColor,
  type TagStore,
} from './tags.js';

const TOOL_NAME = 'session_tags';

export type ParsedTagsInput =
  | { ok: true; action: 'read' }
  | { ok: true; action: 'add' | 'remove'; color: TagColor }
  | { ok: false; message: string };

/**
 * 读写**当前会话**的标签。
 *
 * 只给当前会话：别的会话 id 从 `ctx.session` 拿不到，让模型凭 id 乱写等于给了它一把
 * 能改整个标签表的钥匙。跨会话的浏览与筛选留给宿主界面（它直接读同一份文件）。
 *
 * 标签是用户的分类习惯，不是模型的工具：描述里明确写「只在用户要求时改」。
 */
export class TagsTool extends MicaTool {
  constructor(
    private readonly deps: {
      readStore: () => TagStore;
      writeStore: (store: TagStore) => void;
      sessionId: () => string | null;
    },
  ) {
    super(
      TOOL_NAME,
      [
        'Read or change the color tags of the current session. Tags mimic macOS Finder labels:',
        `seven fixed color slots (${TAG_COLORS.join(', ')}), each with a user-editable name; a session may carry several.`,
        "Tags are the user's own filing habit, so only change them when the user explicitly asks for it.",
        'Colors are fixed — you can pick a slot but not invent a new one; renaming a slot is a settings action, not a tool action.',
        "`read` returns the current session's tags plus every slot with its usage count.",
      ].join(' '),
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'add', 'remove'],
            description: 'read lists tags; add/remove change the current session and need `color`.',
          },
          color: {
            type: 'string',
            enum: [...TAG_COLORS],
            description: `Color slot to add or remove: ${TAG_COLORS.join(' / ')}.`,
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
    const parsed = parseTagsInput(input);
    return parsed.ok ? { valid: true } : { valid: false, message: parsed.message };
  }

  override async execute(input: ToolInput): Promise<string> {
    const parsed = parseTagsInput(input);
    if (!parsed.ok) return `Invalid input: ${parsed.message}`;

    const store = this.deps.readStore();
    const sessionId = this.deps.sessionId();
    if (!sessionId) return 'No active session: tags belong to a session, so there is nothing to tag yet.';

    if (parsed.action === 'read') {
      const counts = tagCounts(store);
      const slots = TAG_COLORS.map(
        (color) => `${color} (${TAG_COLOR_HEX[color]}) = ${store.labels[color]}, ${counts[color]} session(s)`,
      );
      return [
        `Current session tags: ${formatTagList(store, tagsOf(store, sessionId))}`,
        'Slots:',
        ...slots.map((line) => `  - ${line}`),
      ].join('\n');
    }

    const next =
      parsed.action === 'add'
        ? addSessionTag(store, sessionId, parsed.color)
        : removeSessionTag(store, sessionId, parsed.color);
    if (next === store) {
      return parsed.action === 'add'
        ? `Session already has the ${parsed.color} tag; nothing changed.`
        : `Session does not have the ${parsed.color} tag; nothing changed.`;
    }
    this.deps.writeStore(next);
    return `${parsed.action === 'add' ? 'Added' : 'Removed'} the ${parsed.color} tag. Now: ${formatTagList(
      next,
      tagsOf(next, sessionId),
    )}.`;
  }

  onToolUseDisplayText(input: ToolInput): string {
    const action = typeof input.action === 'string' ? input.action : 'read';
    const color = typeof input.color === 'string' ? ` ${input.color}` : '';
    if (action === 'read') return 'Reading session tags';
    return `${action === 'add' ? 'Tagging' : 'Untagging'} session${color}`;
  }
}

/** 工具入参解析。只认色槽 id —— 名字是用户可改的，模型不该依赖它。 */
export function parseTagsInput(input: unknown): ParsedTagsInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'input must be an object' };
  }
  const record = input as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => key !== 'action' && key !== 'color');
  if (unknownKey) return { ok: false, message: `unknown input field: ${unknownKey}` };

  if (record.action === 'read') return { ok: true, action: 'read' };
  if (record.action !== 'add' && record.action !== 'remove') {
    return { ok: false, message: 'action must be read, add, or remove' };
  }
  if (!isTagColor(record.color)) {
    return {
      ok: false,
      message: `color must be one of ${TAG_COLORS.join(', ')}`,
    };
  }
  return { ok: true, action: record.action, color: record.color };
}
