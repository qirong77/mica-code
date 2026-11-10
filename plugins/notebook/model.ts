/** The index stays small; note bodies belong in host.documents, never data.json. */
export const NOTEBOOK_INDEX_MAX_BYTES = 256 * 1024;
/** Match the generic host cap; the mobile relay's 8 MiB RPC needs envelope headroom. */
export const NOTEBOOK_DOCUMENT_MAX_BYTES = 6 * 1024 * 1024;
export const NOTEBOOK_TITLE_MAX_LENGTH = 100;

export interface NotebookNode {
  id: string;
  kind: 'folder' | 'note';
  parentId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  trashedAt?: string;
}

export interface NotebookIndex {
  version: 1;
  nodes: NotebookNode[];
}

export interface NotebookDocument {
  version: 1;
  /** null means a new, uninitialized editor. A non-null value is serialized editor JSON. */
  editorState: string | null;
  comments: unknown[];
}

export class NotebookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotebookValidationError';
  }
}

export class NotebookOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotebookOperationError';
  }
}

export function emptyIndex(): NotebookIndex {
  return { version: 1, nodes: [] };
}

export function emptyDocument(): NotebookDocument {
  return { version: 1, editorState: null, comments: [] };
}

/** Safe as a documents key (no paths, extensions, dots or traversal segments). */
export function validateNodeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new NotebookValidationError('Invalid notebook node id');
  }
  return value;
}

export function createNodeId(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  // randomUUID is secure-context-only in browsers; LAN HTTP still provides getRandomValues.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NotebookValidationError(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NotebookValidationError(`${label} must be a plain JSON object`);
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new NotebookValidationError(`${label} contains unsupported fields`);
  }
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new NotebookValidationError('Invalid notebook timestamp');
  }
  return value;
}

function title(value: unknown, normalize: boolean): string {
  if (typeof value !== 'string') throw new NotebookValidationError('Invalid notebook title');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > NOTEBOOK_TITLE_MAX_LENGTH || (!normalize && trimmed !== value)) {
    throw new NotebookValidationError('Notebook titles must be trimmed and contain 1–100 characters');
  }
  return trimmed;
}

function checkSize(value: unknown, limit: number, label: string): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') throw new NotebookValidationError(`${label} is not JSON serializable`);
  if (new TextEncoder().encode(serialized).byteLength > limit) {
    throw new NotebookValidationError(`${label} exceeds ${limit} bytes`);
  }
  return serialized;
}

/** Only a missing/null stored index is empty. undefined, old versions and corruption throw. */
export function parseNotebookIndex(value: unknown): NotebookIndex {
  return value === null ? emptyIndex() : validateNotebookIndex(value);
}

/** Unlike parseNotebookIndex, null is rejected, including results of mutation callbacks. */
export function validateNotebookIndex(value: unknown): NotebookIndex {
  const input = record(value, 'Notebook index');
  knownKeys(input, ['version', 'nodes'], 'Notebook index');
  if (input.version !== 1 || !Array.isArray(input.nodes)) {
    throw new NotebookValidationError('Invalid notebook index version or nodes');
  }
  const nodes: NotebookNode[] = [];
  const byId = new Map<string, NotebookNode>();
  for (const item of input.nodes) {
    const node = record(item, 'Notebook node');
    knownKeys(node, ['id', 'kind', 'parentId', 'title', 'createdAt', 'updatedAt', 'trashedAt'], 'Notebook node');
    const id = validateNodeId(node.id);
    if (byId.has(id)) throw new NotebookValidationError(`Duplicate notebook node id: ${id}`);
    if (node.kind !== 'folder' && node.kind !== 'note') {
      throw new NotebookValidationError(`Invalid notebook node kind: ${id}`);
    }
    const parsed: NotebookNode = {
      id,
      kind: node.kind,
      parentId: node.parentId === null ? null : validateNodeId(node.parentId),
      title: title(node.title, false),
      createdAt: timestamp(node.createdAt),
      updatedAt: timestamp(node.updatedAt),
    };
    if ('trashedAt' in node) parsed.trashedAt = timestamp(node.trashedAt);
    nodes.push(parsed);
    byId.set(id, parsed);
  }
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const parent = byId.get(node.parentId);
    if (!parent || parent.kind !== 'folder') {
      throw new NotebookValidationError(`Missing folder parent for notebook node: ${node.id}`);
    }
    if (parent.trashedAt && !node.trashedAt) {
      throw new NotebookValidationError(`Active notebook node has a trashed parent: ${node.id}`);
    }
  }
  const checked = new Set<string>();
  for (const node of nodes) {
    const path = new Set<string>();
    let current: NotebookNode | undefined = node;
    while (current && !checked.has(current.id)) {
      if (path.has(current.id)) throw new NotebookValidationError('Notebook tree contains a cycle');
      path.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    for (const id of path) checked.add(id);
  }
  const result: NotebookIndex = { version: 1, nodes };
  checkSize(result, NOTEBOOK_INDEX_MAX_BYTES, 'Notebook index');
  return result;
}

