import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NotebookPage, { createDefaultNote } from './desktop.jsx';
import { createNotebookController } from './controller';
import { createNode, emptyIndex, flattenVisibleTree, placeNode, trashNode } from './model';
import type { NotebookIndex } from './model';

const now = '2026-11-01T00:00:00.000Z';

describe('Notebook navigation', () => {
  it.each([1440, 390])('renders the directory and its controls without a chat entry at %ipx', (width) => {
    vi.stubGlobal('window', {
      innerWidth: width,
      matchMedia: () => ({ matches: width <= 760 }),
    });
    try {
      const Conversation = vi.fn(() => null);
      const html = renderToStaticMarkup(<NotebookPage api={{ ui: { Conversation } }} />);
      expect(html).toContain('notebook-welcome');
      expect(html).not.toContain('notebook-editor-frame');
      expect(html).toContain('notebook-root-target');
      expect(html).toContain('aria-label="笔记目录树"');
      expect(html).toContain('aria-label="搜索笔记"');
      expect(html).toContain('aria-label="新建"');
      expect(html).toContain('aria-label="定位当前笔记"');
      expect(html).toContain('notebook-book-info');
      expect(html).toContain('查看笔记本的 HTTP 接口');
      expect(html).not.toMatch(/notebook-rail-add[\s\S]*?>新建<\/span>/);
      // The subtitle reserves its space without briefly showing a false zero count.
      expect(html).not.toContain('0 篇笔记');
      expect(html).not.toContain('AI 对话');
      expect(Conversation).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Notebook direct creation', () => {
  it('creates a default-titled note in the selected folder and is safe to replay', () => {
    const index = createNode(emptyIndex(), { id: 'folder', kind: 'folder', parentId: null, title: '目录', now });
    const operation = createDefaultNote({ id: 'note', now, parentId: 'folder' });
    const result = operation(index) as NotebookIndex;
    expect(result.nodes[1]).toMatchObject({
      id: 'note',
      kind: 'note',
      title: '未命名笔记',
      parentId: 'folder',
      createdAt: now,
    });
    expect(operation(result)).toEqual(result);
    expect(() => operation(trashNode(index, 'folder', now))).toThrow();
  });

  it('replays against the latest index after a concurrent write without losing either note', async () => {
    let stored = emptyIndex();
    let version: string | null = null;
    let attempts = 0;
    const writeData = vi.fn(async (candidate: NotebookIndex, options: { expectedVersion: string | null }) => {
      if (++attempts === 1) {
        stored = createNode(stored, { id: 'other', kind: 'note', parentId: null, title: '其他窗口', now });
        version = 'other-version';
        return { ok: false, conflict: true };
      }
      expect(options.expectedVersion).toBe(version);
      stored = candidate;
      version = 'saved-version';
      return { ok: true, version };
    });
    const controller = createNotebookController({
      host: {
        readData: async () => ({ value: version === null ? null : stored, version }),
        writeData,
        documents: {
          read: async () => ({ value: null, version: null }),
          write: async () => ({ ok: true, version: 'document-version' }),
        },
      },
    });
    const result = await controller.mutateIndex(createDefaultNote({ id: 'note', now, parentId: null }));
    expect(result.nodes.map((node) => [node.id, node.title])).toEqual([
      ['other', '其他窗口'],
      ['note', '未命名笔记'],
    ]);
    expect(writeData).toHaveBeenCalledTimes(2);
  });
});

describe('Notebook directory ordering', () => {
  it('replays a drop after a CAS conflict without losing another window’s folder and note', async () => {
    let stored = emptyIndex();
    for (const id of ['first', 'second', 'third']) {
      stored = createNode(stored, { id, kind: 'note', parentId: null, title: id, now });
    }
    let version = 'initial';
    let attempts = 0;
    const controller = createNotebookController({
      host: {
        readData: async () => ({ value: stored, version }),
        writeData: async (candidate, options) => {
          if (++attempts === 1) {
            stored = createNode(stored, {
              id: 'folder',
              kind: 'folder',
              parentId: null,
              title: '另一个窗口的目录',
              now,
            });
            stored = createNode(stored, { id: 'child', kind: 'note', parentId: 'folder', title: '不应丢失', now });
            version = 'concurrent';
            return { ok: false, conflict: true };
          }
          expect(options.expectedVersion).toBe('concurrent');
          stored = candidate;
          version = 'ordered';
          return { ok: true, version };
        },
        documents: {
          read: vi.fn(async () => ({ value: null, version: null })),
          write: vi.fn(async () => ({ ok: true, version: 'unused' })),
        },
      },
    });
    const result = await controller.mutateIndex((latest) =>
      placeNode(latest, 'third', { targetId: 'first', position: 'before' }, now),
    );
    expect(flattenVisibleTree(result).map(({ node }) => node.id)).toEqual([
      'third',
      'first',
      'second',
      'folder',
      'child',
    ]);
    expect(await controller.loadIndex()).toEqual(result);
    expect(attempts).toBe(2);
  });
});
