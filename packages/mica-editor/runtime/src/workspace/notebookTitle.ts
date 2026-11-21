import {TOGGLE_LINK_COMMAND} from '@lexical/link';
import {INSERT_CHECK_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND} from '@lexical/list';
import {$createHeadingNode, $isHeadingNode, HeadingNode} from '@lexical/rich-text';
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  OUTDENT_CONTENT_COMMAND,
  PASTE_COMMAND,
  TextNode,
} from 'lexical';

export const DEFAULT_NOTEBOOK_TITLE = '未命名笔记';

export function normalizeNotebookTitle(value: string | undefined): string {
  const title = value?.trim();
  return title || DEFAULT_NOTEBOOK_TITLE;
}

export type NotebookTitleState = {
  key: string | null;
  text: string;
  firstIsTitle: boolean;
  /** No inline formatting (code/bold/colors/fonts), no alignment and no indent. */
  plain: boolean;
};

/** The notebook's title block: the first top-level block, when it is an H1. */
export function $getNotebookTitleNode(): HeadingNode | null {
  const first = $getRoot().getFirstChild();
  return first && $isHeadingNode(first) && first.getTag() === 'h1' ? first : null;
}

function $isNotebookTitleNode(node: LexicalNode): boolean {
  if (!$isHeadingNode(node) || node.getTag() !== 'h1') return false;
  const root = $getRoot();
  return node.getParent() === root && root.getFirstChild() === node;
}

function $inTitle(node: LexicalNode | null, title: HeadingNode): boolean {
  let current: LexicalNode | null = node;
  while (current) {
    if (current === title) return true;
    current = current.getParent();
  }
  return false;
}

/** True when the node lives inside the notebook's title block. */
export function $isInsideNotebookTitle(node: LexicalNode | null): boolean {
  const title = $getNotebookTitleNode();
  return title !== null && $inTitle(node, title);
}

/**
 * True when the whole range selection sits inside the title.
 *
 * The toolbar uses this to drop rich-text controls for the title. A range that
 * reaches into the body deliberately reports false: those commands and pastes
 * keep their normal meaning instead of being swallowed for the body's sake.
 */
export function $isNotebookTitleSelection(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  const title = $getNotebookTitleNode();
  if (!title) return false;
  return $inTitle(selection.anchor.getNode(), title) && $inTitle(selection.focus.getNode(), title);
}

function $isPlainTitle(title: HeadingNode): boolean {
  if ($elementFormat(title) !== 0 || title.getIndent() !== 0 ||
      title.getTextFormat() !== 0 || title.getTextStyle() !== '') return false;
  for (const child of title.getChildren()) {
    if ($isTextNode(child)) {
      if (child.getFormat() !== 0 || child.getStyle() !== '') return false;
      continue;
    }
    // A soft break is plain text; anything else (links, inline decorators)
    // would render as more than characters.
    if (!$isLineBreakNode(child)) return false;
  }
  return true;
}

/**
 * Element formatting is stored as bit flags: `setFormat` has no
 * "already this value" guard, so every call dirties the node (and a transform
 * that always calls it loops forever). Compare the bits first.
 */
function $elementFormat(node: ElementNode): number {
  return node.getFormat() as unknown as number;
}

/**
 * Reduce the title block to plain text in place: inline code/bold/italic,
 * colors, background and font styles, links, alignment and indentation all go,
 * the visible characters stay. Node identities are kept where possible so the
 * caret, the selection and the undo entry of the running update survive.
 */
export function $stripNotebookTitleFormatting(title: HeadingNode): boolean {
  let changed = false;
  if ($elementFormat(title) !== 0) { title.setFormat(''); changed = true; }
  if (title.getIndent() !== 0) { title.setIndent(0); changed = true; }
  if (title.getTextFormat() !== 0) { title.setTextFormat(0); changed = true; }
  if (title.getTextStyle() !== '') { title.setTextStyle(''); changed = true; }
  for (const child of title.getChildren()) {
    if ($isTextNode(child)) {
      if (child.getFormat() !== 0) { child.setFormat(0); changed = true; }
      if (child.getStyle() !== '') { child.setStyle(''); changed = true; }
      continue;
    }
    if ($isLineBreakNode(child)) continue;
    child.replace($createTextNode(child.getTextContent()));
    changed = true;
  }
  return changed;
}

