import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SubagentToolCall, SubagentTurn } from './transcript.js';

/**
 * 接管一条已有会话时的历史来源。
 *
 * resume 不发通知：子进程把它自己的历史从会话文件加载进上下文，而父会话这边看到的
 * 通知流是**空的**。不补这一层，`subagent_open` 之后 `subagent_read` 的 turns /
 * transcript 视图会告诉你「还没有任何一轮对话」——而它明明已经干了半小时。
 *
 * 读的是落盘的一份 `$MICA_HOME/sessions/<id>.json`：只有 UI 视角的消息（用户说了什么、
 * 助手回了什么），工具调用只能拿到名字。这已经够回答「它之前做到哪了」，而完整原文
 * 在子会话自己的上下文里——我们只是不假装自己有那份事件流。
 */

export type SessionHistory = {
  id: string;
  title: string;
  cwd: string;
  turns: SubagentTurn[];
  /** 文件里一共有多少轮（`turns` 只留最近的若干轮）。 */
  totalTurns: number;
};

/** 与 `transcript` 的保留窗口一致：接管不是把整份历史搬进内存。 */
const MAX_SEED_TURNS = 20;
const MAX_SEED_TEXT = 8_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    // `text` 是正文；`tool_use` 只有名字可用（参数在 provider history 里，不在 UI 消息里）。
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text);
  }
  return parts.join('\n');
}

function toolNamesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record || record.type !== 'tool_use') continue;
    const name = typeof record.name === 'string' ? record.name : '';
    if (name) names.push(name);
  }
  return names;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[接管时只保留前 ${limit} 字符]`;
}

/**
 * 把落盘的 UI 消息折成轮次：一条用户消息开一轮，其后的助手正文并进这一轮。
 *
 * 时间戳是 0 而不是「现在」：这些轮次发生在这次接管之前，`views` 遇到 0 会显示 `—`，
 * 而不是骗人地显示一个「刚开始」的时刻。
 */
export function turnsFromMessages(messages: unknown[]): SubagentTurn[] {
  const turns: SubagentTurn[] = [];
  let current: SubagentTurn | null = null;
  const push = (input: string): SubagentTurn => {
    const turn: SubagentTurn = {
      id: `history-${turns.length + 1}`,
      status: 'completed',
      text: '',
      thinking: '',
      tools: [],
      userInputs: input ? [{ id: turns.length + 1, text: clip(input, MAX_SEED_TEXT) }] : [],
      startedAt: 0,
      finishedAt: 0,
    };
    turns.push(turn);
    return turn;
  };
  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) continue;
    const role = message.role;
    if (role === 'user') {
      current = push(textOf(message.content));
      continue;
    }
    if (role === 'assistant') {
      const turn: SubagentTurn = current ?? push('');
      current = turn;
      const text = textOf(message.content);
      if (text) turn.text = clip(turn.text ? `${turn.text}\n${text}` : text, MAX_SEED_TEXT);
      for (const name of toolNamesOf(message.content)) {
        const tool: SubagentToolCall = { id: `${turn.id}-tool-${turn.tools.length + 1}`, title: name, status: 'completed' };
        turn.tools.push(tool);
      }
      continue;
    }
    // notice 是界面提示（插件通知、命令面板），不属于对话：接管时也没必要重放。
  }
  return turns;
}

/** 读一条已落盘会话的历史；文件不存在或读不动时返回 null（调用方据此报「接不到」）。 */
export function readSessionHistory(sessionId: string, sessionsDir: string): SessionHistory | null {
  const path = join(sessionsDir, `${sessionId}.json`);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  const session = asRecord(parsed);
  if (!session) return null;
  const snapshot = asRecord(session.snapshot);
  const messages = Array.isArray(snapshot?.conversationMessages) ? snapshot.conversationMessages : [];
  const all = turnsFromMessages(messages);
  return {
    id: typeof session.id === 'string' ? session.id : sessionId,
    title: typeof session.title === 'string' && session.title.trim() ? session.title : '已接管的会话',
    cwd: typeof session.cwd === 'string' ? session.cwd : '',
    turns: all.slice(-MAX_SEED_TURNS),
    totalTurns: all.length,
  };
}
