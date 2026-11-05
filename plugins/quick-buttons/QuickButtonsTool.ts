import { MicaTool, type ToolInput } from '@packages/mica-tools/index.js';
import {
  QUICK_BUTTON_COLORS,
  QUICK_BUTTON_KINDS,
  QUICK_BUTTON_KIND_LABELS,
  QUICK_BUTTON_LIMIT,
  QUICK_BUTTON_SHAPES,
  QUICK_BUTTON_TARGETS,
  formatQuickButtons,
  isStaleQuickButton,
  removeQuickButton,
  replaceQuickButtons,
  upsertQuickButton,
  type QuickButton,
  type QuickButtonInput,
} from './buttons.js';

/**
 * `quick_buttons`：在当前会话的输入框上方放一排按钮。
 *
 * 按钮是给**用户**点的，不是模型另一次「自动执行」的入口：它的价值在于把「复制一个地址、
 * 切到浏览器、粘上去」这类手工动作变成一次点击，所以工具只允许四种没有副作用的落点
 * （打开网页 / 放进输入框 / 开个新会话 / 打开文件）。
 *
 * 一次调用可以建一整排（`operation: set` 是替换整排），因为模型心里本来就是「这一轮需要
 * 这几件事」，逐条建会让用户看到按钮一个一个往下掉。
 */

const OPERATIONS = ['list', 'set', 'add', 'remove', 'clear', 'clear_stale'] as const;

type Operation = (typeof OPERATIONS)[number];

export const QUICK_BUTTONS_TOOL_NAME = 'quick_buttons';

const DESCRIPTION = [
  "Put buttons above the user's message box for the current session (desktop app); in the CLI the same buttons are returned as plain links.",
  'A button is one click the user would otherwise do by hand — open a page, drop a draft into the composer, hand a whole job to a new session, or open a file. They are for the user, never a way for you to run something yourself, so do not encode destructive or hidden work into one.',
  `Kinds: ${QUICK_BUTTON_KINDS.map((kind) => `${kind} (${QUICK_BUTTON_KIND_LABELS[kind]})`).join(' / ')}. \`open\` defaults to the controlled browser the agent can keep driving; pass target:"external" for the system browser.`,
  "Use `dialog` when one click should first show something: a short result, a list of candidates with links, or one explanation with two or three ways to continue (its own buttons). The host renders it with the app's own dialog components — you only describe the content, never markup or styles.",
  'Looks: `style` takes an icon name from the app icon set (`globe`, `external`, `search`, `sparkles`, `zap`, `file-text`, `git-branch`, `notebook-pen`, `list-checks`, `terminal`, `video`, `calendar`, `tags`, `settings-2` …), a color (`accent` / `danger` / `success` / `warn`), a shape (`pill` / `soft` / `plain`) and `iconOnly`. Colors come from the app theme, so they follow light and dark mode; never try to express a color yourself. Use at most one or two styled buttons per row — the rest stay plain.',
  `At most ${QUICK_BUTTON_LIMIT} buttons; pass the whole row with operation:"set" when the task changes what the user needs next, operation:"add" to append, "remove" (by id) or "clear" to take them away.`,
  'Buttons belong to this session only — they disappear when the user switches conversations, so do not use them as a place to store anything.',
  'List marks model-created buttons older than seven days as possibly stale. clear_stale explicitly removes only those buttons; manual buttons and older buttons without known timestamps are kept.',
  'After writing, do not dump the whole list back at the user; mention what you added in one short sentence.',
].join(' ');

const BUTTON_SCHEMA = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description:
        'Stable id (lowercase letters, digits, dot, underscore, dash). Give one only when you need to update the same button later; otherwise it is derived from the label.',
    },
    label: { type: 'string', description: 'Text on the button, at most 12 characters — an action, not a sentence.' },
    kind: {
      type: 'string',
      enum: [...QUICK_BUTTON_KINDS],
      description:
        'open = a page, compose = text in the composer (not sent), session = new session with a prompt, path = a file in the app.',
    },
    url: { type: 'string', description: 'kind=open: http/https address.' },
    target: {
      type: 'string',
      enum: [...QUICK_BUTTON_TARGETS],
      description: 'kind=open: browser = controlled browser (default), external = system browser.',
    },
    text: {
      type: 'string',
      description:
        'kind=compose: the draft to put in the composer; kind=session: the first message of the new session.',
    },
    role: { type: 'string', description: 'kind=session: role for the new session (e.g. 需求开发).' },
    path: { type: 'string', description: 'kind=path: absolute path to the file or folder.' },
    style: {
      type: 'object',
      description: 'Optional look: how the host draws this button.',
      properties: {
        icon: { type: 'string', description: 'Icon name from the app icon set, e.g. globe / external / search / zap.' },
        color: {
          type: 'string',
          enum: [...QUICK_BUTTON_COLORS],
          description: 'Accent color; omit for a plain button.',
        },
        shape: {
          type: 'string',
          enum: [...QUICK_BUTTON_SHAPES],
          description: 'pill = outlined capsule (default), soft = no border, plain = text only.',
        },
        iconOnly: { type: 'boolean', description: 'Draw the icon only; the label becomes the tooltip.' },
      },
      additionalProperties: false,
    },
    dialog: {
      type: 'object',
      description: 'kind=dialog: what the popup shows. The host renders it with existing components.',
      properties: {
        title: { type: 'string', description: 'Dialog title (required).' },
        subtitle: { type: 'string', description: 'One line under the title.' },
        text: { type: 'string', description: 'A plain paragraph (line breaks are kept).' },
        markdown: {
          type: 'string',
          description: 'Markdown body instead of plain text; use it for a list or a small table.',
        },
        items: {
          type: 'array',
          description: 'A two-column list (name / content). Give `url` when the row should be clickable.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
              url: { type: 'string', description: 'http/https address this row opens.' },
            },
            required: ['label'],
          },
        },
        note: { type: 'string', description: 'One line under the list.' },
        actions: {
          type: 'array',
          description:
            'Up to 3 buttons at the bottom of the dialog. Each behaves like a button of its own kind (open / compose / session / path); a dialog inside a dialog is not allowed.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              kind: { type: 'string', enum: ['open', 'compose', 'session', 'path'] },
              url: { type: 'string' },
              target: { type: 'string', enum: [...QUICK_BUTTON_TARGETS] },
              text: { type: 'string' },
              role: { type: 'string' },
              path: { type: 'string' },
              tone: { type: 'string', enum: ['primary', 'danger'] },
            },
            required: ['label', 'kind'],
          },
        },
      },
      required: ['title'],
    },
    hint: { type: 'string', description: 'Optional one-line explanation shown on hover.' },
  },
  required: ['label', 'kind'],
};

