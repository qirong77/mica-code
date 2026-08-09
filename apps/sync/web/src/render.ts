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

const PERSISTED_KINDS: ReadonlySet<UiMessage['kind']> = new Set(['user', 'assistant', 'notice']);
const LIVE_KINDS: ReadonlySet<UiMessage['kind']> = new Set(['thinking', 'tool']);
const MAX_THINKING_CHARS = 40_000;
const THINKING_TRUNCATION_MARKER = '[thinking display truncated]\n';

/**
 * Merges live-only messages (thinking blocks / tool cards) into an
 * authoritative snapshot list. The persisted snapshot only carries
 * user/assistant/notice messages, so without this merge streamed thinking and
 * tool messages would vanish on every snapshot refresh (turn end / polling),
 * which reads as flickering during a remote run.
 *
 * Live messages are anchored to the persisted message they follow in the
 * current stream by ordinal position; snapshot messages are authoritative and
 * keep their order.
 */
export function mergeSessionMessages(current: UiMessage[], base: UiMessage[]): UiMessage[] {
  if (base.length === 0) return current;
  const kept = current.filter((message) => LIVE_KINDS.has(message.kind));
  if (kept.length === 0) return base;

  // The i-th persisted-kind message in `current` aligns with the i-th message
  // in `base` (clamped so a fresher snapshot never overflows).
  const baseSlots: number[] = [];
  let persistedSeen = 0;
  for (const message of current) {
    if (PERSISTED_KINDS.has(message.kind)) {
      baseSlots.push(Math.min(persistedSeen, base.length - 1));
      persistedSeen += 1;
    }
  }
  const lastSlot = baseSlots.length > 0 ? baseSlots[baseSlots.length - 1] : -1;

  // Group live messages by the base index they should be inserted after.
  const insertAfter = new Map<number, UiMessage[]>();
  let currentPersistedIndex = -1;
  for (const message of current) {
    if (PERSISTED_KINDS.has(message.kind)) {
      currentPersistedIndex += 1;
    } else if (LIVE_KINDS.has(message.kind)) {
      const at =
        currentPersistedIndex >= 0
          ? baseSlots[Math.min(currentPersistedIndex, baseSlots.length - 1)]
          : -1;
      const group = insertAfter.get(at) ?? [];
      group.push(message);
      insertAfter.set(at, group);
    }
  }

  const result: UiMessage[] = [];
  for (let index = 0; index < base.length; index += 1) {
    const lead = insertAfter.get(index - 1);
    if (lead) result.push(...lead);
    result.push(base[index]);
  }
  const tail = insertAfter.get(lastSlot);
  if (tail) result.push(...tail);
  return result;
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
      const delta = String(event.text ?? '');
      if (!delta) return next;
      const last = next.at(-1);
      if (last?.kind === 'thinking') {
        // Provider streams reasoning as incremental deltas; append instead of
        // replacing so the block shows the full segment, not the last chunk.
        next[next.length - 1] = { ...last, text: appendBoundedText(last.text, delta) };
      } else {
        next.push({
          kind: 'thinking',
          id: makeId('thinking', next.length),
          text: appendBoundedText('', delta),
          ts: Number(event.ts ?? Date.now()),
        });
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

function appendBoundedText(previous: string, chunk: string): string {
  const next = `${previous}${chunk}`;
  if (next.length <= MAX_THINKING_CHARS) return next;
  const body = next.startsWith(THINKING_TRUNCATION_MARKER) ? next.slice(THINKING_TRUNCATION_MARKER.length) : next;
  return `${THINKING_TRUNCATION_MARKER}${body.slice(-(MAX_THINKING_CHARS - THINKING_TRUNCATION_MARKER.length))}`;
}