/** 读取第一个顶层块是不是标题 H1。调用方负责在 editor state 的读/写上下文里运行。 */
export function $readNotebookTitle(): NotebookTitleState {
  const title = $getNotebookTitleNode();
  return {
    key: title?.getKey() ?? null,
    text: title?.getTextContent() ?? '',
    firstIsTitle: title !== null,
    plain: title !== null && $isPlainTitle(title),
  };
}

/**
 * 保证第一个顶层块是 H1 标题块，返回是否改动了文档。
 *
 * 文字只在 `alignTo` 给定时写入——那是宿主显式改名（目录重命名、API 改名）的路径。
 * 用户把标题删空是合法状态，这里不能再用旧名字填回去，否则标题永远清不干净。
 * 标题只允许普通文本：旧富标题的行内格式在这一次更新里就地清掉。
 */
export function $ensureNotebookTitle(alignTo: string | null): boolean {
  const root = $getRoot();
  const first = root.getFirstChild();
  const heading = first && $isHeadingNode(first) && first.getTag() === 'h1' ? first : null;
  if (heading) {
    let changed = $stripNotebookTitleFormatting(heading);
    if (alignTo !== null && heading.getTextContent() !== alignTo) {
      heading.clear().append($createTextNode(alignTo));
      changed = true;
    }
    return changed;
  }
  const title = $createHeadingNode('h1');
  if (alignTo !== null) title.append($createTextNode(alignTo));
  root.splice(0, 0, [title]);
  return true;
}

/**
 * Pasted text lands in the title as characters: line breaks and runs of
 * whitespace collapse to single spaces, so a multi-line paste stays one line.
 */
export function normalizeNotebookTitlePaste(text: string): string {
  return text.replace(/[^\S\n]+/g, ' ').replace(/[ \t]*\n[ \t\n]*/g, ' ').trim();
}

/** Insert pasted characters at the caret, keeping the title plain text. */
export function $insertNotebookTitleText(raw: string): boolean {
  const text = normalizeNotebookTitlePaste(raw);
  if (!text) return false;
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  selection.insertText(text);
  return true;
}

function $isTitleSelectionEditable(editor: LexicalEditor): boolean {
  return editor.isEditable() && $isNotebookTitleSelection();
}

/**
 * Keep the title plain text while the user works in it.
 *
 * Transforms normalize the same update that made the title dirty (no extra
 * update, no updateListener waterfall, no whole-document scan): a formatted
 * text node or the H1 block itself is cleaned in place. Rich-text commands and
 * paste are handled before the plugins see them, so the Markdown paste prompt
 * and the code-block conversion never fire from the title.
 */
export function registerNotebookTitle(editor: LexicalEditor): () => void {
  return mergeRegister(
    editor.registerNodeTransform(HeadingNode, node => {
      if ($isNotebookTitleNode(node)) $stripNotebookTitleFormatting(node);
    }),
    editor.registerNodeTransform(TextNode, node => {
      if (node.getFormat() === 0 && node.getStyle() === '') return;
      if (!$isInsideNotebookTitle(node)) return;
      if (node.getFormat() !== 0) node.setFormat(0);
      if (node.getStyle() !== '') node.setStyle('');
    }),
    editor.registerCommand(FORMAT_TEXT_COMMAND, () => $isTitleSelectionEditable(editor), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(FORMAT_ELEMENT_COMMAND, () => $isTitleSelectionEditable(editor), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(TOGGLE_LINK_COMMAND, () => $isTitleSelectionEditable(editor), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(INDENT_CONTENT_COMMAND, () => $isTitleSelectionEditable(editor), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(OUTDENT_CONTENT_COMMAND, () => $isTitleSelectionEditable(editor), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(INSERT_UNORDERED_LIST_COMMAND, () => $isTitleSelectionEditable(editor), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(INSERT_ORDERED_LIST_COMMAND, () => $isTitleSelectionEditable(editor), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(INSERT_CHECK_LIST_COMMAND, () => $isTitleSelectionEditable(editor), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(PASTE_COMMAND, event => {
      if (!$isTitleSelectionEditable(editor)) return false;
      // Handled here, so the Markdown paste prompt never opens for the title and
      // no clipboard flavor (HTML, images, Lexical nodes) can rebuild formats.
      event?.preventDefault();
      $insertNotebookTitleText((event as ClipboardEvent | null)?.clipboardData?.getData('text/plain') ?? '');
      return true;
    }, COMMAND_PRIORITY_CRITICAL),
  );
}
