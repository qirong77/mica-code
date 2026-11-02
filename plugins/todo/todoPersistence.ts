import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTodoInput, type TodoItem } from '@packages/mica-common/todoState.js';

export type StoredTodo = { version: 1; sessionId: string; turnId: string; items: TodoItem[] };

/** Never turn an untrusted session id into a path outside the checkpoint directory. */
export function todoCheckpointPath(configDir: string, sessionId: string): string | null {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(sessionId) || sessionId.includes('..')) return null;
  return join(configDir, 'todo-checkpoints', `${sessionId}.json`);
}

export function readTodoCheckpoint(configDir: string, sessionId: string): StoredTodo | null {
  const path = todoCheckpointPath(configDir, sessionId);
  if (!path) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  // A corrupt or foreign checkpoint cannot be trusted as this session's plan.
  if (text.length > 64 * 1024) return null;
  try {
    const value = JSON.parse(text) as Partial<StoredTodo> | null;
    if (!value || value.version !== 1 || value.sessionId !== sessionId ||
        typeof value.turnId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value.turnId)) return null;
    const parsed = parseTodoInput({ todos: value.items });
    return parsed.ok ? { version: 1, sessionId, turnId: value.turnId, items: parsed.items } : null;
  } catch {
    return null;
  }
}

/** Call only while holding the session's turn lease. A successful write is atomic. */
export function writeTodoCheckpoint(configDir: string, checkpoint: StoredTodo): void {
  const path = todoCheckpointPath(configDir, checkpoint.sessionId);
  if (!path) throw new Error('Invalid session id for todo checkpoint');
  mkdirSync(join(configDir, 'todo-checkpoints'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(checkpoint), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
