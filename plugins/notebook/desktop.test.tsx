import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NotebookPage, {
  EDITOR_SKELETON_DELAY_MS,
  RAIL_DEFAULT_WIDTH,
  RENAME_TAP_WINDOW_MS,
  clampRailWidth,
  createDefaultNote,
  editorOverlayMode,
  notebookRowTap,
  notebookRailLimits,
} from './desktop.jsx';
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
      // 目录宽度只在停靠（桌面）时可以拖；窄屏抽屉保持自己的宽度，不出现命中区。
      expect(html.includes('notebook-rail-resizer')).toBe(width > 760);
      if (width > 760) {
        expect(html).toContain('role="separator"');
        expect(html).toContain('aria-label="调整目录宽度"');
      }
      expect(Conversation).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Notebook editor loading', () => {
  it('only covers the editor for a frame that has not booted yet, and only after the quiet window', () => {
    // 第一次打开：iframe 还没起来，先安静一小段时间才遮挡。
    expect(editorOverlayMode({ frameState: 'loading', booted: false, delayElapsed: false })).toBe(null);
    expect(editorOverlayMode({ frameState: 'loading', booted: false, delayElapsed: true })).toBe('skeleton');
    // 已经启动过的 iframe 只是换一篇正文：不遮，上一篇留着。
    expect(editorOverlayMode({ frameState: 'loading', booted: true, delayElapsed: true })).toBe(null);
    expect(editorOverlayMode({ frameState: 'ready', booted: true, delayElapsed: false })).toBe(null);
    // 起不来永远要说清楚，与是否 boot 过无关。
    expect(editorOverlayMode({ frameState: 'error', booted: true, delayElapsed: false })).toBe('error');
    expect(EDITOR_SKELETON_DELAY_MS).toBeGreaterThanOrEqual(200);
  });
});

describe('Notebook rail width', () => {
  it('treats a second tap on the same row as a rename, and only within the window', () => {
    const first = notebookRowTap({ id: null, at: 0 }, 'a', 1000);
    expect(first).toEqual({ rename: false, next: { id: 'a', at: 1000 } });

    // 同一行的第二次点击（手机双击、桌面双击）进入改名，并把基准清空。
    expect(notebookRowTap(first.next, 'a', 1000 + RENAME_TAP_WINDOW_MS)).toEqual({
      rename: true,
      next: { id: null, at: 0 },
    });
    // 停顿太久只算一次新的点击。
    expect(notebookRowTap(first.next, 'a', 1000 + RENAME_TAP_WINDOW_MS + 1).rename).toBe(false);
    // 换一行不算双击。
    expect(notebookRowTap(first.next, 'b', 1010).rename).toBe(false);
    // 改名之后紧接着的一次点击重新开始计数，不会连着又开一次改名。
    expect(notebookRowTap({ id: null, at: 0 }, 'a', 1100).rename).toBe(false);
  });

  it('clamps the width to absolute bounds and to the room the document needs', () => {
    expect(clampRailWidth(120)).toBe(200);
    expect(clampRailWidth(9999)).toBe(460);
    expect(clampRailWidth(Number.NaN)).toBe(RAIL_DEFAULT_WIDTH);
    // 900px 的页面：目录最多 378px（42%），正文至少留 480px，两处取更紧的那个。
    expect(notebookRailLimits(900)).toEqual({ min: 200, max: 378 });
    expect(clampRailWidth(460, 900)).toBe(378);
    expect(notebookRailLimits(1440)).toEqual({ min: 200, max: 460 });
    // 刚过移动端断点时目录仍有可拖动区间，不会把正文挤没。
    expect(notebookRailLimits(761)).toEqual({ min: 200, max: 281 });
    expect(clampRailWidth(RAIL_DEFAULT_WIDTH, 761)).toBe(RAIL_DEFAULT_WIDTH);
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