/** Reject values JSON.stringify would silently drop/change, not just JSON syntax errors. */
function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') {
    throw new NotebookValidationError('Notebook comments must contain JSON values only');
  }
  if (ancestors.has(value)) throw new NotebookValidationError('Notebook comments contain a cycle');
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertJson(value[i], ancestors);
  } else {
    const object = record(value, 'Notebook comment');
    if (Object.getOwnPropertySymbols(object).length) {
      throw new NotebookValidationError('Notebook comments contain unsupported symbol keys');
    }
    for (const child of Object.values(object)) assertJson(child, ancestors);
  }
  ancestors.delete(value);
}

/** null is not a stored document. The controller initializes only a genuinely missing file. */
export function parseNotebookDocument(value: unknown): NotebookDocument {
  const input = record(value, 'Notebook document');
  knownKeys(input, ['version', 'editorState', 'comments'], 'Notebook document');
  if (input.version !== 1 || !Array.isArray(input.comments)) {
    throw new NotebookValidationError('Invalid notebook document version or comments');
  }
  if (input.editorState !== null) {
    if (typeof input.editorState !== 'string') {
      throw new NotebookValidationError('Notebook editorState must be serialized JSON or null');
    }
    let state: unknown;
    try {
      state = JSON.parse(input.editorState);
    } catch {
      throw new NotebookValidationError('Notebook editorState contains invalid JSON');
    }
    record(state, 'Notebook editorState');
  }
  assertJson(input.comments);
  const result: NotebookDocument = {
    version: 1,
    editorState: input.editorState as string | null,
    comments: input.comments,
  };
  // A detached snapshot prevents later editor changes from changing an in-flight save.
  return JSON.parse(checkSize(result, NOTEBOOK_DOCUMENT_MAX_BYTES, 'Notebook document')) as NotebookDocument;
}

function findNode(index: NotebookIndex, id: string): NotebookNode {
  validateNodeId(id);
  const node = index.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new NotebookOperationError(`Notebook node not found: ${id}`);
  return node;
}

function activeNode(index: NotebookIndex, id: string): NotebookNode {
  const node = findNode(index, id);
  if (node.trashedAt) throw new NotebookOperationError('Restore the notebook node before editing or moving it');
  return node;
}

function parentFolder(index: NotebookIndex, parentId: string | null): void {
  if (parentId === null) return;
  if (activeNode(index, parentId).kind !== 'folder') {
    throw new NotebookOperationError('Notebook parent must be a folder');
  }
}

function subtree(index: NotebookIndex, id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of index.nodes) {
    if (node.parentId !== null) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node.id);
      children.set(node.parentId, siblings);
    }
  }
  const result = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const current = pending.pop()!;
    result.add(current);
    pending.push(...(children.get(current) ?? []));
  }
  return result;
}

export function createNode(
  index: NotebookIndex,
  options: { kind: NotebookNode['kind']; parentId: string | null; title: string; id?: string; now?: string },
): NotebookIndex {
  const next = validateNotebookIndex(index);
  parentFolder(next, options.parentId);
  const id = validateNodeId(options.id ?? createNodeId());
  if (next.nodes.some((node) => node.id === id)) throw new NotebookOperationError(`Notebook node already exists: ${id}`);
  const now = timestamp(options.now ?? new Date().toISOString());
  next.nodes.push({ id, kind: options.kind, parentId: options.parentId, title: title(options.title, true), createdAt: now, updatedAt: now });
  return validateNotebookIndex(next);
}