export type QuickButtonsStore = {
  read(): QuickButton[];
  write(buttons: QuickButton[]): void;
};

export class QuickButtonsTool extends MicaTool {
  constructor(
    private readonly store: QuickButtonsStore,
    private readonly options: { desktop: boolean },
  ) {
    super(QUICK_BUTTONS_TOOL_NAME, DESCRIPTION, {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [...OPERATIONS],
          description:
            'list = read the current row, set = replace the whole row, add = append (same id replaces), remove = drop one by id, clear = remove all, clear_stale = remove only model buttons last updated over seven days ago.',
        },
        buttons: {
          type: 'array',
          description: 'required by set / add: the buttons to write.',
          items: BUTTON_SCHEMA,
        },
        id: { type: 'string', description: 'required by remove: the id shown by list.' },
      },
      required: ['operation'],
      additionalProperties: false,
    });
  }

  async execute(input: ToolInput): Promise<string> {
    const operation = readOperation(input);
    if (operation === 'list') return formatQuickButtons(this.store.read(), this.options);

    const current = this.store.read();
    switch (operation) {
      case 'clear_stale': {
        const now = Date.now();
        const next = current.filter((button) => !isStaleQuickButton(button, now));
        const count = current.length - next.length;
        if (count > 0) this.store.write(next);
        return `已清理 ${count} 个可能过时的模型快捷按钮。\n\n${formatQuickButtons(next, this.options)}`;
      }
      case 'clear': {
        if (current.length === 0) return formatQuickButtons(current, this.options);
        this.store.write([]);
        return `已清空 ${current.length} 个快捷按钮。\n\n${formatQuickButtons([], this.options)}`;
      }
      case 'remove': {
        const id = readString(input, 'id');
        if (!id) throw new Error('remove 需要 id（先用 operation:"list" 看现有按钮的 id）');
        const next = removeQuickButton(current, id);
        if (next.length === current.length) throw new Error(`没有 id 为「${id}」的按钮`);
        this.store.write(next);
        return `已删除「${id}」。\n\n${formatQuickButtons(next, this.options)}`;
      }
      case 'set': {
        const buttons = readButtons(input);
        const now = Date.now();
        const next = replaceQuickButtons(buttons).map((button) => stampModelButton(button, current, now));
        this.store.write(next);
        return `${changedLine('已换成', next)}\n\n${formatQuickButtons(next, this.options)}`;
      }
      case 'add': {
        const buttons = readButtons(input);
        const now = Date.now();
        let next = current;
        const created: string[] = [];
        for (const button of buttons) {
          const result = upsertQuickButton(next, button);
          const stamped = stampModelButton(result.button, next, now);
          next = result.buttons.map((entry) => (entry.id === stamped.id ? stamped : entry));
          created.push(result.created ? result.button.label : `${result.button.label}（更新）`);
        }
        this.store.write(next);
        return `${changedLine('已添加', next, created)}\n\n${formatQuickButtons(next, this.options)}`;
      }
    }
  }

  onToolUseDisplayText(input: ToolInput): string {
    switch (input.operation) {
      case 'list':
        return 'Reading quick buttons';
      case 'set':
      case 'add':
        return 'Placing quick buttons';
      case 'remove':
      case 'clear':
      case 'clear_stale':
        return 'Removing quick buttons';
      default:
        return 'Updating quick buttons';
    }
  }
}

function stampModelButton(button: QuickButton, current: QuickButton[], now: number): QuickButton {
  const previous = current.find((entry) => entry.id === button.id && entry.source === 'model');
  return { ...button, source: 'model', createdAt: previous?.createdAt ?? now, updatedAt: now };
}

function changedLine(prefix: string, buttons: QuickButton[], labels?: string[]): string {
  const names = labels?.length ? labels.join('、') : `${buttons.length} 个按钮`;
  return `${prefix}${names}。`;
}

function readOperation(input: ToolInput): Operation {
  const value = input.operation;
  if (typeof value === 'string' && (OPERATIONS as readonly string[]).includes(value)) {
    return value as Operation;
  }
  throw new Error(`operation 只能是 ${OPERATIONS.join(' / ')}`);
}

function readButtons(input: ToolInput): QuickButtonInput[] {
  const value = input.buttons;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('buttons 需要一组按钮（每个至少给 label 与 kind）');
  }
  return value.map((entry) => (isRecord(entry) ? (entry as QuickButtonInput) : {}));
}

function readString(input: ToolInput, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
