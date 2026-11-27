import { readHeadString } from '@packages/mica-session/sessionFileHead.js';

/** Fields a relay may see about one session. Paths and auto titles stay local. */
export type LocalSessionSummary = {
  sessionId: string;
  path: string;
  title?: string;
  titleSource?: string;
  updatedAt: string;
  turnState: string;
  cwd?: string;
};

/** Relay-safe alias: only a manual title is user-chosen text. */
export function safeSessionAlias(summary: Pick<LocalSessionSummary, 'title' | 'titleSource'>): string | undefined {
  if (summary.titleSource !== 'manual') return undefined;
  const title = summary.title?.trim();
  if (!title) return undefined;
  return title.slice(0, 120);
}

export function parseSessionHead(head: string, path: string): LocalSessionSummary | null {
  const sessionId = readHeadString(head, 'id');
  const updatedAt = readHeadString(head, 'updatedAt');
  if (!sessionId || !updatedAt) return null;
  return {
    sessionId,
    path,
    title: readHeadString(head, 'title'),
    titleSource: readHeadString(head, 'titleSource'),
    updatedAt,
    turnState: readHeadString(head, 'turnState') ?? 'unknown',
    cwd: readHeadString(head, 'cwd'),
  };
}
