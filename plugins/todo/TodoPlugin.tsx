import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { randomUUID } from 'node:crypto';
import type { MicaPlugin, PluginContext } from '@packages/mica-plugin/index.js';
import type { RuntimeTurnAfterHookEvent, RuntimeTurnBeforeHookEvent } from '@packages/mica-runtime/index.js';
import { micaSession } from '@packages/mica-session/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import {
  formatTodoSummary,
  resolveTodoPanel,
  summarizeTodoProgress,
  todoSessionForOwner,
  type TodoItem,
  type TodoStatus,
} from '@packages/mica-common/todoState.js';
import { TodoWriteTool } from './TodoTool.js';
import { buildTodoGuidance } from './prompt.js';
import { readTodoCheckpoint, writeTodoCheckpoint } from './todoPersistence.js';

export { formatTodoSummary, parseTodoInput, resolveTodoPanel } from '@packages/mica-common/todoState.js';
export { TODO_GUIDANCE, buildTodoGuidance } from './prompt.js';
export type { TodoItem, TodoStatus } from '@packages/mica-common/todoState.js';

const PLUGIN_ID = 'todo';
const STATUS_ITEM_ID = 'todo.list';
/**
 * 计划段落排在委派（100）之前：先确定做什么，再决定要不要分出去。
 */
const PROMPT_SECTION_ORDER = 50;
const TODO_KIND = '📝(todo)';
const TODO_KIND_WIDTH = 12;
const TODO_STATUS_WIDTH = 10;
const TODO_ITEM_INDENT = '     ⎿  ';

/**
 * 面板状态。
 *
 * 每个会话 owner 保有独立视图：主会话之间也能并行运行，后台会话的工具与生命周期
 * 只更新自己的清单。旧宿主没有 owner 能力时沿用单会话视图。
 *
 * `live` 表示「这一轮还在跑」，`pinned` 表示用户用 `/todo show` 手动打开了面板。
 * 两者合成「现在要不要显示」，但只有 `live` 决定 `in_progress` 是否算仍在进行——
 * 空闲时查看旧清单不该出现假的 spinner。清单本身永远保持模型写下的状态。
 */
type TodoViewState = {
  items: TodoItem[];
  hidden: boolean;
  live: boolean;
  pinned: boolean;
  interrupted: boolean;
  sessionId: string | null;
  turnId: string | null;
};

type TodoTurn = { owner: unknown; sessionId: string | null; turnId: string };
type TodoSessionMarker = { version: 1; turnId: string; completed: boolean };
const RECOVERY_PREFIX = '<mica-todo-recovery>\n';

export class TodoPlugin implements MicaPlugin {
  readonly id = PLUGIN_ID;
  readonly name = 'Built-in Todo';
  readonly required = true;

