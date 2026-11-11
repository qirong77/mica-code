import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import type { DataMigration } from './types.js';

/**
 * 笔记评论被移除之后的文档收敛。
 *
 * 评论以前随笔记保存：文档是 `{version, editorState, comments}`，选区的评论锚点是
 * editorState 里由 `@lexical/mark` 包起来的 MarkNode。现在文档只认
 * `{version, editorState}`，旧字段会让 `parseNotebookDocument` 直接判成损坏文档，
 * 所以升级后要把这两处一起洗掉：
 *
 * - `comments` 里的讨论记录不是凭空消失，而是先落到
 *   `plugin-data/evolution/legacy-notebook-comments/<noteId>.json` 再删字段；
 * - MarkNode 拆成原来的子节点，正文与格式不变，只是不再带评论 id。
 *
 * 幂等：已经是新形态的文档没有 comments 也没有 MarkNode，返回 0、不重写文件。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 把评论锚点 MarkNode 换成它的子节点；返回替换次数。 */
function unwrapMarks(value: unknown, counter: { count: number }): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const next = unwrapMarks(item, counter);
      return Array.isArray(next) ? next : [next];
    });
  }
  if (!isRecord(value)) return value;
  if (value.type === 'mark' && Array.isArray(value.ids) && value.ids.length > 0) {
    counter.count += 1;
    return unwrapMarks(Array.isArray(value.children) ? value.children : [], counter);
  }
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) next[key] = unwrapMarks(child, counter);
  return next;
}

function archive(home: string, noteId: string, comments: unknown[]): void {
  const directory = join(home, 'plugin-data', 'evolution', 'legacy-notebook-comments');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const base = join(directory, noteId);
  let target = `${base}.json`;
  for (let index = 2; existsSync(target); index += 1) target = `${base}-${index}.json`;
  writeTextFileAtomic(
    target,
    `${JSON.stringify({ noteId, archivedAt: new Date().toISOString(), comments }, null, 2)}\n`,
  );
}

export const notebookComments: DataMigration = {
  id: 'notebook-comments',
  description: '笔记文档去掉已移除的评论：讨论记录归档到 legacy-notebook-comments，正文里的评论锚点还原成普通文本',
  run({ home }) {
    const directory = join(home, 'plugin-data', 'notebook', 'documents');
    let names: string[];
    try {
      if (!lstatSync(directory).isDirectory()) return 0;
      names = readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    let changed = 0;
    for (const name of names) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(name)) continue;
      const file = join(directory, name);
      const release = acquireProcessLock(`${file}.lock`);
      if (!release) continue;
      try {
        let document: unknown;
        try {
          if (!lstatSync(file).isFile()) continue;
          document = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          // 损坏的文档留给 Notebook 自己的报错路径，迁移不碰。
          continue;
        }
        if (!isRecord(document) || document.version !== 1) continue;
        const noteId = name.slice(0, -5);
        let touched = false;
        const legacyComments = document.comments;
        if (Object.hasOwn(document, 'comments') && !Array.isArray(legacyComments)) {
          // comments 不是数组说明这份文档本就已经损坏：交给 Notebook 的校验报错，迁移不覆盖。
          continue;
        }
        if (Array.isArray(legacyComments)) {
          if (legacyComments.length > 0) archive(home, noteId, legacyComments);
          touched = true;
        }
        const next: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(document)) {
          if (key !== 'comments') next[key] = value;
        }
        if (typeof next.editorState === 'string') {
          const counter = { count: 0 };
          try {
            const state = unwrapMarks(JSON.parse(next.editorState), counter);
            if (counter.count > 0) {
              next.editorState = JSON.stringify(state);
              touched = true;
            }
          } catch {
            // editorState 不是合法 JSON：保留原值，交给 Notebook 的校验报错。
          }
        }
        if (!touched) continue;
        writeTextFileAtomic(file, `${JSON.stringify(next)}\n`);
        changed += 1;
      } finally {
        release();
      }
    }
    return changed;
  },
};
