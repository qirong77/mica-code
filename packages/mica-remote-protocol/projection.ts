import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { readSessionFileHead } from '@packages/mica-session/sessionFileHead.js';
import { opaqueRef } from './ids.js';
import { REMOTE_LIMITS, truncateUtf8, utf8Bytes } from './limits.js';
import type { HistoryMessage, HistoryPage, RemoteSessionSummary, RemoteWorkspaceSummary } from './protocol.js';
import { parseSessionHead, safeSessionAlias, type LocalSessionSummary } from './sessionHead.js';

export function workspaceRefFor(path: string): string {
  return opaqueRef('workspace', resolve(path));
}

export function sessionRefFor(workspaceRef: string, sessionId: string): string {
  return opaqueRef('session', workspaceRef, sessionId);
}

export function listLocalSessions(sessionDir: string): LocalSessionSummary[] {
  const sessions: LocalSessionSummary[] = [];
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return sessions;
  }
  for (const file of entries) {
    if (!file.endsWith('.json') || file === 'index.json' || file === 'session-index.json') continue;
    const path = join(sessionDir, file);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      const summary = parseSessionHead(readSessionFileHead(path), path);
      if (summary) sessions.push(summary);
    } catch {
      // A session being written or removed between readdir and read is skipped.
    }
  }
  return sessions;
}

export function isSessionInWorkspace(summary: LocalSessionSummary, workspacePath: string): boolean {
  if (!summary.cwd) return false;
  const root = resolve(workspacePath);
  const cwd = resolve(summary.cwd);
  return cwd === root || cwd.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * A session file can say `running` after its process was killed. Only a live
 * turn lease proves that someone is actually executing this session now.
 */
export function reconcileTurnState(
  summary: LocalSessionSummary,
  liveSessionIds: ReadonlySet<string>,
): LocalSessionSummary {
  if (summary.turnState !== 'running' || liveSessionIds.has(summary.sessionId)) return summary;
  return { ...summary, turnState: 'unknown' };
}

export function buildWorkspaceSummary(args: {
  workspacePath: string;
  alias: string;
  sessions: LocalSessionSummary[];
}): { summary: RemoteWorkspaceSummary; sessionMap: Map<string, LocalSessionSummary> } {
  const workspaceRef = workspaceRefFor(args.workspacePath);
  const sessionMap = new Map<string, LocalSessionSummary>();
  const sessions: RemoteSessionSummary[] = [];
  const scoped = args.sessions
    .filter((session) => isSessionInWorkspace(session, args.workspacePath))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, REMOTE_LIMITS.maxSessionsPerWorkspace);
  for (const session of scoped) {
    const sessionRef = sessionRefFor(workspaceRef, session.sessionId);
    const alias = safeSessionAlias(session);
    sessionMap.set(sessionRef, session);
    sessions.push({
      sessionRef,
      ...(alias ? { alias } : {}),
      updatedAt: session.updatedAt,
      turnState: session.turnState,
    });
  }
  return {
    summary: {
      workspaceRef,
      alias: args.alias,
      sessions,
    },
    sessionMap,
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (typeof record.text === 'string') parts.push(record.text);
    else if (typeof record.refusal === 'string') parts.push(record.refusal);
    else if (record.type === 'image' || record.type === 'image_url') parts.push('[图片]');
    // Thinking and tool-call blocks stay on the machine.
  }
  return parts.join('\n');
}

type RawMessage = { role: 'user' | 'assistant'; text: string };

export function projectConversation(raw: unknown): RawMessage[] {
  if (!raw || typeof raw !== 'object') return [];
  const snapshot = (raw as { snapshot?: unknown }).snapshot;
  if (!snapshot || typeof snapshot !== 'object') return [];
  const messages = (snapshot as { conversationMessages?: unknown }).conversationMessages;
  if (!Array.isArray(messages)) return [];
  const projected: RawMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'user' && record.role !== 'assistant') continue;
    const text = textFromContent(record.content)
      .replace(/\u0000/g, '')
      .trim();
    if (!text) continue;
    projected.push({ role: record.role, text });
  }
  return projected;
}

/**
 * Build one page from the end of the conversation.
 *
 * `cursor` counts how many newest messages the controller already has, so the
 * next page continues backwards. Messages that do not fit the byte budget are
 * clipped rather than dropped silently; older ones are left for `nextCursor`.
 */
export function projectHistoryPage(args: {
  raw: unknown;
  sessionRef: string;
  revision: string;
  cursor?: number;
  limit?: number;
  maxBytes?: number;
  now?: Date;
}): HistoryPage {
  const maxBytes = args.maxBytes ?? REMOTE_LIMITS.maxHistoryPageBytes;
  const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
  const all = projectConversation(args.raw);
  const delivered = Math.max(0, Math.min(args.cursor ?? 0, all.length));
  const end = all.length - delivered;
  const start = Math.max(0, end - limit);
  const picked: HistoryMessage[] = [];
  let used = 0;
  let truncated = false;
  let oldestIncluded = end;
  for (let index = end - 1; index >= start; index--) {
    const message = all[index]!;
    const remaining = maxBytes - used;
    if (remaining <= 64) break;
    const clipped = truncateUtf8(message.text, Math.min(remaining - 64, maxBytes));
    if (clipped.text.length === 0) break;
    if (clipped.truncated) truncated = true;
    const entry: HistoryMessage = {
      role: message.role,
      text: clipped.text,
      ...(clipped.truncated ? { truncated: true as const } : {}),
    };
    const size = utf8Bytes(JSON.stringify(entry));
    picked.unshift(entry);
    used += size;
    oldestIncluded = index;
  }
  return {
    sessionRef: args.sessionRef,
    revision: args.revision,
    messages: picked,
    nextCursor: oldestIncluded > 0 ? String(all.length - oldestIncluded) : null,
    truncated,
    source: 'live',
    asOf: (args.now ?? new Date()).toISOString(),
  };
}

export function sessionRevision(stat: { mtimeMs: number; size: number }, sessionId: string): string {
  return opaqueRef('revision', sessionId, String(Math.trunc(stat.mtimeMs)), String(stat.size));
}

export function relativeWorkspacePath(workspace: string, target: string): string | null {
  const rel = relative(resolve(workspace), resolve(target));
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) return null;
  return rel;
}
