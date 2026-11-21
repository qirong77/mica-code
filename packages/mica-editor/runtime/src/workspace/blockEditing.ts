import {$isHeadingNode, $isQuoteNode} from '@lexical/rich-text';
import {$isAtStartOfNode} from '@lexical/utils';
import {
  $createParagraphNode,
  $findMatchingParent,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isParagraphNode,
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

function $isFixedNotebookTitle(block: ElementNode | null): boolean {
  const root = $getRoot();
  return $isHeadingNode(block) && block.getTag() === 'h1' && block.getParent() === root && root.getFirstChild() === block;
}

function $clearBlockStyleAtStart(
  editor: LexicalEditor,
  commandEditor: LexicalEditor,
  isFixedTitle: (block: ElementNode | null) => boolean,
  enterBody: boolean,
): boolean {
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

  // The first top-level H1 is the notebook title. Enter/Backspace at its
  // start must not turn it into a paragraph (or remove it); the title plugin
  // keeps it non-empty and at the head of the document.
  if (isFixedTitle(block)) {
    // The title may be cleared completely, so Enter at its start would
    // otherwise be a dead end with no way into the body.
    if (enterBody && block.isEmpty()) {
      const next = block.getNextSibling();
      if ($isParagraphNode(next) && next.isEmpty()) {
        next.selectStart();
      } else {
        const paragraph = $createParagraphNode();
        block.insertAfter(paragraph);
        paragraph.selectStart();
      }
    }
    return true;
  }

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
export function registerNotebookBlockEditing(
  editor: LexicalEditor,
  {isFixedTitle = $isFixedNotebookTitle}: {isFixedTitle?: (block: ElementNode | null) => boolean} = {},
): () => void {
  return mergeRegister(
    editor.registerCommand(KEY_ENTER_COMMAND, (event, commandEditor) => {
      if (!isPlainKey(event) || !$clearBlockStyleAtStart(editor, commandEditor, isFixedTitle, true)) return false;
      event?.preventDefault();
      return true;
    }, COMMAND_PRIORITY_LOW),
    // beforeinput (including mobile/Safari) can insert a paragraph without a
    // KEY_ENTER_COMMAND. Shift+Enter uses INSERT_LINE_BREAK_COMMAND instead.
    editor.registerCommand(INSERT_PARAGRAPH_COMMAND, (_payload, commandEditor) => (
      $clearBlockStyleAtStart(editor, commandEditor, isFixedTitle, true)
    ), COMMAND_PRIORITY_LOW),
    editor.registerCommand(KEY_BACKSPACE_COMMAND, (event, commandEditor) => {
      if (!isPlainKey(event) || !$clearBlockStyleAtStart(editor, commandEditor, isFixedTitle, false)) return false;
      event.preventDefault();
      return true;
    }, COMMAND_PRIORITY_LOW),
    editor.registerCommand(DELETE_CHARACTER_COMMAND, (backward, commandEditor) => (
      backward && $clearBlockStyleAtStart(editor, commandEditor, isFixedTitle, false)
    ), COMMAND_PRIORITY_LOW),
  );
}
