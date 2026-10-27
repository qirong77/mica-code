import {
  MAX_TODOS,
  MAX_TODO_TEXT_LENGTH,
  RECOMMENDED_TODO_ITEMS,
  TODO_TOOL_NAME,
  appendTodoNotes,
  formatTodoSummary,
  parseTodoInput,
} from '@packages/mica-common/todoState.js';
import type { TodoItem } from '@packages/mica-common/todoState.js';
import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';

export { formatTodoSummary, parseTodoInput } from '@packages/mica-common/todoState.js';
export type { TodoItem, TodoStatus } from '@packages/mica-common/todoState.js';

/**
 * `todo_write`：把本轮计划写成条目，替换上一份清单。
 *
 * 语义刻意定得窄——约束全部放在 schema 与工具描述里，执行期只做归一化：
 * 未知字段忽略、多余的 `in_progress` 降级、超长截断。拒绝一整个调用会让模型白跑
 * 一轮并消耗一次上下文，换来的只是「格式干净」，不划算。
 */
export class TodoWriteTool extends MicaTool {
  constructor(private readonly replace: (items: TodoItem[]) => void = () => undefined) {
    super(
      TODO_TOOL_NAME,
      [
        'Create or update the plan for the current turn. The user sees it as your working plan.',
        `Use it when the task needs 3+ meaningful milestones; skip it for trivial or single-step work. Keep ${RECOMMENDED_TODO_ITEMS} items or fewer.`,
        'Describe outcomes, not keystrokes: no "open file X" or "run command Y" items.',
        'Send the complete list on every call; it replaces the previous one. Only call it when the list actually changes.',
        'Mark an item in_progress when you start it, and completed only when it is really done.',
      ].join(' '),
      {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The complete replacement list, in execution order.',
            maxItems: MAX_TODOS,
            items: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  maxLength: MAX_TODO_TEXT_LENGTH,
                  description: 'Imperative label, for example "Run tests".',
                },
                activeForm: {
                  type: 'string',
                  maxLength: MAX_TODO_TEXT_LENGTH,
                  description:
                    'Optional present-progressive label shown while the item runs, for example "Running tests". Omit it to reuse content.',
                },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                id: {
                  type: 'string',
                  maxLength: MAX_TODO_TEXT_LENGTH,
                  description: 'Optional stable id. Omit it to derive one from content.',
                },
              },
              required: ['content', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['todos'],
        additionalProperties: false,
      },
    );
  }

  async execute(input: ToolInput, _callbacks?: ToolExecuteCallbacks): Promise<string> {
    const parsed = parseTodoInput(input);
    if (!parsed.ok) throw new Error(parsed.message);

    this.replace(parsed.items);
    return appendTodoNotes(formatTodoSummary(parsed.items), parsed.notes);
  }

  onToolUseDisplayText(input: ToolInput): string {
    const count = Array.isArray(input.todos) ? input.todos.length : 0;
    return count === 0 ? 'Clearing todo list' : `Updating todo list (${count})`;
  }
}
