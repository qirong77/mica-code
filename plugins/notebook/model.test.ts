import { describe, expect, it } from 'vitest';
import {
  NOTEBOOK_DOCUMENT_MAX_BYTES,
  NotebookOperationError,
  NotebookValidationError,
  createNode,
  createNodeId,
  emptyDocument,
  emptyIndex,
  flattenVisibleTree,
  inspectNotebookEditorState,
  moveNode,
  parseNotebookDocument,
  parseNotebookIndex,
  placeNode,
  renameNode,
  restoreNode,
  trashNode,
  validateNotebookIndex,
  validateNodeId,
} from './model';
import type { NotebookIndex, NotebookNode } from './model';

const NOW = '2026-11-01T08:00:00.000Z';
const LATER = '2026-11-02T08:00:00.000Z';

function node(id: string, extra: Partial<NotebookNode> = {}): NotebookNode {
  return { id, kind: 'folder', parentId: null, title: id, createdAt: NOW, updatedAt: NOW, ...extra };
}

function tree(): NotebookIndex {
  return {
    version: 1,
    nodes: [
      node('root', { title: 'Work' }),
      node('nested', { parentId: 'root', title: 'Design' }),
      node('note', { kind: 'note', parentId: 'nested', title: 'Meeting' }),
      node('other', { kind: 'note', title: 'Personal' }),
    ],
  };
}

describe('Notebook index validation', () => {
  it('initializes only null storage, returns independent empty values, and rejects null mutation results', () => {
    expect(parseNotebookIndex(null)).toEqual({ version: 1, nodes: [] });
    const first = emptyIndex();
    first.nodes.push(node('local'));
    expect(emptyIndex().nodes).toEqual([]);
    expect(() => validateNotebookIndex(null)).toThrow(NotebookValidationError);
  });

  it.each([
    undefined,
    false,
    'broken JSON',
    [],
    {},
    { version: 2, nodes: [] },
    { version: 1, nodes: null },
    { version: 1, nodes: [], lost: 'must not be silently discarded' },
    { version: 1, nodes: [{ ...node('x'), kind: 'file' }] },
    { version: 1, nodes: [{ ...node('x'), title: '  padded  ' }] },
    { version: 1, nodes: [{ ...node('x'), title: '' }] },
    { version: 1, nodes: [{ ...node('x'), title: 'x'.repeat(101) }] },
    { version: 1, nodes: [{ ...node('x'), createdAt: 'not-a-date' }] },
    { version: 1, nodes: [{ ...node('x'), trashedAt: null }] },
    { version: 1, nodes: [{ ...node('x'), parentId: 'missing' }] },
    { version: 1, nodes: [{ ...node('x'), extra: 'unsupported' }] },
  ])('rejects damaged/unsupported data instead of resetting it: %j', (input) => {
    expect(() => parseNotebookIndex(input)).toThrow(NotebookValidationError);
  });

  it('rejects duplicate ids, note parents, cycles and active descendants of deleted folders', () => {
    const invalid: NotebookNode[][] = [
      [node('same'), node('same')],
      [node('parent', { kind: 'note' }), node('child', { parentId: 'parent' })],
      [node('self', { parentId: 'self' })],
      [node('a', { parentId: 'b' }), node('b', { parentId: 'a' })],
      [node('parent', { trashedAt: NOW }), node('child', { parentId: 'parent' })],
    ];
    for (const nodes of invalid) expect(() => parseNotebookIndex({ version: 1, nodes })).toThrow(NotebookValidationError);
  });

  it('keeps safe UUID/document keys and rejects paths and unsafe ids', () => {
    expect(validateNodeId(createNodeId())).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(validateNodeId('note_123-A')).toBe('note_123-A');
    for (const id of ['', '../notes', 'a/b', 'file.json', '.', '-leading', '_leading', 'with space', 'x'.repeat(129)]) {
      expect(() => validateNodeId(id)).toThrow(NotebookValidationError);
    }
  });

  it('rejects index growth beyond the host byte cap (including UTF-8 titles)', () => {
    const nodes = Array.from({ length: 1600 }, (_, index) => node(`node-${index}`, { title: '笔记'.repeat(40) }));
    expect(() => parseNotebookIndex({ version: 1, nodes })).toThrow('exceeds');
  });
});

