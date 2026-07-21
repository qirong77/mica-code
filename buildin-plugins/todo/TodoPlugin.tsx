import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import type { MicaPlugin, PluginContext } from '@packages/mica-plugin/index.js';
import type { RuntimeTurnAfterHookEvent } from '@packages/mica-runtime/index.js';
import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import { micaUi, type MicaUiAgentStatusItem } from '@packages/mica-ui/index.js';

const PLUGIN_ID = 'builtin.todo';
const STATUS_ITEM_ID = 'builtin.todo.list';
const TOOL_NAME = 'TodoWrite';
const MAX_TODOS = 20;
const MAX_TEXT_LENGTH = 240;
const TODO_KIND = '📝(todo)';
const TODO_KIND_WIDTH = 12;
const TODO_STATUS_WIDTH = 8;
const TODO_ITEM_INDENT = '     ⎿  ';
const FALLBACK_OWNER_ID = 'builtin.todo.default-owner';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export type TodoItem = {
  content: string;
  activeForm: string;
  status: TodoStatus;
};

type TodoViewState = {
  items: TodoItem[];
  visible: boolean;
};

type TodoStatesByOwner = ReadonlyMap<string, TodoViewState>;

type ParsedTodos = { ok: true; items: TodoItem[] } | { ok: false; message: string };

export class TodoPlugin implements MicaPlugin {
  readonly id = PLUGIN_ID;
  readonly name = 'Built-in Todo';
  readonly required = true;

  setup(ctx: PluginContext): void {
    const states = atom<TodoStatesByOwner>(new Map());
    const activeOwnerId = () => currentTodoOwnerId(micaUi.panels.agentStatusItems.get());
    const getOwnerState = (ownerId: string) => states.get().get(ownerId) ?? createTodoViewState();
    const setOwnerState = (ownerId: string, next: TodoViewState) => {
      const current = states.get();
      if (current.get(ownerId) === next) return;
      const updated = new Map(current);
      updated.set(ownerId, next);
      states.set(updated);
    };
    const deleteOwnerState = (ownerId: string) => {
      const current = states.get();
      if (!current.has(ownerId)) return;
      const updated = new Map(current);
      updated.delete(ownerId);
      states.set(updated);
    };
    const updateOwnerState = (ownerId: string, update: (current: TodoViewState) => TodoViewState) => {
      const current = getOwnerState(ownerId);
      const next = update(current);
      if (next !== current) setOwnerState(ownerId, next);
    };
    const tool = new TodoWriteTool((items, ownerId) => {
      updateOwnerState(ownerId ?? activeOwnerId(), (current) => ({ ...current, items }));
    });

    function TodoStatusList(): React.ReactNode {
      const currentStates = micaUi.useScheduleState(states);
      const agents = micaUi.useScheduleState(micaUi.panels.agentStatusItems);
      const current = currentStates.get(currentTodoOwnerId(agents)) ?? createTodoViewState();
      if (!shouldShowTodoList(current)) return null;

      const completed = current.items.filter((item) => item.status === 'completed').length;
      const active = current.items.some((item) => item.status === 'in_progress');
      const status = active ? 'running' : 'pending';
      const remaining = current.items.length - completed;
      return (
        <Box flexDirection="column" width="100%" minWidth={0} marginTop={1}>
          <micaUi.OneLineItem
            cells={[
              { key: 'kind', content: TODO_KIND, width: TODO_KIND_WIDTH, flexShrink: 0 },
              {
                key: 'status',
                content: status,
                width: TODO_STATUS_WIDTH,
                flexShrink: 0,
                color: todoListStatusColor(status),
              },
              {
                key: 'progress',
                content: (
                  <Text dimColor>
                    {completed}/{current.items.length}
                  </Text>
                ),
                flexShrink: 0,
              },
              {
                key: 'remaining',
                content: `${remaining} remaining`,
                flexGrow: 1,
                minWidth: 0,
                dimColor: true,
              },
            ]}
          />
          {current.items.map((item, index) => (
            <TodoRow key={`${index}:${item.content}`} item={item} />
          ))}
        </Box>
      );
    }

    if (!ctx.tools) throw new Error('todo requires ctx.tools');
    const toolRegistration = ctx.tools.register(tool, { icon: '📝', primaryAgentOnly: true });
    ctx.onDispose(() => toolRegistration.dispose());

    ctx.ui?.status?.upsert({ id: STATUS_ITEM_ID, component: TodoStatusList });
    ctx.onDispose(() => {
      ctx.ui?.status?.remove(STATUS_ITEM_ID);
    });

    const eventSubscription = ctx.events.on('event', (event) => {
      const ownerId = todoOwnerId(event.owner) ?? activeOwnerId();
      if (event.type === 'session:cleared' || event.type === 'session:invalidated') {
        setOwnerState(ownerId, createTodoViewState());
      } else if (event.type === 'session:disposed') {
        deleteOwnerState(ownerId);
      } else if (event.type === 'turn:aborted') {
        updateOwnerState(ownerId, pauseInProgressTodo);
      }
    });
    ctx.onDispose(() => eventSubscription.dispose());

    const turnAfterSubscription = ctx.hooks.on<RuntimeTurnAfterHookEvent>(
      'turn:after',
      (event) => {
        const ownerId = todoOwnerId(event.owner) ?? activeOwnerId();
        updateOwnerState(ownerId, pauseInProgressTodo);
      },
      { pluginId: ctx.pluginId },
    );
    ctx.onDispose(() => turnAfterSubscription.dispose());

    const command = ctx.commands.register({
      name: 'todo',
      description: 'Show, hide, or clear the current todo list',
      completionItems: [
        { arg: 'show', description: 'Show the todo list' },
        { arg: 'hide', description: 'Hide the todo list' },
        { arg: 'clear', description: 'Clear the todo list' },
      ],
      scope: 'local-only',
      allowDuringTurn: true,
      pluginId: ctx.pluginId,
      handler: (_commandCtx, args) => {
        const action = args.trim().toLowerCase();
        const ownerId = activeOwnerId();
        const current = getOwnerState(ownerId);

        if (!action || action === 'show') {
          setOwnerState(ownerId, { ...current, visible: true });
          ctx.ui?.showMessage(current.items.length === 0 ? 'Todo list is empty.' : formatTodoSummary(current.items));
          return { ok: true };
        }
        if (action === 'hide') {
          setOwnerState(ownerId, { ...current, visible: false });
          ctx.ui?.showMessage('Todo list hidden. Use /todo show to restore it.');
          return { ok: true };
        }
        if (action === 'clear') {
          setOwnerState(ownerId, { items: [], visible: current.visible });
          ctx.ui?.showMessage('Todo list cleared.');
          return { ok: true };
        }

        ctx.ui?.showMessage('Usage: /todo [show|hide|clear]');
        return { ok: true };
      },
    });
    ctx.onDispose(() => command.dispose());
  }
}

