import {$isCodeNode} from '@lexical/code';
import {$createMarkNode, $isMarkNode, MarkNode} from '@lexical/mark';
import {$forEachSelectedTextNode} from '@lexical/selection';
import {registerNestedElementResolver} from '@lexical/utils';
import {$getNodeByKey, $getRoot, $isElementNode, $isRangeSelection, $isTextNode, $setSelection, type LexicalEditor, type LexicalNode, type RangeSelection} from 'lexical';

export interface NotebookComment extends Record<string, unknown> {
  type: 'comment';
  id: string;
  author: string;
  content: string;
  deleted: boolean;
  timeStamp: number;
}

export interface NotebookThread extends Record<string, unknown> {
  type: 'thread';
  id: string;
  quote: string;
  comments: unknown[];
  resolved?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isNotebookThread(value: unknown): value is NotebookThread {
  return isRecord(value) && value.type === 'thread' && typeof value.id === 'string' &&
    typeof value.quote === 'string' && Array.isArray(value.comments);
}

export function isNotebookComment(value: unknown): value is NotebookComment {
  return isRecord(value) && value.type === 'comment' && typeof value.id === 'string' &&
    typeof value.author === 'string' && typeof value.content === 'string' &&
    typeof value.deleted === 'boolean' && typeof value.timeStamp === 'number' && Number.isFinite(value.timeStamp);
}

export function createNotebookThread(id: string, commentId: string, content: string, quote = '', now = Date.now()): NotebookThread {
  return {type: 'thread', id, quote, comments: [createComment(commentId, content, now)]};
}

function createComment(id: string, content: string, now: number): NotebookComment {
  return {type: 'comment', id, author: '我', content: content.trim(), deleted: false, timeStamp: now};
}

/** Only replace the first matching, understood row. Opaque siblings and fields survive. */
function updateThread(rows: readonly unknown[], id: string, update: (thread: NotebookThread) => NotebookThread): unknown[] {
  const index = rows.findIndex((row) => isNotebookThread(row) && row.id === id);
  if (index < 0) return rows.slice();
  return rows.map((row, i) => i === index ? update(row as NotebookThread) : row);
}

export function replyToNotebookThread(rows: readonly unknown[], id: string, commentId: string, content: string, now = Date.now()): unknown[] {
  if (!content.trim()) return rows.slice();
  return updateThread(rows, id, (thread) => thread.resolved === true ? thread :
    {...thread, comments: [...thread.comments, createComment(commentId, content, now)]});
}

export function resolveNotebookThread(rows: readonly unknown[], id: string, resolved: boolean): unknown[] {
  return updateThread(rows, id, (thread) => ({...thread, resolved}));
}

export function notebookCommentDateTime(timeStamp: number): string | undefined {
  const date = new Date(timeStamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function formatNotebookCommentTime(timeStamp: number, now: number | null = Date.now()): string {
  if (!notebookCommentDateTime(timeStamp)) return '时间未知';
  const elapsed = now === null ? Infinity : now - timeStamp;
  if (elapsed >= 0 && elapsed < 60_000) return '刚刚';
  if (elapsed >= 60_000 && elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed >= 3_600_000 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  const date = new Date(timeStamp);
  return date.toLocaleString('zh-CN', {year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false});
}

export interface NotebookCommentAnchor {
  selection: RangeSelection;
  quote: string;
  nodes: {key: string; text: string; path: string}[];
}

function $commentNodePath(node: LexicalNode): string {
  const path: string[] = [];
  let current: LexicalNode | null = node;
  while (current) {
    path.push(`${current.getKey()}:${current.getIndexWithinParent()}`);
    current = current.getParent();
  }
  return path.join('/');
}

function $hasCommentText(selection: RangeSelection): boolean {
  const [start, end] = selection.isBackward() ? [selection.focus, selection.anchor] : [selection.anchor, selection.focus];
  return selection.getNodes().some((node) => {
    if (!$isTextNode(node) || !node.canHaveFormat()) return false;
    const from = start.key === node.getKey() && start.type === 'text' ? start.offset : 0;
    const to = end.key === node.getKey() && end.type === 'text' ? end.offset : node.getTextContentSize();
    return node.getTextContent().slice(from, to).trim().length > 0;
  });
}

/** Capture in an editor read/update; never persist a DOM Range or guess by quote. */
export function $captureNotebookCommentAnchor(selection: unknown): NotebookCommentAnchor | null {
  if (!$isRangeSelection(selection) || selection.isCollapsed()) return null;
  const captured = selection.clone();
  const quote = captured.getTextContent();
  if (!quote.trim()) return null;
  const nodes = captured.getNodes();
  if (!$hasCommentText(captured)) return null;
  return {
    selection: captured, quote,
    nodes: nodes.map((node) => ({key: node.getKey(), text: node.getTextContent(), path: $commentNodePath(node)})),
  };
}

/** Reject stale keys, changed text and moved offsets instead of anchoring elsewhere. */
export function $isNotebookCommentAnchorValid(anchor: NotebookCommentAnchor): boolean {
  // RangeSelection caches nodes during updates. Always resolve the saved points
  // against today's tree, including after a previous validation in an update.
  const selection = anchor.selection.clone();
  for (const point of [selection.anchor, selection.focus]) {
    const node = $getNodeByKey(point.key);
    if (!node?.isAttached()) return false;
    const size = point.type === 'text' && $isTextNode(node) ? node.getTextContentSize() :
      point.type === 'element' && $isElementNode(node) ? node.getChildrenSize() : -1;
    if (!Number.isInteger(point.offset) || point.offset < 0 || point.offset > size) return false;
  }
  if (anchor.nodes.some(({key, text, path}) => {
    const node = $getNodeByKey(key);
    return !node?.isAttached() || node.getTextContent() !== text || $commentNodePath(node) !== path;
  })) return false;
  try {
    const nodes = selection.getNodes();
    return selection.getTextContent() === anchor.quote && nodes.length === anchor.nodes.length &&
      nodes.every((node, index) => node.getKey() === anchor.nodes[index].key);
  } catch { return false; }
}

/** Code highlighting replaces its inline tree, so a MarkNode cannot survive. */
export function $isNotebookCommentAnchorSupported(anchor: NotebookCommentAnchor): boolean {
  return !anchor.selection.clone().getNodes().some(node => {
    let current: LexicalNode | null = node;
    while (current) {
      if ($isCodeNode(current)) return true;
      current = current.getParent();
    }
    return false;
  });
}

export function $addNotebookCommentAnchor(anchor: NotebookCommentAnchor, id: string, commit: () => boolean = () => true): boolean {
  if (!id || !$isNotebookCommentAnchorValid(anchor) || !$isNotebookCommentAnchorSupported(anchor) || !$hasCommentText(anchor.selection.clone())) return false;
  // A frozen or detached session can reject the write. Check it before any text
  // is split or wrapped, so a rejected comment never leaves an orphan mark.
  if (!commit()) return false;
  // Split only the selected text slices, leaving link boundaries intact. The
  // generic MarkNode wrapper can include a whole link for a partial selection.
  const selection = anchor.selection.clone();
  const backward = selection.isBackward();
  $setSelection(selection);
  $forEachSelectedTextNode(text => {
    const mark = $createMarkNode([id]);
    text.insertBefore(mark);
    mark.append(text);
  });
  // Lexical normalizes single-node text slices to a forward range. Restore the
  // original direction using the mapped points, after all splits and wraps.
  if (selection.isBackward() !== backward) {
    const {key, offset, type} = selection.anchor;
    selection.anchor.set(selection.focus.key, selection.focus.offset, selection.focus.type);
    selection.focus.set(key, offset, type);
  }
  $setSelection(selection);
  return $getNotebookCommentMarks(id).length > 0;
}

/** Include every ancestor mark, including historical marks nested around links. */
export function $getNotebookCommentIDs(node: LexicalNode | null): string[] {
  const ids = new Set<string>();
  let current = node;
  while (current) {
    if ($isMarkNode(current)) for (const id of current.getIDs()) ids.add(id);
    current = current.getParent();
  }
  return [...ids];
}

export function $getNotebookCommentMarks(id: string): MarkNode[] {
  const marks: MarkNode[] = [];
  const visit = (node: LexicalNode) => {
    if ($isMarkNode(node) && node.hasID(id)) marks.push(node);
    if ($isElementNode(node)) node.getChildren().forEach(visit);
  };
  visit($getRoot());
  return marks;
}

export function registerNotebookCommentOverlap(editor: LexicalEditor): () => void {
  return registerNestedElementResolver(editor, MarkNode,
    (node) => $createMarkNode(node.getIDs()),
    (from, to) => { for (const id of from.getIDs()) to.addID(id); });
}
