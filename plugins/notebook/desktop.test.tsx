import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NotebookPage, { createDefaultNote, NotebookChatButton } from './desktop.jsx';
import { createNotebookController } from './controller';
import { createNode, emptyIndex, trashNode } from './model';
import type { NotebookIndex } from './model';

const now = '2026-11-01T00:00:00.000Z';

describe('Notebook AI entry', () => {
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
    vi.stubGlobal('window', {
      innerWidth: width,
      matchMedia: () => ({ matches: width <= 760 }),
    });
    try {
      const html = renderToStaticMarkup(<NotebookPage api={{}} />);
      expect(html).toContain('notebook-welcome');
      expect(html).toContain('notebook-bar-actions');
      expect(html).toContain('notebook-ai-button');
      expect(html).toContain('aria-label="打开 AI 对话"');
      expect(html).not.toContain('AI 对话</span>');
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
