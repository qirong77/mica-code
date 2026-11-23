import type { NotebookDocument } from './model';

export type ComponentBlockType = 'component' | 'html';

export type ComponentBlock = {
  /** Indexes from root.children, counting all siblings. Only stable within a document version. */
  block_id: string;
  path: number[];
  type: ComponentBlockType;
  source: string;
};

export class ComponentBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComponentBlockError';
  }
}

type JsonRecord = Record<string, unknown>;
type EditorState = JsonRecord & { root: JsonRecord & { children: unknown[] } };
type BlockWrite = { document: NotebookDocument; block: ComponentBlock };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only null is uninitialized. Never turn a damaged state into an empty note. */
function readState(editorState: string | null): EditorState {
  if (editorState === null) {
    return { root: { children: [], direction: null, format: '', indent: 0, type: 'root', version: 1 } };
  }
  let state: unknown;
  try {
    state = JSON.parse(editorState);
  } catch {
    throw new ComponentBlockError('editorState 不是有效的 JSON');
  }
  if (!isRecord(state) || !isRecord(state.root) || !Array.isArray(state.root.children)) {
    throw new ComponentBlockError('editorState 缺少有效的 root.children 数组');
  }
  return state as EditorState;
}

function isBlockType(value: unknown): value is ComponentBlockType {
  return value === 'component' || value === 'html';
}

function sourceKey(type: ComponentBlockType): 'code' | 'html' {
  return type === 'component' ? 'code' : 'html';
}

/** Markdown fences and direct block writes must create exactly the same Lexical node. */
export function serializedBlock(type: ComponentBlockType, source: string): JsonRecord {
  return { type, version: 1, direction: null, format: '', indent: 0, [sourceKey(type)]: source };
}

function nonemptySource(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new ComponentBlockError('source 必须是非空源码字符串');
}

function blockView(path: number[], type: ComponentBlockType, source: string): ComponentBlock {
  return { block_id: path.join('.'), path, type, source };
}

/** Traverse only editor children, not unrelated JSON such as node metadata or captions. */
export function listComponentBlocks(editorState: string | null): ComponentBlock[] {
  const blocks: ComponentBlock[] = [];
  const path: number[] = [];
  function visit(children: unknown[]) {
    children.forEach((child, index) => {
      if (!isRecord(child)) return;
      path.push(index);
      if (isBlockType(child.type)) {
        const source = child[sourceKey(child.type)];
        if (typeof source !== 'string') throw new ComponentBlockError(`块 ${path.join('.')} 的源码不是字符串`);
        blocks.push(blockView([...path], child.type, source));
      }
      if (Array.isArray(child.children)) visit(child.children);
      path.pop();
    });
  }
  visit(readState(editorState).root.children);
  return blocks;
}

export function appendComponentBlock(
  editorState: string | null,
  type: unknown,
  source: unknown,
  position: unknown = 'append',
): BlockWrite {
  if (!isBlockType(type)) throw new ComponentBlockError('type 只能是 component 或 html');
  nonemptySource(source);
  if (position !== 'append' && position !== 'prepend')
    throw new ComponentBlockError('position 只能是 append 或 prepend');
  const state = readState(editorState);
  const children = state.root.children;
  // Prepend to the body, never in front of its fixed H1 (the editor would insert a second title).
  const first = children[0];
  const bodyStart = isRecord(first) && first.type === 'heading' && first.tag === 'h1' ? 1 : 0;
  const index = position === 'append' ? children.length : bodyStart;
  children.splice(index, 0, serializedBlock(type, source));
  return { document: { version: 1, editorState: JSON.stringify(state) }, block: blockView([index], type, source) };
}

export function updateComponentBlock(editorState: string | null, blockId: string, source: unknown): BlockWrite {
  nonemptySource(source);
  const path = normalizePath(blockId);
  const state = readState(editorState);
  let target: unknown = state.root;
  for (const index of path) {
    if (!isRecord(target) || !Array.isArray(target.children) || index >= target.children.length) {
      throw new ComponentBlockError(`block_id 路径不存在：${blockId}`);
    }
    target = target.children[index];
  }
  if (!isRecord(target) || !isBlockType(target.type)) {
    throw new ComponentBlockError(`block_id ${blockId} 指向的节点不是组件块或 HTML 块`);
  }
  // Change only the source on the detached snapshot: preserve height, format, node state, and siblings.
  target[sourceKey(target.type)] = source;
  return { document: { version: 1, editorState: JSON.stringify(state) }, block: blockView(path, target.type, source) };
}

function normalizePath(value: string): number[] {
  return value.split('.').map((segment) => {
    const index = Number(segment);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== segment) {
      throw new ComponentBlockError('block_id 路径不合法：需要从 root.children 起的数字下标，如 0 或 2.1');
    }
    return index;
  });
}
