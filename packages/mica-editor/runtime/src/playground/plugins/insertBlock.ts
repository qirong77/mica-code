import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  type LexicalEditor,
} from 'lexical';
import type {DecoratorBlockNode} from '@lexical/react/LexicalDecoratorBlockNode';

import {$insertSlotHostAtRoot} from '../nodes/slotHostEscape';

/**
 * Put a decorator block at the selection and leave an empty paragraph after it,
 * so the next keystroke writes below the block instead of into it. Shared by
 * every block type that inserts itself from a dialog (HTML, component).
 *
 * The node is built by `create` inside the update: Lexical nodes cannot be
 * constructed outside an active editor context.
 */
export function insertBlockNode(editor: LexicalEditor, create: () => DecoratorBlockNode): void {
  editor.update(() => {
    const node = create();
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      const paragraph = $createParagraphNode();
      $getRoot().append(node, paragraph);
      paragraph.selectStart();
      return;
    }
    $insertSlotHostAtRoot(node);
    const next = node.getNextSibling();
    const paragraph = $isParagraphNode(next) ? next : $createParagraphNode();
    if (paragraph.getParent() === null) node.insertAfter(paragraph);
    paragraph.selectStart();
  }, {discrete: true});
}
