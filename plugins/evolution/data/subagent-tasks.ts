import { randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isStoredSubagentTask, isValidSubagentSessionId } from '@packages/mica-common/subagentState.js';
import type { DataMigration } from './types.js';

/** Publish each old task once; an existing per-task update is authoritative. */
export const subagentTaskFiles: DataMigration = {
  id: 'subagent-task-files',
  description: '将旧子代理任务数组拆成每任务独立文件，保留已有更新并归档原文件',
  run(context) {
    const root = join(context.home, 'subagent-tasks');
    const rootInfo = info(root);
    if (!rootInfo?.isDirectory()) return 0;
    let changed = 0;
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.json') || !isValidSubagentSessionId(name.slice(0, -5))) continue;
      const source = join(root, name);
      try {
        if (!info(source)?.isFile()) continue;
        const tasks: unknown = JSON.parse(readFileSync(source, 'utf8'));
        if (!Array.isArray(tasks) || !tasks.every(isStoredSubagentTask)) {
          throw new Error('Invalid legacy subagent task array.');
        }
        const directory = join(root, name.slice(0, -5));
        mkdirSync(directory, { recursive: true });
        if (!lstatSync(directory).isDirectory()) throw new Error('Invalid subagent task directory.');
        // The old reader used the last record for a duplicate id.
        const records = new Map(tasks.map((task) => [task.id, task]));
        for (const [id, task] of records) {
          const target = join(directory, `${id}.json`);
          const targetInfo = info(target);
          if (targetInfo) {
            validateCurrentTask(target, id);
            continue;
          }
          const candidate = join(directory, `.${id}.${randomUUID()}.tmp`);
          writeFileSync(candidate, JSON.stringify(task), { flag: 'wx', mode: 0o600 });
          try {
            // link publishes a complete record atomically without replacing a
            // task the current runtime may have written since the existence check.
            try {
              linkSync(candidate, target);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              validateCurrentTask(target, id);
            }
          } finally {
            unlinkSync(candidate);
          }
        }
        for (let suffix = 0; ; suffix++) {
          const archive = join(root, `${name.slice(0, -5)}.legacy-v1${suffix ? `.${suffix}` : ''}.json`);
          try {
            linkSync(source, archive);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
        }
        unlinkSync(source);
        changed += 1;
      } catch (error) {
        context.log('evolution:subagent-tasks-failed', {
          file: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return changed;
  },
};

function validateCurrentTask(path: string, id: string): void {
  const current: unknown = info(path)?.isFile() ? JSON.parse(readFileSync(path, 'utf8')) : null;
  if (!isStoredSubagentTask(current) || current.id !== id) throw new Error(`Invalid existing subagent task: ${id}`);
}

function info(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
