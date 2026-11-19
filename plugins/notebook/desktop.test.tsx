import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NotebookPage, { createDefaultNote, NotebookChatButton } from './desktop.jsx';
import { createNotebookController } from './controller';
import { createNode, emptyIndex, flattenVisibleTree, placeNode, trashNode } from './model';
import type { NotebookIndex } from './model';
import { NotebookChatDock } from './NotebookChatDock';

const now = '2026-11-01T00:00:00.000Z';

describe('Notebook AI entry', () => {
  it('restores the cross-note discussion mode from the page address', () => {
    const html = renderToStaticMarkup(
      <NotebookChatDock
        api={{
          page: { search: () => ({ chat: 'general' }) },
          ui: { Conversation: ({ scope }: { scope: string }) => <div data-scope={scope} /> },
        }}
        note={{ id: 'a', title: '第一篇' }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('data-scope="general"');
  });
  it('embeds the host conversation with a stable per-note scope and an explicit reference', () => {
    const reference = { label: '引用当前笔记', getText: vi.fn() };
    const Conversation = vi.fn(({ scope, visible }) => <div data-scope={scope} data-visible={visible} />);
    const html = renderToStaticMarkup(
      <NotebookChatDock
        api={{ ui: { Conversation } }}
        note={{ id: 'a', title: '第一篇' }}
        reference={reference}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('data-scope="note:a"');
    expect(html).toContain('第一篇');
    expect(html).toContain('跨笔记对话');
    expect(Conversation.mock.calls[0][0].reference).toBe(reference);
    expect(reference.getText).not.toHaveBeenCalled();
  });

  it('keeps the host conversation mounted but hidden when the panel closes', () => {
    const html = renderToStaticMarkup(
      <NotebookChatDock
        api={{
          ui: {
            Conversation: ({ visible, scope }: { visible: boolean; scope: string }) => (
              <div data-visible={visible} data-scope={scope} />
            ),
          },
        }}
        open={false}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('data-visible="false"');
    expect(html).toContain('data-scope="general"');
    expect(html).toContain('display:none');
    expect(html).not.toContain('notebook-chat-mask');
  });

  it('reports a missing host capability instead of opening an incomplete chat', () => {
    expect(renderToStaticMarkup(<NotebookChatDock api={{}} onClose={() => {}} />)).toContain(
      '未提供可嵌入的 Mica 对话能力',
    );
  });

  it.each([
    { open: false, focused: false, visible: false },
    { open: true, focused: false, visible: true },
    { open: false, focused: true, visible: false },
    { open: true, focused: true, visible: false },
  ])('toggles the visible panel when open=$open and focused=$focused', ({ open, focused, visible }) => {
    const onOpenChange = vi.fn();
    const onFocusedChange = vi.fn();
    const button = NotebookChatButton({ open, focused, onOpenChange, onFocusedChange });
    expect(button.props.children).toBeUndefined();
    expect(button.props.icon).toBeTruthy();
    expect(button.props['aria-expanded']).toBe(visible);
    expect(button.props.pressed).toBe(visible);
    expect(button.props['aria-label']).toBe(visible ? '收起 AI 对话' : '打开 AI 对话');
    button.props.onClick();
    expect(onOpenChange).toHaveBeenCalledWith(!visible);
    if (visible) expect(onFocusedChange).not.toHaveBeenCalled();
    else expect(onFocusedChange).toHaveBeenCalledWith(false);
  });

  it.each([1440, 390])('shows a labeled AI entry without selecting a note at %ipx', (width) => {
    const previousWindow = globalThis.window;
    globalThis.window = {
      innerWidth: width,
      matchMedia: () => ({ matches: width <= 760 }),
    } as unknown as Window & typeof globalThis;
    try {
      const html = renderToStaticMarkup(<NotebookPage api={{}} />);
      expect(html).toContain('notebook-welcome');
      expect(html).toContain('notebook-bar-actions');
      expect(html).toContain('aria-label="新建文件夹"');
      expect(html).toContain('notebook-root-target');
      expect(html).toContain('notebook-ai-button');
      expect(html).toContain('aria-label="打开 AI 对话"');
      expect(html).not.toContain('AI 对话</span>');
    } finally {
      globalThis.window = previousWindow;
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
