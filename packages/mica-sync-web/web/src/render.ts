import type { SyncEvent } from './api';

export type UiMessage =
  | { kind: 'user'; id: string; text: string; ts: number }
  | { kind: 'assistant'; id: string; text: string; ts: number; usage?: unknown; stopReason?: string }
  | {
      kind: 'tool';
      id: string;
      toolId: string | null;
      name: string;
      args: string;
      state: 'running' | 'done' | 'error';
      result?: string;
      ts: number;
    }
  | { kind: 'thinking'; id: string; text: string; ts: number }
  | { kind: 'notice'; id: string; text: string; ts: number; variant?: 'error' };

type ContentBlock = { type?: string; text?: string };

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const record = block as ContentBlock;
        return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
      })
      .join('');
  }
  return '';
}

/** Converts persisted Mica conversation messages into renderable UI messages. */
export function messagesFromSession(conversationMessages: unknown[] | undefined): UiMessage[] {
  if (!Array.isArray(conversationMessages)) return [];
  const result: UiMessage[] = [];
  for (const raw of conversationMessages) {
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as { role?: string; content?: unknown; displayContent?: unknown; variant?: string };
    const text = extractText(message.content);
    if (!text) continue;
    const ts = Date.now();
    if (message.role === 'user') {
      result.push({ kind: 'user', id: `user-${result.length}`, text, ts });
    } else if (message.role === 'assistant') {
      result.push({ kind: 'assistant', id: `assistant-${result.length}`, text, ts });
    } else if (message.role === 'notice') {
      result.push({
        kind: 'notice',
        id: `notice-${result.length}`,
        text,
        ts,
        variant: message.variant === 'error' ? 'error' : undefined,
      });
    }
  }
  return result;
}

function makeId(prefix: string, seed: number): string {
  return `${prefix}-${seed}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Applies a live sync event to the message list (idempotent where possible). */
export function applyEvent(messages: UiMessage[], event: SyncEvent): UiMessage[] {
  const next = messages.slice();

  switch (event.type) {
    case 'user_input': {
      const text = String(event.text ?? '');
      const last = next.at(-1);
      if (last?.kind === 'user' && last.text === text) return next;
      next.push({ kind: 'user', id: makeId('user', next.length), text, ts: Number(event.ts ?? Date.now()) });
      break;
    }
    case 'text_delta': {
      const delta = String(event.text ?? '');
      if (!delta) return next;
      const last = next.at(-1);
      if (last?.kind === 'assistant') {
        next[next.length - 1] = { ...last, text: last.text + delta };
      } else {
        next.push({
          kind: 'assistant',
          id: makeId('assistant', next.length),
          text: delta,
          ts: Number(event.ts ?? Date.now()),
        });
      }
      break;
    }
    case 'thinking': {
      const text = String(event.text ?? '');
      if (!text) return next;
      const last = next.at(-1);
      if (last?.kind === 'thinking') {
        next[next.length - 1] = { ...last, text };
      } else {
        next.push({ kind: 'thinking', id: makeId('thinking', next.length), text, ts: Number(event.ts ?? Date.now()) });
      }
      break;
    }
    case 'tool_call': {
      const toolId = event.toolId === null || event.toolId === undefined ? null : String(event.toolId);
      if (next.some((message) => message.kind === 'tool' && message.toolId === toolId && toolId !== null)) return next;
      next.push({
        kind: 'tool',
        id: makeId('tool', next.length),
        toolId,
        name: String(event.name ?? 'tool'),
        args: String(event.args ?? ''),
        state: 'running',
        ts: Number(event.ts ?? Date.now()),
      });
      break;
    }
    case 'tool_result': {
      const toolId = event.toolId === null || event.toolId === undefined ? null : String(event.toolId);
      const index = next.findIndex((message) => message.kind === 'tool' && message.toolId === toolId);
      const record = { name: String(event.name ?? 'tool'), ok: event.ok !== false, result: String(event.result ?? '') };
      if (index >= 0) {
        const message = next[index];
        if (message.kind === 'tool') {
          next[index] = {
            ...message,
            state: record.ok ? 'done' : 'error',
            result: record.result,
          };
        }
      } else {
        next.push({
          kind: 'tool',
          id: makeId('tool', next.length),
          toolId,
          name: record.name,
          args: '',
          state: record.ok ? 'done' : 'error',
          result: record.result,
          ts: Number(event.ts ?? Date.now()),
        });
      }
      break;
    }
    case 'run_rejected': {
      next.push({
        kind: 'notice',
        id: makeId('notice', next.length),
        text: String(event.message ?? '请求被拒绝'),
        ts: Number(event.ts ?? Date.now()),
        variant: 'error',
      });
      break;
    }
    case 'turn': {
      if (event.state === 'error') {
        next.push({
          kind: 'notice',
          id: makeId('notice', next.length),
          text: String(event.error ?? '运行出错'),
          ts: Number(event.ts ?? Date.now()),
          variant: 'error',
        });
      }
      break;
    }
    default:
      break;
  }
  return next;
}
