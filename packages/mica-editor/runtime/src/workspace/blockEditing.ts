import {$isHeadingNode, $isQuoteNode} from '@lexical/rich-text';
import {$isAtStartOfNode} from '@lexical/utils';
import {
  $createParagraphNode,
  $findMatchingParent,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  DELETE_CHARACTER_COMMAND,
  type ElementNode,
  INSERT_PARAGRAPH_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  mergeRegister,
} from 'lexical';

function isPlainKey(event: KeyboardEvent | null): boolean {
  return event === null || !(
    event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
    event.shiftKey || event.altKey || event.ctrlKey || event.metaKey
  );
}

function $clearBlockStyleAtStart(editor: LexicalEditor, commandEditor: LexicalEditor): boolean {
  // Commands from a caption/nested editor can bubble to this editor. Its
  // selection must never cause a mutation in the notebook's document.
  if (commandEditor !== editor || !editor.isEditable() || editor.isComposing()) return false;
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

  const block = $findMatchingParent(
    selection.anchor.getNode(),
    (node): node is ElementNode => $isElementNode(node) && !node.isInline(),
  );
  if (
    (!$isHeadingNode(block) && !$isQuoteNode(block)) ||
    block.isShadowRoot() || block.getParent() === null ||
    !$isAtStartOfNode(selection.anchor, block)
  ) return false;

  const paragraph = $createParagraphNode()
    .setDirection(block.getDirection())
    .setFormat(block.getFormatType())
    .setIndent(block.getIndent())
    .setTextFormat(selection.format)
    .setTextStyle(selection.style);
  // Keep the inline nodes themselves (links and explicit text
  // formatting), and let the paragraph inherit the document's body styles.
  // replace(..., true) also maps element-point selections to the new block.
  block.replace(paragraph, true);
  return true;
}

/** Mount only in the notebook composer, never in the Markdown editor. */
export function registerNotebookBlockEditing(editor: LexicalEditor): () => void {
  return mergeRegister(
    editor.registerCommand(KEY_ENTER_COMMAND, (event, commandEditor) => {
      if (!isPlainKey(event) || !$clearBlockStyleAtStart(editor, commandEditor)) return false;
      event?.preventDefault();
      return true;
    }, COMMAND_PRIORITY_LOW),
    // beforeinput (including mobile/Safari) can insert a paragraph without a
    // KEY_ENTER_COMMAND. Shift+Enter uses INSERT_LINE_BREAK_COMMAND instead.
    editor.registerCommand(INSERT_PARAGRAPH_COMMAND, (_payload, commandEditor) => (
      $clearBlockStyleAtStart(editor, commandEditor)
    ), COMMAND_PRIORITY_LOW),
    editor.registerCommand(KEY_BACKSPACE_COMMAND, (event, commandEditor) => {
      if (!isPlainKey(event) || !$clearBlockStyleAtStart(editor, commandEditor)) return false;
      event.preventDefault();
      return true;
    }, COMMAND_PRIORITY_LOW),
    editor.registerCommand(DELETE_CHARACTER_COMMAND, (backward, commandEditor) => (
      backward && $clearBlockStyleAtStart(editor, commandEditor)
    ), COMMAND_PRIORITY_LOW),
  );
}