  setup(ctx: PluginContext): void {
    const fallbackOwner = Symbol('todo.session');
    const captureOwner = (context?: unknown): unknown => ctx.session?.captureOwner?.(context) ?? fallbackOwner;
    const eventOwner = (event: { owner?: unknown }): unknown => event.owner ?? captureOwner();
    const todos = atom(new Map<unknown, TodoViewState>());
    const inputTurns = new WeakMap<object, TodoTurn>();
    const identity = (owner: unknown) => todoSessionForOwner(owner);
    const currentView = (owner: unknown): TodoViewState => {
      const view = todos.get().get(owner);
      const sessionId = identity(owner)?.id ?? null;
      return view && view.sessionId === sessionId ? view : { ...createTodoViewState(), sessionId };
    };
    const patch = (owner: unknown, update: (current: TodoViewState) => TodoViewState) => {
      const views = todos.get();
      const current = currentView(owner);
      const next = update(current);
      if (next !== current || views.get(owner) !== current) todos.set(new Map(views).set(owner, next));
    };

    const saveCheckpoint = (owner: unknown, state: TodoViewState, items: TodoItem[]) => {
      const session = identity(owner);
      if (!session || !session.persistent || !ctx.paths?.config) return;
      if (state.sessionId !== session.id || !state.turnId) throw new Error('Todo turn no longer belongs to this session');
      writeTodoCheckpoint(ctx.paths.config, { version: 1, sessionId: session.id, turnId: state.turnId, items });
    };

    const tool = new TodoWriteTool((items, callbacks) => {
      if (callbacks?.signal?.aborted) throw new Error('Todo turn was interrupted');
      const owner = captureOwner(callbacks?.context);
      const current = currentView(owner);
      // The checkpoint is durable before the tool reports success, even if
      // another tool in the same provider batch is still running.
      saveCheckpoint(owner, current, items);
      patch(owner, (state) => ({ ...state, items, live: true, interrupted: false }));
    });

    function TodoStatusList(): React.ReactNode {
      const views = micaUi.useScheduleState(todos);
      const owner = captureOwner();
      const view = views.get(owner);
      const state = view?.sessionId === (identity(owner)?.id ?? null) ? view : createTodoViewState();
      // 清单只属于一轮：这一轮不在跑、用户也没手动打开时就什么都不显示。
      const panel = resolveTodoPanel(
        { items: state.items, turnId: null },
        { running: state.live, open: state.live || state.pinned, hidden: state.hidden },
      );
      if (!panel.visible) return null;
      const items = panel.items;

      const progress = summarizeTodoProgress(items);
      const status = progress.active ? 'running' : progress.remaining === 0 ? 'completed' : 'pending';
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
                    {progress.completed}/{progress.total}
                  </Text>
                ),
                flexShrink: 0,
              },
              {
                key: 'remaining',
                content: progress.remaining === 0 ? 'all done' : `${progress.remaining} remaining`,
                flexGrow: 1,
                minWidth: 0,
                dimColor: true,
              },
            ]}
          />
          {/* 全部完成时收成一行 `all done`：运行中的最后一步仍有意义；
              真正收起由轮次结束负责（见 resolveTodoPanel）。 */}
          {progress.remaining > 0 && items.map((item) => <TodoRow key={item.id} item={item} />)}
        </Box>
      );
    }

    if (!ctx.tools) throw new Error('todo requires ctx.tools');
    const toolRegistration = ctx.tools.register(tool, { icon: '📝', primaryAgentOnly: true });
    ctx.onDispose(() => toolRegistration.dispose());

    // 计划纪律随插件走：`todo_write` 不在工具表里时，这段指引也不该出现在 prompt 里。
    if (!ctx.prompt) throw new Error('todo requires ctx.prompt');
    const promptSection = ctx.prompt.section({
      id: 'plan',
      order: PROMPT_SECTION_ORDER,
      render: () => buildTodoGuidance(),
    });
    ctx.onDispose(() => promptSection.dispose());

    ctx.ui?.status?.upsert({ id: STATUS_ITEM_ID, component: TodoStatusList });
    ctx.onDispose(() => {
      ctx.ui?.status?.remove(STATUS_ITEM_ID);
    });

    const eventSubscription = ctx.events.on('event', (event) => {
      if (event.type === 'session:cleared' || event.type === 'session:invalidated') {
        const owner = eventOwner(event);
        patch(owner, (current) => ({ ...createTodoViewState(), sessionId: current.sessionId }));
      } else if (event.type === 'session:disposed') {
        const views = new Map(todos.get());
        if (views.delete(eventOwner(event))) todos.set(views);
      } else if (event.type === 'turn:aborted') {
        patch(eventOwner(event), (current) => ({ ...current, live: false, pinned: current.items.length > 0, interrupted: true }));
      }
    });
    ctx.onDispose(() => eventSubscription.dispose());

    // Reread after the host refreshes its session under the turn lease: the
    // owner may now refer to another session or another process's newer turn.
    const turnBeforeSubscription = ctx.hooks.on<RuntimeTurnBeforeHookEvent>(
      'turn:before',
      (event) => {
        const owner = eventOwner(event);
        const session = identity(owner);
        const current = currentView(owner);
        let items = current.interrupted ? current.items : [];
        if (session && ctx.paths?.config && ctx.sessionState) {
          const checkpoint = readTodoCheckpoint(ctx.paths.config, session.id);
          const marker = ctx.sessionState.get<TodoSessionMarker>(owner);
          const completed = marker?.version === 1 && marker.completed === true && marker.turnId === checkpoint?.turnId;
          items = checkpoint && !completed ? checkpoint.items : [];
        }
        const turn: TodoTurn = { owner, sessionId: session?.id ?? null, turnId: randomUUID() };
        const next: TodoViewState = {
          ...current, sessionId: turn.sessionId, turnId: turn.turnId, items,
          live: false, pinned: items.length > 0, interrupted: items.length > 0,
        };
        saveCheckpoint(owner, next, items);
        if (session && ctx.sessionState) {
          ctx.sessionState.set({ version: 1, turnId: turn.turnId, completed: false } satisfies TodoSessionMarker, owner);
        }
        inputTurns.set(event.input, turn);
        patch(owner, () => next);
      },
      { pluginId: ctx.pluginId, failPolicy: 'stop' },
    );
    ctx.onDispose(() => turnBeforeSubscription.dispose());

    // Use the actual request owner and a system message, never the user's
    // content. Responses histories may retain system messages, so remove our
    // previous injection before optionally adding the current one.
    const rewrite = ctx.agent?.onIterationRewrite((messages, agent) => {
      const filtered = messages.filter((message) => !isRecoveryMessage(message));
      const state = currentView(agent.owner);
      const session = identity(agent.owner);
      if (!state.interrupted || state.items.length === 0 ||
          (session && agent.sessionId !== session.id)) return filtered.length === messages.length ? null : filtered;
      const progress = state.items.map((item) => `- [${item.status}] ${item.content}`).join('\n');
      const content = `${RECOVERY_PREFIX}上次任务被中断，以下是中断前最后一次保存的 TODO 进度（进行中不代表已完成）；请结合当前请求判断如何继续：\n${progress}\n</mica-todo-recovery>`;
      const responses = messages.some((message) => Boolean(message && typeof message === 'object' &&
        (message as { type?: unknown }).type === 'message'));
      return [...filtered, responses ? { type: 'message', role: 'system', content } : { role: 'system', content }];
    });
    if (rewrite) ctx.onDispose(() => rewrite.dispose());

    // The marker and completed conversation are saved in the same session
    // snapshot, closing the crash window before turn:after runs.
    const beforePersist = ctx.hooks.on<{ input: object }>('turn:beforePersist', (event) => {
      const turn = inputTurns.get(event.input);
      if (!turn || !turn.sessionId || identity(turn.owner)?.id !== turn.sessionId) return;
      ctx.sessionState?.set({ version: 1, turnId: turn.turnId, completed: true } satisfies TodoSessionMarker, turn.owner);
    }, { pluginId: ctx.pluginId, failPolicy: 'stop' });
    ctx.onDispose(() => beforePersist.dispose());

    const turnAfterSubscription = ctx.hooks.on<RuntimeTurnAfterHookEvent>(
      'turn:after',
      (event) => {
        const turn = inputTurns.get(event.input);
        if (turn && (identity(turn.owner)?.id ?? null) !== turn.sessionId) return;
        // 只收面板，不改数据：`in_progress` 已经不再进行，但也不代表做完了。
        patch(turn?.owner ?? eventOwner(event), (current) => {
          if (turn && current.turnId !== turn.turnId) return current;
          const interrupted = event.outcome !== 'completed';
          const pending = current.items.some((item) => item.status !== 'completed');
          return { ...current, live: false, interrupted, pinned: interrupted ? pending : current.interrupted ? false : current.pinned };
        });
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
        const owner = captureOwner();
        const current = currentView(owner);

        if (!action || action === 'show') {
          patch(owner, (state) => ({ ...state, hidden: false, pinned: true }));
          // 回显必须和面板看到的一致：本轮已结束时 in_progress 已按 pending 呈现，
          // 这里不能再报一份「进行中」的清单。
          const shown = resolveTodoPanel(
            { items: current.items, turnId: null },
            { running: current.live, open: true },
          ).items;
          ctx.ui?.showMessage(shown.length === 0 ? 'Todo list is empty.' : formatTodoSummary(shown));
          return { ok: true };
        }
        if (action === 'hide') {
          patch(owner, (state) => ({ ...state, hidden: true, pinned: false }));
          ctx.ui?.showMessage('Todo list hidden. Use /todo show to restore it.');
          return { ok: true };
        }
        if (action === 'clear') {
          const session = identity(owner);
          if (session?.persistent && ctx.paths?.config) {
            if (current.live && current.turnId) {
              saveCheckpoint(owner, current, []);
            } else {
              const lease = micaSession.acquireTurnLease(session.id);
              if (!lease) {
                ctx.ui?.showMessage('Todo list is in use by another process.');
                return { ok: false, error: 'Todo list is in use by another process.' };
              }
              try {
                const stored = readTodoCheckpoint(ctx.paths.config, session.id);
                if (stored) writeTodoCheckpoint(ctx.paths.config, { ...stored, items: [] });
              } finally {
                lease.release();
              }
            }
          }
          patch(owner, (state) => ({ ...state, items: [] }));
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

function createTodoViewState(): TodoViewState {
  return { items: [], hidden: false, live: false, pinned: false, interrupted: false, sessionId: null, turnId: null };
}

function isRecoveryMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const value = message as { role?: unknown; content?: unknown };
  return value.role === 'system' && typeof value.content === 'string' && value.content.startsWith(RECOVERY_PREFIX);
}

function TodoRow({ item }: { item: TodoItem }): React.ReactNode {
  const marker = item.status === 'completed' ? '✓ ' : item.status === 'in_progress' ? <micaUi.Spin /> : '○ ';
  const content = item.status === 'in_progress' ? (item.activeForm ?? item.content) : item.content;

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

function todoListStatusColor(status: 'running' | 'pending' | 'completed'): string {
  if (status === 'running') return micaUi.theme.colors.info;
  if (status === 'completed') return micaUi.theme.colors.success;
  return micaUi.theme.colors.muted;
}

function todoItemColor(status: TodoStatus): string | undefined {
  if (status === 'in_progress') return micaUi.theme.colors.accent;
  if (status === 'completed') return micaUi.theme.colors.success;
  return undefined;
}
