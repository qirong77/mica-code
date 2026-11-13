import {
  createNotebookController,
  NotebookConflictError,
  type NotebookController,
  type NotebookHost,
  type NotebookStorageVersion,
} from './controller';
import {
  createNode,
  createNodeId,
  moveNode,
  renameNode,
  restoreNode,
  trashNode,
  type NotebookDocument,
  type NotebookIndex,
  type NotebookNode,
} from './model';
import { parseNotebookDocument } from './model';

/** The shape is intentionally structural so the service can also be tested without a plugin host. */
export interface NotebookDataHost {
  read(): unknown | Promise<unknown>;
  write(
    value: unknown,
    options?: { expectedVersion?: NotebookStorageVersion },
  ): unknown | Promise<unknown>;
  documents: {
    read(key: string): unknown | Promise<unknown>;
    write(
      key: string,
      value: unknown,
      options?: { expectedVersion?: NotebookStorageVersion },
    ): unknown | Promise<unknown>;
  };
}

export type NotebookNodeView = {
  id: string;
  /** Stable identifier used by the MCP contract; `id` remains for page/model parity. */
  node_id: string;
  kind: NotebookNode['kind'];
  title: string;
  path: string[];
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  trashed: boolean;
  trashed_at?: string;
};

export type NotebookDocumentView = {
  node: NotebookNodeView;
  version: NotebookStorageVersion;
  missing: boolean;
  text: string;
  text_truncated: boolean;
  editor_state?: string;
};

export type NotebookSearchMatch = {
  node: NotebookNodeView;
  fields: ('title' | 'path' | 'content')[];
  excerpt?: string;
};

const MAX_TEXT_RESULT = 30_000;
const MAX_SEARCH_RESULTS = 100;
const MAX_EXCERPT = 240;

export function createNotebookService(data: NotebookDataHost) {
  const host: NotebookHost = {
    readData: async () => (await data.read()) as never,
    writeData: async (value, options) => (await data.write(value, options)) as never,
    documents: {
      read: async (key) => (await data.documents.read(key)) as never,
      write: async (key, value, options) => (await data.documents.write(key, value, options)) as never,
    },
  };
  const controller = createNotebookController({ host });

  return new NotebookService(controller);
}

export class NotebookService {
  constructor(private readonly controller: NotebookController) {}

  async list(includeTrash = false): Promise<{ today: string; nodes: NotebookNodeView[] }> {
    const index = await this.controller.loadIndex();
    return {
      today: new Date().toISOString().slice(0, 10),
      nodes: index.nodes
        .filter((node) => Boolean(node.trashedAt) === includeTrash)
        .map((node) => nodeView(index, node)),
    };
  }

