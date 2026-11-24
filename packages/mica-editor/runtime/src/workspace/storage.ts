import {$getNodeByKey, $getRoot, $isTextNode, type EditorState, type NodeKey} from 'lexical';

/** Count visible non-whitespace Unicode characters, not UTF-16 code units. */
export function countCharacters(text: string): number {
  return Array.from(text.replace(/\s/g, '')).length;
}

/**
 * The status bar only needs a character total, but rebuilding the whole root's
 * text string for every keystroke is needlessly expensive for long notes. Keep
 * the per-text-node contributions so ordinary text edits can update the total
 * without walking the document again. Structural edits conservatively fall
 * back to a full read; the caller still gets exactly the old root-text count.
 */
export interface NotebookCharacterCountCache {
  total: number;
  leaves: Map<NodeKey, number>;
}

function $readNotebookCharacterCount(): NotebookCharacterCountCache {
  const root = $getRoot();
  const leaves = new Map<NodeKey, number>();
  for (const node of root.getAllTextNodes()) leaves.set(node.getKey(), countCharacters(node.getTextContent()));
  return {total: countCharacters(root.getTextContent()), leaves};
}

export function readNotebookCharacterCount(editorState: EditorState): NotebookCharacterCountCache {
  return editorState.read($readNotebookCharacterCount);
}

/**
 * Apply a Lexical update to a character-count cache. Lexical marks parent
 * elements as `false` for a leaf-only text edit and as `true` for structural
 * changes; a missing/removed leaf also forces the safe full scan.
 */
export function updateNotebookCharacterCount(
  editorState: EditorState,
  previous: NotebookCharacterCountCache,
  dirtyElements: ReadonlyMap<NodeKey, boolean>,
  dirtyLeaves: ReadonlySet<NodeKey>,
): number {
  const nonRoot = [...dirtyElements].filter(([key]) => key !== 'root');
  const requiresFullRead = !dirtyLeaves.size || !nonRoot.length || nonRoot.some(([, dirty]) => dirty);
  if (requiresFullRead) {
    const next = readNotebookCharacterCount(editorState);
    previous.total = next.total;
    previous.leaves = next.leaves;
    return next.total;
  }

  let total: number | null = previous.total;
  editorState.read(() => {
    for (const key of dirtyLeaves) {
      const node = $getNodeByKey(key);
      const oldCount = previous.leaves.get(key);
      if (!$isTextNode(node) || oldCount === undefined) {
        total = null;
        return;
      }
      const nextCount = countCharacters(node.getTextContent());
      previous.leaves.set(key, nextCount);
      total! += nextCount - oldCount;
    }
  });

  if (total === null) {
    const next = readNotebookCharacterCount(editorState);
    previous.total = next.total;
    previous.leaves = next.leaves;
    return next.total;
  }
  previous.total = total;
  return total;
}
