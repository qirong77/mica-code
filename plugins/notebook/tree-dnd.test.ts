import { describe, expect, it } from 'vitest';
import { resolveNotebookDrop, notebookDropPosition } from './tree-dnd';
import type { NotebookIndex, NotebookNode } from './model';
import type { NotebookDropTarget } from './tree-dnd';

const NOW = '2026-11-01T08:00:00.000Z';

function node(id: string, extra: Partial<NotebookNode> = {}): NotebookNode {
  return { id, kind: 'folder', parentId: null, title: id, createdAt: NOW, updatedAt: NOW, ...extra };
}

function tree(): NotebookIndex {
  return {
    version: 1,
    nodes: [
      node('source'),
      node('child', { kind: 'note', parentId: 'source' }),
      node('target'),
      node('target-note', { kind: 'note', parentId: 'target' }),
      node('root-note', { kind: 'note' }),
    ],
  };
}

describe('notebook drag/drop helpers', () => {
  it('accepts valid before/after/inside targets and rejects malformed or cyclic targets', () => {
    const index = tree();
    const before: NotebookDropTarget = { targetId: 'target-note', position: 'before' };
    expect(resolveNotebookDrop(index, 'child', before)).toEqual(before);
    expect(resolveNotebookDrop(index, 'source', { targetId: 'target', position: 'inside' })).toEqual({
      targetId: 'target',
      position: 'inside',
    });
    expect(resolveNotebookDrop(index, 'source', { targetId: null, position: 'inside' })).toEqual({
      targetId: null,
      position: 'inside',
    });
    expect(resolveNotebookDrop(index, 'source', { targetId: 'child', position: 'inside' })).toBeNull();
    expect(resolveNotebookDrop(index, 'child', { targetId: 'root-note', position: 'inside' })).toBeNull();
    expect(resolveNotebookDrop(index, 'missing', before)).toBeNull();
    expect(resolveNotebookDrop(index, 'child', { targetId: 'missing', position: 'before' })).toBeNull();
    expect(resolveNotebookDrop(index, 'child', { targetId: null, position: 'before' } as never)).toBeNull();
  });

  it('rejects self and exact sibling/root-end no-op drops without validating the whole index', () => {
    const index = tree();
    expect(resolveNotebookDrop(index, 'child', { targetId: 'child', position: 'before' })).toBeNull();
    expect(resolveNotebookDrop(index, 'target', { targetId: 'root-note', position: 'before' })).toBeNull();
    expect(resolveNotebookDrop(index, 'target-note', { targetId: 'target', position: 'inside' })).toBeNull();
    expect(resolveNotebookDrop(index, 'root-note', { targetId: null, position: 'inside' })).toBeNull();

    const trashed = {
      ...index,
      nodes: index.nodes.map((node) => (node.id === 'target' ? { ...node, trashedAt: NOW } : node)),
    };
    expect(resolveNotebookDrop(trashed, 'child', { targetId: 'target', position: 'before' })).toBeNull();
    expect(
      resolveNotebookDrop(
        { ...index, nodes: index.nodes.map((node) => (node.id === 'child' ? { ...node, trashedAt: NOW } : node)) },
        'child',
        {
          targetId: 'target',
          position: 'before',
        },
      ),
    ).toBeNull();
  });

  it('maps note halves and folder quarters to model placement positions', () => {
    expect(notebookDropPosition('note', 10 + 24, { top: 10, height: 100 })).toBe('before');
    expect(notebookDropPosition('note', 10 + 50, { top: 10, height: 100 })).toBe('after');
    expect(notebookDropPosition('folder', 10 + 24, { top: 10, height: 100 })).toBe('before');
    expect(notebookDropPosition('folder', 10 + 25, { top: 10, height: 100 })).toBe('inside');
    expect(notebookDropPosition('folder', 10 + 74, { top: 10, height: 100 })).toBe('inside');
    expect(notebookDropPosition('folder', 10 + 75, { top: 10, height: 100 })).toBe('after');
  });

  it('ignores hidden trash entries when rejecting an unchanged visible drop', () => {
    const index: NotebookIndex = { version: 1, nodes: [node('a'), node('deleted', { trashedAt: NOW }), node('b')] };
    expect(resolveNotebookDrop(index, 'a', { targetId: 'b', position: 'before' })).toBeNull();
  });
});