  async search(query: string, includeTrash = false): Promise<{ query: string; matches: NotebookSearchMatch[] }> {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) throw new Error('query 不能为空');
    const index = await this.controller.loadIndex();
    const matches: NotebookSearchMatch[] = [];
    for (const node of index.nodes) {
      if (Boolean(node.trashedAt) !== includeTrash) continue;
      const view = nodeView(index, node);
      const fields: NotebookSearchMatch['fields'] = [];
      const title = node.title.toLocaleLowerCase();
      const path = view.path.join(' / ').toLocaleLowerCase();
      if (title.includes(normalized)) fields.push('title');
      if (path.includes(normalized) && !fields.includes('path')) fields.push('path');
      let excerpt: string | undefined;
      if (node.kind === 'note') {
        const snapshot = await this.controller.readDocument(node.id);
        const content = notebookText(snapshot.value.editorState);
        if (content.toLocaleLowerCase().includes(normalized)) {
          fields.push('content');
          excerpt = excerptAround(content, normalized);
        }
      }
      if (fields.length > 0) matches.push({ node: view, fields, ...(excerpt ? { excerpt } : {}) });
      if (matches.length >= MAX_SEARCH_RESULTS) break;
    }
    return { query: query.trim(), matches };
  }

  async read(
    id: string,
    includeEditorState = false,
  ): Promise<NotebookNodeView & { children: NotebookNodeView[] } | NotebookDocumentView> {
    const index = await this.controller.loadIndex();
    const node = findNode(index, id);
    const view = nodeView(index, node);
    if (node.kind === 'folder') {
      return {
        ...view,
        children: index.nodes
          .filter((candidate) => candidate.parentId === node.id)
          .map((candidate) => nodeView(index, candidate)),
      };
    }
    const snapshot = await this.controller.readDocument(node.id);
    const text = notebookText(snapshot.value.editorState);
    return {
      node: view,
      version: snapshot.version,
      missing: snapshot.missing,
      text: text.slice(0, MAX_TEXT_RESULT),
      text_truncated: text.length > MAX_TEXT_RESULT,
      ...(includeEditorState && snapshot.value.editorState !== null
        ? { editor_state: snapshot.value.editorState }
        : {}),
    };
  }

  async create(kind: NotebookNode['kind'], title: string, parentId: string | null): Promise<NotebookNodeView> {
    const id = createNodeId();
    const now = new Date().toISOString();
    const index = await this.controller.mutateIndex((latest) =>
      createNode(latest, { id, kind, title, parentId, now }),
    );
    return nodeView(index, findNode(index, id));
  }

  async rename(id: string, title: string): Promise<NotebookNodeView> {
    const index = await this.controller.mutateIndex((latest) => renameNode(latest, id, title, new Date().toISOString()));
    return nodeView(index, findNode(index, id));
  }

  async move(id: string, parentId: string | null): Promise<NotebookNodeView> {
    const index = await this.controller.mutateIndex((latest) => moveNode(latest, id, parentId, new Date().toISOString()));
    return nodeView(index, findNode(index, id));
  }

  async trash(id: string): Promise<{ node: NotebookNodeView; affected_ids: string[] }> {
    const before = await this.controller.loadIndex();
    const index = await this.controller.mutateIndex((latest) => trashNode(latest, id, new Date().toISOString()));
    const affected_ids = index.nodes
      .filter((node) => node.trashedAt && !before.nodes.find((previous) => previous.id === node.id)?.trashedAt)
      .map((node) => node.id);
    return { node: nodeView(index, findNode(index, id)), affected_ids };
  }

  async restore(id: string): Promise<{ node: NotebookNodeView; restored_ids: string[] }> {
    const before = await this.controller.loadIndex();
    const index = await this.controller.mutateIndex((latest) => restoreNode(latest, id, new Date().toISOString()));
    const restored_ids = index.nodes
      .filter((node) => !node.trashedAt && before.nodes.find((previous) => previous.id === node.id)?.trashedAt)
      .map((node) => node.id);
    return { node: nodeView(index, findNode(index, id)), restored_ids };
  }

  async updateDocument(
    id: string,
    expectedVersion: NotebookStorageVersion,
    update: (document: NotebookDocument) => NotebookDocument,
  ): Promise<NotebookDocumentView> {
    const index = await this.controller.loadIndex();
    const node = findNode(index, id);
    if (node.kind !== 'note') throw new Error('只有笔记节点有正文，不能编辑文件夹');
    if (node.trashedAt) throw new Error('请先恢复笔记，再编辑正文');
    const snapshot = await this.controller.readDocument(id);
    if (snapshot.version !== expectedVersion) {
      throw new NotebookConflictError(`document ${id}`);
    }
    const next = parseNotebookDocument(update(snapshot.value));
    const version = await this.controller.saveDocument(id, next, { expectedVersion });
    const text = notebookText(next.editorState);
    return {
      node: nodeView(index, node),
      version,
      missing: false,
      text: text.slice(0, MAX_TEXT_RESULT),
      text_truncated: text.length > MAX_TEXT_RESULT,
    };
  }

  async readDocumentForUpdate(id: string): Promise<NotebookDocument> {
    const index = await this.controller.loadIndex();
    const node = findNode(index, id);
    if (node.kind !== 'note') throw new Error('只有笔记节点有正文');
    if (node.trashedAt) throw new Error('请先恢复笔记，再编辑正文');
    return (await this.controller.readDocument(id)).value;
  }
}

