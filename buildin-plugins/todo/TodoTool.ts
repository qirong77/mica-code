import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';

const TOOL_NAME = 'TodoWrite';
const MAX_TODOS = 20;
const MAX_TEXT_LENGTH = 240;

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export type TodoItem = {
  content: string;
  activeForm: string;
  status: TodoStatus;
};

export type ParsedTodos = { ok: true; items: TodoItem[] } | { ok: false; message: string };

export class TodoWriteTool extends MicaTool {
  constructor(private readonly replace: (items: TodoItem[], ownerId?: string) => void = () => undefined) {
    super(
      TOOL_NAME,
      [
        'Create or update the structured todo list for the current coding task.',
        'Use it for tasks with several meaningful steps, and skip it for trivial one-step work.',
        'Send the complete list on every call, keep at most one item in_progress, and update statuses as work advances.',
        'Before yielding a final response, waiting for user input, or stopping for any reason, leave no item in_progress: mark finished items completed and unfinished items pending.',
        'Use content for the imperative task label and activeForm for the present-progressive label shown while working.',
      ].join(' '),
      {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The complete replacement todo list in execution order.',
            maxItems: MAX_TODOS,
            items: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  minLength: 1,
                  maxLength: MAX_TEXT_LENGTH,
                  description: 'Imperative task label, for example "Run tests".',
                },
                activeForm: {
                  type: 'string',
                  minLength: 1,
                  maxLength: MAX_TEXT_LENGTH,
                  description: 'Present-progressive label, for example "Running tests".',
                },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['content', 'activeForm', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['todos'],
        additionalProperties: false,
      },
    );
  }

  override validateInput(input: unknown) {
    const base = super.validateInput(input);
    if (!base.valid) return base;

    const parsed = parseTodoInput(input);
    return parsed.ok ? { valid: true } : { valid: false, message: parsed.message };
  }

  async execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const parsed = parseTodoInput(input);
    if (!parsed.ok) throw new Error(parsed.message);

    this.replace(parsed.items, todoOwnerIdFromToolContext(callbacks?.context));
    return formatTodoSummary(parsed.items);
  }

  onToolUseDisplayText(input: ToolInput): string {
    const count = Array.isArray(input.todos) ? input.todos.length : 0;
    return count === 0 ? 'Clearing todo list' : `Updating todo list (${count})`;
  }
}

export function parseTodoInput(input: unknown): ParsedTodos {
  if (!isRecord(input)) return { ok: false, message: 'input must be an object' };

  const inputKeys = Object.keys(input);
  if (inputKeys.some((key) => key !== 'todos')) {
    return { ok: false, message: `unknown input field: ${inputKeys.find((key) => key !== 'todos')}` };
  }
  if (!Array.isArray(input.todos)) return { ok: false, message: 'todos must be an array' };
  if (input.todos.length > MAX_TODOS) {
    return { ok: false, message: `todos must contain at most ${MAX_TODOS} items` };
  }

  const items: TodoItem[] = [];
  let inProgressCount = 0;
  for (const [index, value] of input.todos.entries()) {
    if (!isRecord(value)) return { ok: false, message: `todos[${index}] must be an object` };

    const allowedKeys = new Set(['content', 'activeForm', 'status']);
    const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
    if (unknownKey) return { ok: false, message: `todos[${index}] has unknown field: ${unknownKey}` };

    const content = normalizeTodoText(value.content, `todos[${index}].content`);
    if (!content.ok) return content;
    const activeForm = normalizeTodoText(value.activeForm, `todos[${index}].activeForm`);
    if (!activeForm.ok) return activeForm;
    if (!isTodoStatus(value.status)) {
      return {
        ok: false,
        message: `todos[${index}].status must be pending, in_progress, or completed`,
      };
    }

    if (value.status === 'in_progress') inProgressCount += 1;
    items.push({ content: content.value, activeForm: activeForm.value, status: value.status });
  }

  if (inProgressCount > 1) return { ok: false, message: 'only one todo may be in_progress at a time' };
  return { ok: true, items };
}

export function formatTodoSummary(items: TodoItem[]): string {
  if (items.length === 0) return 'Todo list cleared.';

  const completed = items.filter((item) => item.status === 'completed').length;
  const pending = items.filter((item) => item.status === 'pending').length;
  const current = items.find((item) => item.status === 'in_progress');
  const counts = `${items.length} total, ${completed} completed, ${pending} pending`;
  return current ? `Todo list updated: ${counts}. Current: ${current.activeForm}` : `Todo list updated: ${counts}.`;
}

function normalizeTodoText(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== 'string') return { ok: false, message: `${field} must be a string` };
  const normalized = value.trim();
  if (!normalized) return { ok: false, message: `${field} must not be empty` };
  if (normalized.length > MAX_TEXT_LENGTH) {
    return { ok: false, message: `${field} must contain at most ${MAX_TEXT_LENGTH} characters` };
  }
  return { ok: true, value: normalized };
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}

function todoOwnerIdFromToolContext(context: unknown): string | undefined {
  return isRecord(context) ? todoOwnerId(context.agent) : undefined;
}

function todoOwnerId(owner: unknown): string | undefined {
  if (!isRecord(owner)) return undefined;
  const ownerId = owner.taskOwnerId;
  return typeof ownerId === 'string' && ownerId.length > 0 ? ownerId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
