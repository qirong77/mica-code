import {$isCodeNode, type CodeNode} from '@lexical/code';
import {
  $addUpdateTag,
  $createParagraphNode,
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  HISTORY_PUSH_TAG,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  type NodeKey,
  type PointType,
} from 'lexical';

export function $getCodeBlock(key: NodeKey): CodeNode | null {
  const node = $getNodeByKey(key);
  return $isCodeNode(node) && node.isAttached() ? node : null;
}

function $findCodeBlock(node: LexicalNode): CodeNode | null {
  let current: LexicalNode | null = node;
  while (current) {
    if ($isCodeNode(current)) return current;
    current = current.getParent();
  }
  return null;
}

/** A range crossing a block boundary must not activate either block's tools. */
export function $getSelectedCodeBlock(): CodeNode | null {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    const anchor = $findCodeBlock(selection.anchor.getNode());
    const focus = $findCodeBlock(selection.focus.getNode());
    return anchor && anchor.is(focus) ? anchor : null;
  }
  if ($isNodeSelection(selection)) {
    const nodes = selection.getNodes();
    return nodes.length === 1 && $isCodeNode(nodes[0]) ? nodes[0] : null;
  }
  return null;
}

export function $setCodeBlockLanguage(
  editor: LexicalEditor,
  key: NodeKey,
  language: string,
): boolean {
  const code = $getCodeBlock(key);
  if (!editor.isEditable() || !code || (code.getLanguage() || '') === language) {
    return false;
  }
  $addUpdateTag(HISTORY_PUSH_TAG);
  code.setLanguage(language || undefined);
  return true;
}

/** Reuse a following paragraph, including its content, without consuming code. */
export function $exitCodeBlock(editor: LexicalEditor, key: NodeKey): boolean {
  const code = $getCodeBlock(key);
  if (!editor.isEditable() || !code) return false;
  const next = code.getNextSibling();
  if ($isParagraphNode(next)) {
    next.selectStart();
  } else {
    $addUpdateTag(HISTORY_PUSH_TAG);
    code.insertAfter($createParagraphNode()).selectStart();
  }
  return true;
}

export type CodeSnapshot = {
  key: NodeKey;
  language: string;
  content: string;
};

export function $readCodeSnapshot(key: NodeKey): CodeSnapshot | null {
  const code = $getCodeBlock(key);
  return code
    ? {key, language: code.getLanguage() || '', content: code.getTextContent()}
    : null;
}

function $codeOffset(code: CodeNode, point: PointType): number | null {
  const children = code.getChildren();
  if (point.key === code.getKey()) {
    return children.slice(0, point.offset).reduce((sum, node) => sum + node.getTextContentSize(), 0);
  }
  let offset = 0;
  for (const child of children) {
    if (child.getKey() === point.key) return offset + point.offset;
    offset += child.getTextContentSize();
  }
  return null;
}

function $setCodePoint(code: CodeNode, point: PointType, offset: number): void {
  let remaining = Math.min(offset, code.getTextContentSize());
  const children = code.getChildren();
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    const size = child.getTextContentSize();
    if ($isTextNode(child) && remaining <= size) {
      point.set(child.getKey(), remaining, 'text');
      return;
    }
    if (remaining === 0) {
      point.set(code.getKey(), index, 'element');
      return;
    }
    remaining -= size;
  }
  point.set(code.getKey(), children.length, 'element');
}

/** Prettier loads asynchronously: never overwrite edits made while it loads. */
export function $applyFormattedCode(
  editor: LexicalEditor,
  snapshot: CodeSnapshot,
  formatted: string,
): 'applied' | 'unchanged' | 'stale' {
  const code = $getCodeBlock(snapshot.key);
  if (
    !editor.isEditable() ||
    !code ||
    code.getTextContent() !== snapshot.content ||
    (code.getLanguage() || '') !== snapshot.language
  ) {
    return 'stale';
  }
  if (formatted === snapshot.content) return 'unchanged';

  // A committed selection is frozen. Clone it before remapping points in the
  // replaced code; points in other blocks keep their original nodes/offsets.
  const saved = $getSelection()?.clone() ?? null;
  const anchorOffset = $isRangeSelection(saved) ? $codeOffset(code, saved.anchor) : null;
  const focusOffset = $isRangeSelection(saved) ? $codeOffset(code, saved.focus) : null;
  $addUpdateTag(HISTORY_PUSH_TAG);
  code.select(0, code.getChildrenSize()).insertRawText(formatted);
  if ($isRangeSelection(saved)) {
    if (anchorOffset !== null) $setCodePoint(code, saved.anchor, anchorOffset);
    if (focusOffset !== null) $setCodePoint(code, saved.focus, focusOffset);
  }
  $setSelection(saved);
  return 'applied';
}

export function registerCodeWritingCommands(
  editor: LexicalEditor,
  focusTools: (key: NodeKey) => void,
): () => void {
  return mergeRegister(
    editor.registerCommand(KEY_ENTER_COMMAND, (event, activeEditor) => {
      if (
        activeEditor !== editor || !editor.isEditable() || !event ||
        !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing
      ) return false;
      const code = $getSelectedCodeBlock();
      if (!code || !$exitCodeBlock(editor, code.getKey())) return false;
      event.preventDefault();
      return true;
    }, COMMAND_PRIORITY_HIGH),
    editor.registerCommand(KEY_DOWN_COMMAND, (event, activeEditor) => {
      if (
        activeEditor !== editor || event.key !== 'F10' || !event.altKey ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.isComposing
      ) return false;
      const code = $getSelectedCodeBlock();
      if (!code) return false;
      event.preventDefault();
      focusTools(code.getKey());
      return true;
    }, COMMAND_PRIORITY_LOW),
  );
}