export function renameNode(index: NotebookIndex, id: string, name: string, now?: string): NotebookIndex {
  const next = validateNotebookIndex(index);
  const node = activeNode(next, id);
  const normalized = title(name, true);
  if (node.title === normalized) return next;
  node.title = normalized;
  node.updatedAt = timestamp(now ?? new Date().toISOString());
  return validateNotebookIndex(next);
}

export function moveNode(index: NotebookIndex, id: string, parentId: string | null, now?: string): NotebookIndex {
  const next = validateNotebookIndex(index);
  const node = activeNode(next, id);
  parentFolder(next, parentId);
  if (parentId !== null && subtree(next, id).has(parentId)) {
    throw new NotebookOperationError('Cannot move a notebook node into its own subtree (cycle)');
  }
  if (node.parentId === parentId) return next;
  node.parentId = parentId;
  node.updatedAt = timestamp(now ?? new Date().toISOString());
  return validateNotebookIndex(next);
}

/** Soft-delete the entire subtree; no document files are removed. */
export function trashNode(index: NotebookIndex, id: string, now?: string): NotebookIndex {
  const next = validateNotebookIndex(index);
  if (findNode(next, id).trashedAt) return next;
  const ids = subtree(next, id);
  const at = timestamp(now ?? new Date().toISOString());
  for (const node of next.nodes) {
    if (ids.has(node.id)) {
      node.trashedAt = at;
      node.updatedAt = at;
    }
  }
  return validateNotebookIndex(next);
}

/**
 * Restore the whole subtree, including previously trashed descendants. Restore any trashed
 * ancestors as folders too, so a child can be recovered directly without becoming an orphan.
 * Other branches beneath those ancestors remain in trash.
 */
export function restoreNode(index: NotebookIndex, id: string, now?: string): NotebookIndex {
  const next = validateNotebookIndex(index);
  const node = findNode(next, id);
  if (!node.trashedAt) return next;
  const ids = subtree(next, id);
  const byId = new Map(next.nodes.map((child) => [child.id, child]));
  let parent = node.parentId === null ? undefined : byId.get(node.parentId);
  while (parent?.trashedAt) {
    ids.add(parent.id);
    parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
  }
  const at = timestamp(now ?? new Date().toISOString());
  for (const child of next.nodes) {
    if (ids.has(child.id)) {
      delete child.trashedAt;
      child.updatedAt = at;
    }
  }
  return validateNotebookIndex(next);
}

export interface NotebookTreeEntry {
  node: NotebookNode;
  depth: number;
  hasChildren: boolean;
}

/**
 * Preserve sibling/index order. showTrash selects only trash; its topmost nodes become roots.
 * Omitted expanded means expand all. Search includes matching titles and their ancestors,
 * ignoring expansion so a match cannot remain hidden inside a collapsed folder.
 */
export function flattenVisibleTree(
  index: NotebookIndex,
  options: { expanded?: ReadonlySet<string>; query?: string; showTrash?: boolean } = {},
): NotebookTreeEntry[] {
  const valid = validateNotebookIndex(index);
  const nodes = valid.nodes.filter((node) => Boolean(node.trashedAt) === Boolean(options.showTrash));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const query = options.query?.trim().toLowerCase() ?? '';
  const included = new Set<string>();
  for (const node of nodes) {
    if (query && !node.title.toLowerCase().includes(query)) continue;
    let current: NotebookNode | undefined = node;
    while (current && !included.has(current.id)) {
      included.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  const children = new Map<string | null, NotebookNode[]>();
  for (const node of nodes) {
    if (!included.has(node.id)) continue;
    const parentId = node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(node);
    children.set(parentId, siblings);
  }
  const pending = (children.get(null) ?? []).map((node) => ({ node, depth: 0 })).reverse();
  const result: NotebookTreeEntry[] = [];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    const descendants = children.get(node.id) ?? [];
    result.push({ node, depth, hasChildren: descendants.length > 0 });
    if (query || !options.expanded || options.expanded.has(node.id)) {
      for (let i = descendants.length - 1; i >= 0; i--) pending.push({ node: descendants[i]!, depth: depth + 1 });
    }
  }
  return result;
}