describe('Notebook editor state inspection', () => {
  it('summarizes images without exposing their payload and rejects unknown node types', () => {
    const result = inspectNotebookEditorState(JSON.stringify({
      root: {
        type: 'root',
        children: [
          { type: 'paragraph', children: [{ type: 'text', text: '正文' }] },
          { type: 'image', src: 'data:image/png;base64,abcd', altText: '截图', width: 640 },
          { type: 'mystery-node', children: [] },
        ],
      },
    }));
    expect(result.valid).toBe(false);
    expect(result.summary).toMatchObject({ images: 1, inline_images: 1, remote_images: 0 });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unsupported_type', path: 'root.children[2].type' }),
    ]));
  });

  it('returns a safe invalid result for broken JSON', () => {
    expect(inspectNotebookEditorState('{broken')).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: 'invalid_json' })],
    });
  });
});

describe('Notebook tree operations', () => {
  it('creates folders/notes, trims names and changes detached snapshots only', () => {
    const original = emptyIndex();
    const folder = createNode(original, { kind: 'folder', parentId: null, title: '  Folder  ', id: 'f', now: NOW });
    const withNote = createNode(folder, { kind: 'note', parentId: 'f', title: '  Note  ', id: 'n', now: NOW });
    expect(original.nodes).toEqual([]);
    expect(folder.nodes).toHaveLength(1);
    expect(withNote.nodes[1]).toEqual(node('n', { kind: 'note', parentId: 'f', title: 'Note' }));
    expect(withNote.nodes[0]?.title).toBe('Folder');
    expect(() => createNode(withNote, { kind: 'note', parentId: 'n', title: 'Child', id: 'child' })).toThrow(NotebookOperationError);
    expect(() => createNode(withNote, { kind: 'note', parentId: null, title: 'Duplicate', id: 'n' })).toThrow('already exists');
  });

  it('validates create/rename names without truncating or changing the original', () => {
    for (const name of [' ', 'x'.repeat(101)]) {
      expect(() => createNode(emptyIndex(), { kind: 'note', parentId: null, title: name, id: 'n' })).toThrow(NotebookValidationError);
      expect(() => renameNode(tree(), 'note', name)).toThrow(NotebookValidationError);
    }
    const original = tree();
    const result = renameNode(original, 'note', '  Next meeting  ', LATER);
    expect(original.nodes[2]?.title).toBe('Meeting');
    expect(result.nodes[2]).toMatchObject({ id: 'note', title: 'Next meeting', updatedAt: LATER, createdAt: NOW });
    expect(() => renameNode(result, 'missing', 'Name')).toThrow('not found');
  });

  it('moves nodes but rejects self/descendant cycles and non-folder destinations', () => {
    const original = tree();
    const result = moveNode(original, 'note', 'root', LATER);
    expect(result.nodes[2]).toMatchObject({ parentId: 'root', updatedAt: LATER });
    expect(original.nodes[2]?.parentId).toBe('nested');
    expect(moveNode(result, 'note', null, LATER).nodes[2]?.parentId).toBeNull();
    expect(() => moveNode(original, 'root', 'root')).toThrow('cycle');
    expect(() => moveNode(original, 'root', 'nested')).toThrow('cycle');
    expect(() => moveNode(original, 'nested', 'note')).toThrow('folder');
    expect(() => moveNode(original, 'note', 'missing')).toThrow('not found');
  });

  it('persists first/last sibling ordering in the existing nodes array', () => {
    const original = tree();
    const movedToEnd = placeNode(original, 'nested', { targetId: 'other', position: 'after' }, LATER);
    expect(movedToEnd.nodes.map((item) => item.id)).toEqual(['root', 'other', 'nested', 'note']);
    expect(movedToEnd.nodes.find((item) => item.id === 'nested')).toMatchObject({ parentId: null, updatedAt: LATER });
    expect(movedToEnd.nodes.find((item) => item.id === 'note')).toMatchObject({ parentId: 'nested', updatedAt: NOW });

    const movedToStart = placeNode(movedToEnd, 'nested', { targetId: 'root', position: 'before' }, NOW);
    expect(movedToStart.nodes.map((item) => item.id)).toEqual(['nested', 'note', 'root', 'other']);
    expect(movedToStart.nodes.find((item) => item.id === 'note')).toMatchObject({ parentId: 'nested', updatedAt: NOW });
  });

  it('moves across folders and appends at the root without losing a folder subtree', () => {
    const original = tree();
    const intoRoot = placeNode(original, 'nested', { targetId: null, position: 'inside' }, LATER);
    expect(intoRoot.nodes.map((item) => item.id)).toEqual(['root', 'other', 'nested', 'note']);
    expect(intoRoot.nodes.find((item) => item.id === 'nested')).toMatchObject({ parentId: null, updatedAt: LATER });
    expect(intoRoot.nodes.find((item) => item.id === 'note')).toMatchObject({ parentId: 'nested', updatedAt: NOW });

    const intoFolder = placeNode(original, 'other', { targetId: 'nested', position: 'inside' }, LATER);
    expect(intoFolder.nodes.map((item) => item.id)).toEqual(['root', 'nested', 'note', 'other']);
    expect(intoFolder.nodes.find((item) => item.id === 'other')).toMatchObject({ parentId: 'nested', updatedAt: LATER });
  });

  it('sorts after a folder whose descendants were appended after other siblings', () => {
    const index: NotebookIndex = { version: 1, nodes: [node('a'), node('b'), node('child-a', { kind: 'note', parentId: 'a' }), node('c', { kind: 'note' })] };
    const result = placeNode(index, 'c', { targetId: 'a', position: 'after' }, LATER);
    expect(flattenVisibleTree(result).map(({ node }) => node.id)).toEqual(['a', 'child-a', 'c', 'b']);
    expect(placeNode(result, 'c', { targetId: 'a', position: 'after' }, NOW)).toEqual(result);
  });

  it('ignores trash entries when deciding an unchanged visible slot', () => {
    const index: NotebookIndex = { version: 1, nodes: [node('a'), node('deleted', { trashedAt: NOW }), node('b')] };
    expect(placeNode(index, 'a', { targetId: 'b', position: 'before' }, 'not-a-date')).toEqual(index);
  });

  it('rejects cycles, trashed/non-folder targets, and leaves exact drops as timestamp-free no-ops', () => {
    const original = tree();
    expect(() => placeNode(original, 'root', { targetId: 'root', position: 'inside' })).toThrow('cycle');
    expect(() => placeNode(original, 'root', { targetId: 'nested', position: 'inside' })).toThrow('cycle');
    expect(() => placeNode(original, 'other', { targetId: 'note', position: 'inside' })).toThrow('folder');

    const trashed = trashNode(original, 'nested', LATER);
    expect(() => placeNode(trashed, 'nested', { targetId: null, position: 'inside' })).toThrow('Restore');
    expect(() => placeNode(original, 'note', { targetId: 'nested', position: 'before' })).not.toThrow();
    expect(() => placeNode(trashed, 'other', { targetId: 'nested', position: 'before' })).toThrow('Restore');

    const noop = placeNode(original, 'root', { targetId: 'other', position: 'before' }, 'not-a-date');
    expect(noop).toEqual(original);
    expect(noop.nodes.find((item) => item.id === 'root')?.updatedAt).toBe(NOW);
  });

  it('is stable when a CAS retry replays the same placement and re-evaluates a moved target', () => {
    const original = tree();
    const operation = (latest: NotebookIndex) => placeNode(latest, 'note', { targetId: 'other', position: 'before' }, LATER);
    const once = operation(original);
    expect(operation(once)).toEqual(once);

    // A concurrent writer moved the target into the source folder. Replay uses the latest
    // parent/order rather than a stale array offset, and the placement is now already adjacent.
    const concurrent = placeNode(original, 'other', { targetId: 'nested', position: 'inside' }, LATER);
    const replayed = operation(concurrent);
    expect(replayed.nodes.map((item) => item.id)).toEqual(['root', 'nested', 'note', 'other']);
    expect(replayed.nodes.find((item) => item.id === 'other')).toMatchObject({ parentId: 'nested' });

    const movedSource = placeNode(original, 'note', { targetId: 'root', position: 'inside' }, LATER);
    const replayedSource = operation(movedSource);
    expect(replayedSource.nodes.map((item) => item.id)).toEqual(['root', 'nested', 'note', 'other']);
    expect(replayedSource.nodes.find((item) => item.id === 'note')).toMatchObject({ parentId: null });
  });

  it('soft-deletes and restores complete subtrees without losing ids, parents or note entries', () => {
    const original = tree();
    const trashed = trashNode(original, 'root', LATER);
    expect(trashed.nodes).toHaveLength(4);
    expect(trashed.nodes.slice(0, 3).every((item) => item.trashedAt === LATER)).toBe(true);
    expect(trashed.nodes[3]?.trashedAt).toBeUndefined();
    expect(original.nodes.every((item) => item.trashedAt === undefined)).toBe(true);
    expect(trashNode(trashed, 'root', NOW)).toEqual(trashed);
    expect(() => renameNode(trashed, 'note', 'No')).toThrow('Restore');
    expect(() => moveNode(trashed, 'note', null)).toThrow('Restore');
    expect(() => createNode(trashed, { kind: 'note', parentId: 'root', title: 'No', id: 'new' })).toThrow('Restore');
    const restored = restoreNode(trashed, 'root', NOW);
    expect(restored).toEqual(original);
  });

  it('restores a note beneath an active folder and documents whole-subtree restoration semantics', () => {
    const deletedNote = trashNode(tree(), 'note', NOW);
    expect(restoreNode(deletedNote, 'note', LATER).nodes[2]?.trashedAt).toBeUndefined();
    const deletedFolder = trashNode(deletedNote, 'root', LATER);
    expect(restoreNode(deletedFolder, 'root', LATER).nodes.every((item) => !item.trashedAt)).toBe(true);
  });

  it('restores missing ancestor folders when a nested note is recovered directly, but not sibling branches', () => {
    const original = createNode(tree(), { kind: 'note', title: 'Sibling', parentId: 'root', id: 'sibling', now: NOW });
    const trashed = trashNode(original, 'root', NOW);
    const restored = restoreNode(trashed, 'note', LATER);
    expect(restored.nodes.filter((item) => !item.trashedAt).map((item) => item.id)).toEqual(['root', 'nested', 'note', 'other']);
    expect(restored.nodes.find((item) => item.id === 'sibling')?.trashedAt).toBe(NOW);
    expect(() => validateNotebookIndex(restored)).not.toThrow();
  });

  it('flattens expansion, title search/ancestors and independent trash roots', () => {
    const index = tree();
    const summarize = (entries: ReturnType<typeof flattenVisibleTree>) => entries.map(({ node: item, depth }) => [item.id, depth]);
    expect(summarize(flattenVisibleTree(index))).toEqual([['root', 0], ['nested', 1], ['note', 2], ['other', 0]]);
    expect(summarize(flattenVisibleTree(index, { expanded: new Set() }))).toEqual([['root', 0], ['other', 0]]);
    expect(summarize(flattenVisibleTree(index, { expanded: new Set(), query: 'MEET' }))).toEqual([['root', 0], ['nested', 1], ['note', 2]]);
    const deleted = trashNode(index, 'nested', LATER);
    expect(summarize(flattenVisibleTree(deleted))).toEqual([['root', 0], ['other', 0]]);
    expect(summarize(flattenVisibleTree(deleted, { showTrash: true }))).toEqual([['nested', 0], ['note', 1]]);
  });
});

