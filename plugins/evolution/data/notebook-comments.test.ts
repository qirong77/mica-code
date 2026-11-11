import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { notebookComments } from './notebook-comments.js';

const dirs: string[] = [];

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-notebook-comments-'));
  dirs.push(dir);
  return dir;
}

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf-8');
}

function read(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('notebook 评论数据迁移', () => {
  it('归档讨论记录、去掉 comments 字段，并把评论锚点还原成普通文本', () => {
    const root = home();
    const file = join(root, 'plugin-data', 'notebook', 'documents', 'note-1.json');
    const editorState = JSON.stringify({
      root: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'text', text: 'before ' },
              { type: 'mark', ids: ['thread-1'], children: [{ type: 'text', text: 'discussed' }] },
              { type: 'text', text: ' after' },
            ],
          },
        ],
      },
    });
    write(file, { version: 1, editorState, comments: [{ type: 'thread', id: 'thread-1' }] });

    expect(notebookComments.run({ home: root, log: () => {} })).toBe(1);

    const document = read(file) as { version: number; editorState: string; comments?: unknown };
    expect(document.comments).toBeUndefined();
    expect(JSON.parse(document.editorState)).toEqual({
      root: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'text', text: 'before ' },
              { type: 'text', text: 'discussed' },
              { type: 'text', text: ' after' },
            ],
          },
        ],
      },
    });
    const archived = read(join(root, 'plugin-data', 'evolution', 'legacy-notebook-comments', 'note-1.json')) as {
      noteId: string;
      comments: unknown;
    };
    expect(archived.noteId).toBe('note-1');
    expect(archived.comments).toEqual([{ type: 'thread', id: 'thread-1' }]);

    // 幂等：洗过之后没有可改的东西。
    expect(notebookComments.run({ home: root, log: () => {} })).toBe(0);
  });

  it('没有评论的新形态文档不重写', () => {
    const root = home();
    const file = join(root, 'plugin-data', 'notebook', 'documents', 'note-2.json');
    const original = `${JSON.stringify({ version: 1, editorState: null })}\n`;
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, original, 'utf-8');

    expect(notebookComments.run({ home: root, log: () => {} })).toBe(0);
    expect(readFileSync(file, 'utf-8')).toBe(original);
  });

  it('空评论数组只删字段，不产生归档文件', () => {
    const root = home();
    const file = join(root, 'plugin-data', 'notebook', 'documents', 'note-3.json');
    write(file, { version: 1, editorState: null, comments: [] });

    expect(notebookComments.run({ home: root, log: () => {} })).toBe(1);
    expect(read(file)).toEqual({ version: 1, editorState: null });
    expect(existsSync(join(root, 'plugin-data', 'evolution', 'legacy-notebook-comments', 'note-3.json'))).toBe(false);
  });

  it('损坏文档与非笔记文档原样保留', () => {
    const root = home();
    const broken = join(root, 'plugin-data', 'notebook', 'documents', 'note-4.json');
    mkdirSync(join(broken, '..'), { recursive: true });
    writeFileSync(broken, '{"version":1,,,', 'utf-8');
    const other = join(root, 'plugin-data', 'notebook', 'documents', 'note-5.json');
    write(other, { version: 2, editorState: null, comments: [] });
    const oddComments = join(root, 'plugin-data', 'notebook', 'documents', 'note-6.json');
    write(oddComments, { version: 1, editorState: null, comments: { type: 'thread' } });

    expect(notebookComments.run({ home: root, log: () => {} })).toBe(0);
    expect(readFileSync(broken, 'utf-8')).toBe('{"version":1,,,');
    expect(read(other)).toEqual({ version: 2, editorState: null, comments: [] });
    expect(read(oddComments)).toEqual({ version: 1, editorState: null, comments: { type: 'thread' } });
  });

  it('笔记目录不存在时什么都不做', () => {
    expect(notebookComments.run({ home: home(), log: () => {} })).toBe(0);
  });
});
