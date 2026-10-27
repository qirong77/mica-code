import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import type { MicaPlugin, PluginContext } from '@packages/mica-plugin/index.js';
import type { RuntimeTurnAfterHookEvent } from '@packages/mica-runtime/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import {
  formatTodoSummary,
  resolveTodoDisplayItems,
  shouldShowTodoList,
  summarizeTodoProgress,
  type TodoItem,
  type TodoStatus,
} from '@packages/mica-common/todoState.js';
import { TodoWriteTool } from './TodoTool.js';

export { formatTodoSummary, parseTodoInput, shouldShowTodoList } from '@packages/mica-common/todoState.js';
export type { TodoItem, TodoStatus } from '@packages/mica-common/todoState.js';

const PLUGIN_ID = 'todo';
const STATUS_ITEM_ID = 'todo.list';
const TODO_KIND = '📝(todo)';
const TODO_KIND_WIDTH = 12;
const TODO_STATUS_WIDTH = 10;
const TODO_ITEM_INDENT = '     ⎿  ';

/**
 * 面板状态。
 *
 * 只有一份：`todo_write` 是 `primaryAgentOnly`，子代理与 btw 都调不到它，所以
 * 「按 owner 分清单」从来只会有一个 key，纯粹是多余的分支。真正的隔离来自
 * 会话边界（`session:cleared` / `session:invalidated` 清空）。
 *
 * `live` 表示「这一轮还在跑」。它不是数据的一部分，只决定 `in_progress` 怎么显示——
 * 清单本身永远保持模型写下的状态。
 */
type TodoViewState = {
  items: TodoItem[];
  hidden: boolean;
  live: boolean;
};

export class TodoPlugin implements MicaPlugin {
  readonly id = PLUGIN_ID;
  readonly name = 'Built-in Todo';
  readonly required = true;

  setup(ctx: PluginContext): void {
    const todos = atom<TodoViewState>(createTodoViewState());
    const patch = (update: (current: TodoViewState) => TodoViewState) => {
      const current = todos.get();
      const next = update(current);
      if (next !== current) todos.set(next);
    };

    const tool = new TodoWriteTool((items) => {
      patch((current) => ({ ...current, items, live: true }));
    });

    function TodoStatusList(): React.ReactNode {
      const state = micaUi.useScheduleState(todos);
      const items = resolveTodoDisplayItems({ items: state.items, turnId: null }, { running: state.live });
      if (!shouldShowTodoList(items, { hidden: state.hidden })) return null;

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
          {/* 全部完成时收成一行：清单留在屏幕上作为「这一轮做了什么」的记录，
              而不是在完成的瞬间消失。 */}
          {progress.remaining > 0 && items.map((item) => <TodoRow key={item.id} item={item} />)}
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
      if (event.type === 'session:cleared' || event.type === 'session:invalidated') {
        todos.set(createTodoViewState());
      } else if (event.type === 'turn:aborted') {
        patch((current) => ({ ...current, live: false }));
      }
    });
    ctx.onDispose(() => eventSubscription.dispose());

    const turnAfterSubscription = ctx.hooks.on<RuntimeTurnAfterHookEvent>(
      'turn:after',
      () => {
        // 只把「本轮已结束」反映到展示上：`in_progress` 会以 pending 呈现，因为
        // 已经没有东西还在进行。清单本身不写回——turn 正常结束不代表剩余项做完了。
        patch((current) => ({ ...current, live: false }));
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
        const current = todos.get();

        if (!action || action === 'show') {
          patch((state) => ({ ...state, hidden: false, live: true }));
          ctx.ui?.showMessage(
            current.items.length === 0 ? 'Todo list is empty.' : formatTodoSummary(current.items),
          );
          return { ok: true };
        }
        if (action === 'hide') {
          patch((state) => ({ ...state, hidden: true }));
          ctx.ui?.showMessage('Todo list hidden. Use /todo show to restore it.');
          return { ok: true };
        }
        if (action === 'clear') {
          patch((state) => ({ ...state, items: [] }));
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
  return { items: [], hidden: false, live: false };
}

function TodoRow({ item }: { item: TodoItem }): React.ReactNode {
  const marker = item.status === 'completed' ? '✓ ' : item.status === 'in_progress' ? <micaUi.Spin /> : '○ ';
  const content = item.status === 'in_progress' ? item.activeForm ?? item.content : item.content;

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
