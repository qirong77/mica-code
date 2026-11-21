import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import type { DataMigration } from './types.js';

/**
 * React + Arco 交互块从 HTML 节点里拆出来，成为独立的 `component` 节点。
 *
 * 以前两类块共用一个 `html` 节点，靠 `runtime: 'react' | 'html'` 区分；现在
 * `html` 节点只存静态 HTML（`html` 字段），交互块是 `component` 节点（`code`
 * 字段）。运行时不认旧形态，升级后要把笔记文档洗一遍：
 *
 * - `type: 'html'` + `runtime: 'react'` → `type: 'component'`，`html` 改名 `code`；
 * - `type: 'html'` + `runtime: 'html'` → 去掉 `runtime`（其余不动）。
 *
 * 只搬家、不改内容：块里的源码、高度、格式原样保留。幂等：已经是新形态的文档
 * 不再有 `runtime` 字段，返回 0、不重写文件。损坏文档与非 `version: 1` 文档不动，
 * 交给 Notebook 自己的校验报错。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 深度遍历，把旧 html 节点就地改成当前形态；返回改动的节点数。 */
function migrateNodes(value: unknown): number {
  if (Array.isArray(value)) {
    let changed = 0;
    for (const item of value) changed += migrateNodes(item);
    return changed;
  }
  if (!isRecord(value)) return 0;
  let changed = 0;
  if (value.type === 'html' && Object.hasOwn(value, 'runtime')) {
    const runtime = value.runtime;
    delete value.runtime;
    changed += 1;
    if (runtime === 'react') {
      const code = typeof value.html === 'string' ? value.html : '';
      delete value.html;
      value.type = 'component';
      value.code = code;
    }
  }
  for (const child of Object.values(value)) changed += migrateNodes(child);
  return changed;
}

export const notebookComponentBlocks: DataMigration = {
  id: 'notebook-component-blocks',
  description:
    '笔记文档里的 React + Arco 交互块从 html 节点（runtime: react）迁成独立的 component 节点，静态 HTML 节点去掉 runtime 字段',
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
      if (!existsSync(file)) continue;
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
        if (typeof document.editorState !== 'string') continue;
        let state: unknown;
        try {
          state = JSON.parse(document.editorState);
        } catch {
          // editorState 不是合法 JSON：保留原值，交给 Notebook 的校验报错。
          continue;
        }
        if (migrateNodes(state) === 0) continue;
        document.editorState = JSON.stringify(state);
        writeTextFileAtomic(file, `${JSON.stringify(document)}\n`);
        changed += 1;
      } finally {
        release();
      }
    }
    return changed;
  },
};
