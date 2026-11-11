import {$isLinkNode} from '@lexical/link';
import {
  $createNodeSelection,
  $findMatchingParent,
  $getNodeByKey,
  $isElementNode,
  $setSelection,
  HISTORY_PUSH_TAG,
  type ElementNode,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';

import {$isImageNode, type ImageNode} from './ImageNode';

/** A stable node key keeps modal and async edits bound to the original image. */
export function updateImage(
  editor: LexicalEditor,
  key: NodeKey,
  change: (node: ImageNode) => void,
  expectedSrc?: string,
): boolean {
  let applied = false;
  if (!editor.isEditable()) return false;
  editor.update(
    () => {
      const node = $getNodeByKey(key);
      if (
        !editor.isEditable() ||
        !$isImageNode(node) ||
        !node.isAttached() ||
        (expectedSrc !== undefined && node.getSrc() !== expectedSrc)
      )
        return;
      change(node);
      applied = true;
    },
    {discrete: true, tag: HISTORY_PUSH_TAG},
  );
  return applied;
}

export function $selectImage(node: ImageNode): void {
  const selection = $createNodeSelection();
  selection.add(node.getKey());
  $setSelection(selection);
}

export function $imageBlock(node: ImageNode): ElementNode | null {
  return $findMatchingParent(
    node,
    (parent): parent is ElementNode => $isElementNode(parent) && !parent.isInline(),
  ) as ElementNode | null;
}

export function $removeImage(node: ImageNode): void {
  const block = $imageBlock(node);
  const parent = node.getParent();
  if ($isLinkNode(parent) && parent.getChildrenSize() === 1) parent.remove();
  else node.remove();
  if (block?.isAttached()) block.selectEnd();
}
