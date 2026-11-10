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
  moveNode,
  parseNotebookDocument,
  parseNotebookIndex,
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
  it('supports null initial editorState, serialized editor JSON and detached arbitrary JSON comments', () => {
    expect(parseNotebookDocument(emptyDocument())).toEqual({ version: 1, editorState: null, comments: [] });
    const document = { version: 1, editorState: '{"root":{"children":[]}}', comments: [{ id: 'c', text: 'hello', nested: [1, true, null] }] };
    const parsed = parseNotebookDocument(document);
    expect(parsed).toEqual(document);
    expect(parsed.comments).not.toBe(document.comments);
  });

  it.each([
    null,
    undefined,
    {},
    { version: 2, editorState: null, comments: [] },
    { version: 1, editorState: '', comments: [] },
    { version: 1, editorState: 'broken', comments: [] },
    { version: 1, editorState: 'null', comments: [] },
    { version: 1, editorState: '[]', comments: [] },
    { version: 1, editorState: {}, comments: [] },
    { version: 1, editorState: null, comments: {} },
    { version: 1, editorState: null, comments: [], extra: 'keep or reject, never drop' },
  ])('rejects corrupt body data instead of initializing an empty editor: %j', (input) => {
    expect(() => parseNotebookDocument(input)).toThrow(NotebookValidationError);
  });

  it('rejects comment values JSON would silently change/drop and cyclic data', () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    const inputs = [cyclic, [undefined], [NaN], [new Date()], [() => 'x'], [{ dropped: undefined }]];
    for (const comments of inputs) {
      expect(() => parseNotebookDocument({ version: 1, editorState: null, comments })).toThrow(NotebookValidationError);
    }
  });

  it('enforces the document UTF-8 size cap', () => {
    expect(() => parseNotebookDocument({ version: 1, editorState: null, comments: ['x'.repeat(NOTEBOOK_DOCUMENT_MAX_BYTES)] })).toThrow('exceeds');
  });
});