describe('Notebook document validation', () => {
  it('supports null initial editorState and serialized editor JSON', () => {
    expect(parseNotebookDocument(emptyDocument())).toEqual({ version: 1, editorState: null });
    const document = { version: 1, editorState: '{"root":{"children":[]}}' };
    expect(parseNotebookDocument(document)).toEqual(document);
  });

  it.each([
    null,
    undefined,
    {},
    { version: 2, editorState: null },
    { version: 1, editorState: '' },
    { version: 1, editorState: 'broken' },
    { version: 1, editorState: 'null' },
    { version: 1, editorState: '[]' },
    { version: 1, editorState: {} },
    // 评论已移除：旧文档里的 comments 字段必须由数据迁移清掉，运行时不当成合法形态。
    { version: 1, editorState: null, comments: [] },
    { version: 1, editorState: null, extra: 'keep or reject, never drop' },
  ])('rejects corrupt body data instead of initializing an empty editor: %j', (input) => {
    expect(() => parseNotebookDocument(input)).toThrow(NotebookValidationError);
  });

  it('enforces the document UTF-8 size cap', () => {
    const editorState = JSON.stringify({ root: { text: 'x'.repeat(NOTEBOOK_DOCUMENT_MAX_BYTES) } });
    expect(() => parseNotebookDocument({ version: 1, editorState })).toThrow('exceeds');
  });
});