export function shouldShowTodoList(state: TodoViewState): boolean {
  return state.visible && state.items.length > 0 && state.items.some((item) => item.status !== 'completed');
}

class TodoWriteTool extends MicaTool {
  constructor(private readonly replace: (items: TodoItem[], ownerId?: string) => void) {
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

function createTodoViewState(): TodoViewState {
  return { items: [], visible: true };
}

function pauseInProgressTodo(current: TodoViewState): TodoViewState {
  if (!current.items.some((item) => item.status === 'in_progress')) return current;
  // A stopped turn does not prove the task completed; pending is the conservative terminal state.
  return {
    ...current,
    items: current.items.map((item) => (item.status === 'in_progress' ? { ...item, status: 'pending' } : item)),
  };
}

function currentTodoOwnerId(agents: readonly MicaUiAgentStatusItem[]): string {
  return agents.find((agent) => agent.current)?.taskOwnerId ?? FALLBACK_OWNER_ID;
}

function todoOwnerIdFromToolContext(context: unknown): string | undefined {
  return isRecord(context) ? todoOwnerId(context.agent) : undefined;
}

function todoOwnerId(owner: unknown): string | undefined {
  if (!isRecord(owner)) return undefined;
  const ownerId = owner.taskOwnerId;
  return typeof ownerId === 'string' && ownerId.length > 0 ? ownerId : undefined;
}

function TodoRow({ item }: { item: TodoItem }): React.ReactNode {
  const marker = item.status === 'completed' ? '✓ ' : item.status === 'in_progress' ? <micaUi.Spin /> : '○ ';
  const content = item.status === 'in_progress' ? item.activeForm : item.content;

  return (
    <micaUi.OneLineItem
      gap={0}
      cells={[
        {
          key: 'prefix',
          content: <Text dimColor>{TODO_ITEM_INDENT}</Text>,
          flexShrink: 0,
        },
        {
          key: 'marker',
          content: marker,
          flexShrink: 0,
          color: todoItemColor(item.status),
          dimColor: item.status === 'pending',
        },
        {
          key: 'content',
          content,
          flexGrow: 1,
          minWidth: 0,
          color: todoItemColor(item.status),
          dimColor: item.status !== 'in_progress',
        },
      ]}
    />
  );
}

function todoListStatusColor(status: 'running' | 'pending'): string {
  if (status === 'running') return micaUi.theme.colors.info;
  return micaUi.theme.colors.muted;
}

function todoItemColor(status: TodoStatus): string | undefined {
  if (status === 'in_progress') return micaUi.theme.colors.accent;
  if (status === 'completed') return micaUi.theme.colors.success;
  return undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function formatTodoSummary(items: TodoItem[]): string {
  if (items.length === 0) return 'Todo list cleared.';

  const completed = items.filter((item) => item.status === 'completed').length;
  const pending = items.filter((item) => item.status === 'pending').length;
  const current = items.find((item) => item.status === 'in_progress');
  const counts = `${items.length} total, ${completed} completed, ${pending} pending`;
  return current ? `Todo list updated: ${counts}. Current: ${current.activeForm}` : `Todo list updated: ${counts}.`;
}
