import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { notebookRemovedFeatures } from './notebook-removed-features.js';

function writeDocument(home: string, name: string, editorState: unknown): string {
  const file = join(home, 'plugin-data', 'notebook', 'documents', `${name}.json`);
  mkdirSync(join(home, 'plugin-data', 'notebook', 'documents'), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, editorState: JSON.stringify(editorState) }));
  return file;
}

describe('notebook removed features migration', () => {
  it('converts drawing and date nodes into ordinary text nodes', () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-notebook-removed-features-'));
    const date = new Date(2026, 10, 1, 0, 0, 0, 0);
    const file = writeDocument(home, 'note-1', {
      root: {
        type: 'root',
        children: [{
          type: 'paragraph',
          format: '',
          indent: 0,
          direction: null,
          version: 1,
          children: [
            { type: 'datetime', dateTime: date.toISOString(), format: 1, version: 1 },
            { type: 'excalidraw', data: '{"elements":[]}', version: 1 },
          ],
        }],
      },
    });

    expect(notebookRemovedFeatures.run({ home, log: () => {} })).toBe(1);
    const document = JSON.parse(readFileSync(file, 'utf8'));
    const children = JSON.parse(document.editorState).root.children[0].children;
    expect(children).toEqual([
      expect.objectContaining({ type: 'text', text: date.toDateString(), format: 1 }),
      expect.objectContaining({ type: 'text', text: '绘图内容已移除' }),
    ]);
    expect(JSON.stringify(document)).not.toMatch(/datetime|excalidraw/);
    expect(notebookRemovedFeatures.run({ home, log: () => {} })).toBe(0);
  });

  it('wraps a drawing that was stored directly under the root in a paragraph', () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-notebook-removed-features-root-'));
    const file = writeDocument(home, 'note-2', {
      root: {
        type: 'root',
        children: [{ type: 'datetime', dateTime: 'invalid' }, { type: 'excalidraw', data: '[]' }],
      },
    });
    expect(notebookRemovedFeatures.run({ home, log: () => {} })).toBe(1);
    const children = JSON.parse(JSON.parse(readFileSync(file, 'utf8')).editorState).root.children;
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ type: 'paragraph', children: [{ type: 'text', text: '日期内容已移除' }] });
    expect(children[1]).toMatchObject({ type: 'paragraph', children: [{ type: 'text', text: '绘图内容已移除' }] });
  });

  it('does not touch malformed documents', () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-notebook-removed-features-invalid-'));
    const file = writeDocument(home, 'note-3', { root: { type: 'root', children: [] } });
    const original = readFileSync(file, 'utf8');
    expect(notebookRemovedFeatures.run({ home, log: () => {} })).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
});
