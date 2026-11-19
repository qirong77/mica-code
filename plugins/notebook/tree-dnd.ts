import type { NotebookIndex, NotebookNode } from './model';

export type NotebookDropTarget =
  | { targetId: string; position: 'before' | 'after' | 'inside' }
  | { targetId: null; position: 'inside' };

export type NotebookDropPosition = 'before' | 'after' | 'inside';

function findNode(index: NotebookIndex, id: string): NotebookNode | undefined {
  return index.nodes.find((node) => node.id === id);
}

function isDescendant(index: NotebookIndex, id: string, ancestorId: string): boolean {
  let current = findNode(index, id);
  const seen = new Set<string>();
  while (current?.parentId !== null && current?.parentId !== undefined) {
    if (seen.has(current.parentId)) return true;
    seen.add(current.parentId);
    if (current.parentId === ancestorId) return true;
    current = findNode(index, current.parentId);
  }
  return false;
}

function sameSiblingSlot(
  index: NotebookIndex,
  source: NotebookNode,
  target: NotebookNode,
  position: 'before' | 'after',
): boolean {
  if (source.parentId !== target.parentId) return false;
  const siblings = index.nodes.filter((node) => !node.trashedAt && node.parentId === source.parentId);
  const sourceIndex = siblings.findIndex((node) => node.id === source.id);
  const targetIndex = siblings.findIndex((node) => node.id === target.id);
  if (sourceIndex < 0 || targetIndex < 0) return false;
  return position === 'before' ? sourceIndex + 1 === targetIndex : targetIndex + 1 === sourceIndex;
}

/**
 * Keep dragover validation cheap: this checks only the source, target, parent kind and the
 * ancestry needed to reject a cycle. Full index validation remains the model operation's job.
 */
export function resolveNotebookDrop(
  index: NotebookIndex,
  sourceId: string,
  target: NotebookDropTarget,
): NotebookDropTarget | null {
  if (!target || typeof target !== 'object') return null;
  if (target.position !== 'before' && target.position !== 'after' && target.position !== 'inside') return null;
  if (target.targetId === null && target.position !== 'inside') return null;
  if (target.targetId !== null && typeof target.targetId !== 'string') return null;

  const source = findNode(index, sourceId);
  if (!source || source.trashedAt) return null;
  const destination = target.targetId === null ? undefined : findNode(index, target.targetId);
  if (target.targetId !== null && (!destination || destination.trashedAt)) return null;
  if (destination && destination.id === source.id) return null;
  if (destination && isDescendant(index, destination.id, source.id)) return null;

  if (target.position === 'inside') {
    if (destination && destination.kind !== 'folder') return null;
    if (destination) {
      const children = index.nodes.filter((node) => !node.trashedAt && node.parentId === destination.id);
      if (children.at(-1)?.id === source.id) return null;
    } else {
      const roots = index.nodes.filter((node) => !node.trashedAt && node.parentId === null);
      if (roots.at(-1)?.id === source.id) return null;
    }
    return target;
  }

  if (!destination || sameSiblingSlot(index, source, destination, target.position)) return null;
  return target;
}

/** Resolve a row's vertical hit area into the model's before/after/inside placement. */
export function notebookDropPosition(
  kind: NotebookNode['kind'],
  clientY: number,
  bounds: { top: number; height: number },
): NotebookDropPosition {
  const offset = clientY - bounds.top;
  if (kind === 'note') return offset < bounds.height / 2 ? 'before' : 'after';
  if (offset < bounds.height / 4) return 'before';
  if (offset < (bounds.height * 3) / 4) return 'inside';
  return 'after';
}
