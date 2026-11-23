import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { archivePrivateOriginal, hasDataDirectory, readBoundedPrivateFile, replacePrivateFile } from './private-files.js';
import type { DataMigration } from './types.js';

/**
 * 绘图和日期节点已经从编辑器中移除，不能让运行时继续背着旧节点解析分支。
 * 迁移把它们改成普通文本：日期保留用户看见的日期，绘图保留一个明确的占位提示。
 * 迁移前私有归档原文，避免丢失无法转换的绘图数据；运行时不读取归档。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textNode(text: string, source: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'text',
    detail: typeof source.detail === 'number' ? source.detail : 0,
    format: typeof source.format === 'number' ? source.format : 0,
    mode: typeof source.mode === 'string' ? source.mode : 'normal',
    style: typeof source.style === 'string' ? source.style : '',
    text,
    version: 1,
  };
}

function paragraphWithText(text: Record<string, unknown>): Record<string, unknown> {
  return { children: [text], direction: null, format: '', indent: 0, type: 'paragraph', version: 1 };
}

function dateText(value: unknown): string {
  if (typeof value !== 'string') return '日期内容已移除';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '日期内容已移除';
  const hours = date.getHours();
  const minutes = date.getMinutes();
  return date.toDateString() + (hours === 0 && minutes === 0
    ? ''
    : ` ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`);
}

function migrateNodes(value: unknown, parentType: string | null): { value: unknown; changed: number } {
  if (Array.isArray(value)) {
    let changed = 0;
    const next = value.map((item) => {
      const migrated = migrateNodes(item, parentType);
      changed += migrated.changed;
      return migrated.value;
    });
    return { value: next, changed };
  }
  if (!isRecord(value)) return { value, changed: 0 };

  if (value.type === 'datetime') {
    const text = textNode(dateText(value.dateTime), value);
    return parentType === 'root' ? { value: paragraphWithText(text), changed: 1 } : { value: text, changed: 1 };
  }
  if (value.type === 'excalidraw') {
    const marker = textNode('绘图内容已移除', value);
    return parentType === 'root' ? { value: paragraphWithText(marker), changed: 1 } : { value: marker, changed: 1 };
  }

  let changed = 0;
  for (const [key, child] of Object.entries(value)) {
    const migrated = migrateNodes(child, typeof value.type === 'string' ? value.type : parentType);
    value[key] = migrated.value;
    changed += migrated.changed;
  }
  return { value, changed };
}

export const notebookRemovedFeatures: DataMigration = {
  id: 'notebook-removed-features',
  description: '将笔记正文中的旧绘图和日期节点转换为普通文本，清除已移除的节点类型',
  run({ home }) {
    const directory = join(home, 'plugin-data', 'notebook', 'documents');
    let names: string[];
    try {
      if (!hasDataDirectory(home, 'plugin-data', 'notebook', 'documents')) return 0;
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
        let original: Buffer | null;
        try {
          if (!lstatSync(file).isFile()) continue;
          original = readBoundedPrivateFile(file, 32 * 1024 * 1024);
          if (!original) continue;
          document = JSON.parse(original.toString('utf8'));
        } catch {
          continue;
        }
        if (!isRecord(document) || document.version !== 1 || typeof document.editorState !== 'string') continue;
        let state: unknown;
        try {
          state = JSON.parse(document.editorState);
        } catch {
          continue;
        }
        const migrated = migrateNodes(state, null);
        if (migrated.changed === 0) continue;
        document.editorState = JSON.stringify(migrated.value);
        archivePrivateOriginal(home, 'legacy-notebook-removed-features', name, original);
        replacePrivateFile(file, `${JSON.stringify(document)}\n`);
        changed += 1;
      } finally {
        release();
      }
    }
    return changed;
  },
};