function findNode(index: NotebookIndex, id: string): NotebookNode {
  const node = index.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Notebook node not found: ${id}`);
  return node;
}

function nodeView(index: NotebookIndex, node: NotebookNode): NotebookNodeView {
  const path: string[] = [];
  const byId = new Map(index.nodes.map((candidate) => [candidate.id, candidate]));
  let current: NotebookNode | undefined = node;
  while (current) {
    path.unshift(current.title);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return {
    id: node.id,
    node_id: node.id,
    kind: node.kind,
    title: node.title,
    path,
    parent_id: node.parentId,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    trashed: Boolean(node.trashedAt),
    ...(node.trashedAt ? { trashed_at: node.trashedAt } : {}),
  };
}

function excerptAround(content: string, query: string): string {
  const index = content.toLocaleLowerCase().indexOf(query);
  if (index < 0) return content.slice(0, MAX_EXCERPT);
  const start = Math.max(0, index - Math.floor(MAX_EXCERPT / 2));
  const end = Math.min(content.length, start + MAX_EXCERPT);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

/** Lexical is intentionally not a dependency of the host process; walk its JSON projection instead. */
export function notebookText(editorState: string | null): string {
  if (editorState === null) return '';
  let state: unknown;
  try {
    state = JSON.parse(editorState);
  } catch {
    return '';
  }
  const parts: string[] = [];
  const root = state && typeof state === 'object' && !Array.isArray(state)
    ? (state as Record<string, unknown>).root ?? state
    : state;
  collectText(root, parts);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function collectText(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectText(item, parts);
      if (index < value.length - 1) parts.push('\n');
    });
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') {
    parts.push(record.text);
    return;
  }
  if (Array.isArray(record.children)) {
    const children = record.children;
    children.forEach((child, index) => {
      collectText(child, parts);
      if (index < children.length - 1) parts.push('');
    });
    if (record.type !== 'root') parts.push('\n');
    return;
  }
  // Compatibility with small synthetic documents used by older callers/tests.
  if (typeof record.text === 'string') parts.push(record.text);
}

export function appendPlainText(document: NotebookDocument, text: string, prepend = false): NotebookDocument {
  const parsed = parseNotebookDocument(document);
  const state = parsed.editorState === null ? { root: createRoot() } : JSON.parse(parsed.editorState) as Record<string, unknown>;
  const root = asRecord(state.root, 'Notebook editorState root');
  const children = Array.isArray(root.children) ? [...root.children] : [];
  const paragraph = createParagraph(text);
  if (prepend) children.unshift(paragraph);
  else children.push(paragraph);
  root.children = children;
  root.type ??= 'root';
  root.version ??= 1;
  return parseNotebookDocument({ version: 1, editorState: JSON.stringify(state) });
}

export function replaceText(
  document: NotebookDocument,
  find: string,
  replacement: string,
  replaceAll: boolean,
): { document: NotebookDocument; count: number } {
  if (!find) throw new Error('find 不能为空');
  const parsed = parseNotebookDocument(document);
  if (parsed.editorState === null) throw new Error('笔记正文为空，无法查找要替换的文字');
  const state = JSON.parse(parsed.editorState) as unknown;
  let count = 0;
  let matches = 0;
  visitTextFields(state, (value) => {
    const occurrences = countOccurrences(value, find);
    if (!occurrences) return value;
    matches += occurrences;
    if (!replaceAll && matches > 1) return value;
    const next = replaceAll ? value.split(find).join(replacement) : value.replace(find, replacement);
    count += replaceAll ? occurrences : 1;
    return next;
  });
  if (matches === 0) throw new Error(`没有找到要替换的文字：${find}`);
  if (!replaceAll && matches > 1) throw new Error(`找到 ${matches} 处匹配；请显式传 replace_all: true，或缩小 find 范围`);
  return { document: parseNotebookDocument({ version: 1, editorState: JSON.stringify(state) }), count };
}

export function plainTextDocument(text: string): NotebookDocument {
  return parseNotebookDocument({ version: 1, editorState: JSON.stringify({ root: createRoot(text) }) });
}

function createRoot(initialText?: string): Record<string, unknown> {
  return {
    children: initialText === undefined ? [] : [createParagraph(initialText)],
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  };
}

function createParagraph(text: string): Record<string, unknown> {
  return {
    children: [{ detail: 0, format: 0, mode: 'normal', style: '', text, type: 'text', version: 1 }],
    direction: null,
    format: '',
    indent: 0,
    type: 'paragraph',
    version: 1,
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 不是对象`);
  return value as Record<string, unknown>;
}

function visitTextFields(value: unknown, transform: (value: string) => string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visitTextFields(item, transform));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === 'text' && typeof child === 'string') record[key] = transform(child);
    else visitTextFields(child, transform);
  }
}

function countOccurrences(value: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(search, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + search.length;
  }
}

