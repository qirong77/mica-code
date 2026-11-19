import type { NotebookIndex, NotebookNode } from './model';

export type NotebookDropTarget =
  | { targetId: string; position: 'before' | 'after' | 'inside' }
  | { targetId: null; position: 'inside' };

export type NotebookDropPosition = 'before' | 'after' | 'inside';

type DropLookup = {
  nodes: readonly NotebookNode[];
  byId: Map<string, NotebookNode>;
  children: Map<string | null, NotebookNode[]>;
  siblingIndex: Map<string, number>;
};

const dropLookups = new WeakMap<object, DropLookup>();

function lookupFor(index: NotebookIndex): DropLookup {
  const cached = dropLookups.get(index);
  if (cached?.nodes === index.nodes) return cached;

  const byId = new Map(index.nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, NotebookNode[]>();
  for (const node of index.nodes) {
    if (node.trashedAt) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const siblingIndex = new Map<string, number>();
  for (const siblings of children.values()) {
    siblings.forEach((node, position) => siblingIndex.set(node.id, position));
  }

  const lookup = { nodes: index.nodes, byId, children, siblingIndex };
  dropLookups.set(index, lookup);
  return lookup;
}

function isDescendant(lookup: DropLookup, id: string, ancestorId: string): boolean {
  let current = lookup.byId.get(id);
  const seen = new Set<string>();
  while (current?.parentId !== null && current?.parentId !== undefined) {
    if (seen.has(current.parentId)) return true;
    seen.add(current.parentId);
    if (current.parentId === ancestorId) return true;
    current = lookup.byId.get(current.parentId);
  }
  return false;
}

function sameSiblingSlot(
  lookup: DropLookup,
  source: NotebookNode,
  target: NotebookNode,
  position: 'before' | 'after',
): boolean {
  if (source.parentId !== target.parentId) return false;
  const sourceIndex = lookup.siblingIndex.get(source.id);
  const targetIndex = lookup.siblingIndex.get(target.id);
  if (sourceIndex === undefined || targetIndex === undefined) return false;
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

  const lookup = lookupFor(index);
  const source = lookup.byId.get(sourceId);
  if (!source || source.trashedAt) return null;
  const destination = target.targetId === null ? undefined : lookup.byId.get(target.targetId);
  if (target.targetId !== null && (!destination || destination.trashedAt)) return null;
  if (destination && destination.id === source.id) return null;
  if (destination && isDescendant(lookup, destination.id, source.id)) return null;

  if (target.position === 'inside') {
    if (destination && destination.kind !== 'folder') return null;
    if (destination) {
      if (lookup.children.get(destination.id)?.at(-1)?.id === source.id) return null;
    } else {
      if (lookup.children.get(null)?.at(-1)?.id === source.id) return null;
    }
    return target;
  }

  if (!destination || sameSiblingSlot(lookup, source, destination, target.position)) return null;
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
