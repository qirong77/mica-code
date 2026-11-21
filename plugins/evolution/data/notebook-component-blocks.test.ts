import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { notebookComponentBlocks } from './notebook-component-blocks.js';

const dirs: string[] = [];

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-notebook-component-blocks-'));
  dirs.push(dir);
  return dir;
}

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf-8');
}

function read(path: string): { version: number; editorState: string } {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function legacyDocument(): string {
  return JSON.stringify({
    root: {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', text: '前文' }] },
        {
          type: 'html',
          runtime: 'react',
          html: 'function App({html}) { return html`<p>建群</p>`; }',
          height: 320,
          version: 1,
        },
        { type: 'html', runtime: 'html', html: '<div>静态</div>', version: 1 },
      ],
    },
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('notebook 组件块数据迁移', () => {
  it('把 runtime: react 的 html 节点迁成 component 节点，并去掉静态 HTML 的 runtime', () => {
    const root = home();
    const file = join(root, 'plugin-data', 'notebook', 'documents', 'note-1.json');
    write(file, { version: 1, editorState: legacyDocument() });

    expect(notebookComponentBlocks.run({ home: root, log: () => {} })).toBe(1);

    const document = read(file) as unknown as { version: number; editorState: string };
    const children = (JSON.parse(document.editorState) as {
      root: { children: Record<string, unknown>[] };
    }).root.children;
    expect(children[1]).toEqual({
      type: 'component',
      code: 'function App({html}) { return html`<p>建群</p>`; }',
      height: 320,
      version: 1,
    });
    expect(children[2]).toEqual({ type: 'html', html: '<div>静态</div>', version: 1 });
    expect(JSON.stringify(children)).not.toContain('runtime');
  });

  it('重复执行改动数为 0，不再重写文件', () => {
    const root = home();
    const file = join(root, 'plugin-data', 'notebook', 'documents', 'note-1.json');
    write(file, { version: 1, editorState: legacyDocument() });

    expect(notebookComponentBlocks.run({ home: root, log: () => {} })).toBe(1);
    const first = readFileSync(file, 'utf-8');
    expect(notebookComponentBlocks.run({ home: root, log: () => {} })).toBe(0);
    expect(readFileSync(file, 'utf-8')).toBe(first);
    expect(read(file).editorState).toContain('"type":"component"');
  });

  it('损坏文档与非 version: 1 文档不动', () => {
    const root = home();
    const broken = join(root, 'plugin-data', 'notebook', 'documents', 'broken.json');
    const other = join(root, 'plugin-data', 'notebook', 'documents', 'old.json');
    write(broken, { version: 1, editorState: 'not json' });
    write(other, { version: 2, editorState: legacyDocument() });

    expect(notebookComponentBlocks.run({ home: root, log: () => {} })).toBe(0);
    expect(readFileSync(broken, 'utf-8')).toContain('not json');
    expect(readFileSync(other, 'utf-8')).toContain('runtime');
    expect(readFileSync(other, 'utf-8')).not.toContain('component');
  });
});
