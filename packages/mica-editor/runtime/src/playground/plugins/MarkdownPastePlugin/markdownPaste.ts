import {$isCodeNode} from '@lexical/code';
import {$generateNodesFromMarkdownString, type Transformer} from '@lexical/markdown';
import {$isTableSelection} from '@lexical/table';
import {$createParagraphNode, $getSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH, HISTORY_PUSH_TAG, $addUpdateTag, PASTE_COMMAND, type LexicalEditor} from 'lexical';

export function isMarkdownText(text: string): boolean {
  return /^(?: {0,3}#{1,6}\s+\S| {0,3}>\s?\S|\s*[-+*]\s+\S|\s*\d+[.)]\s+\S| {0,3}(?:`{3,}|~{3,})|\|?.+\|.+\n\s*\|?\s*:?-{3,})/m.test(text) ||
    /(?:\*\*[^\n*]+\*\*|__[^\n_]+__|!?\[[^\]\n]+\]\([^\s)]+\))/.test(text);
}

// Only unwrap an isolated code payload. Ordinary web/office HTML keeps its
// original formatting, even when its text happens to contain Markdown marks.
export function getMarkdownClipboardText(data: DataTransfer): string | null {
  if (data.files?.length || Array.from(data.types).some(t => /lexical|rtf/i.test(t))) return null;
  const explicit = data.getData('text/markdown') || data.getData('text/x-markdown');
  if (explicit) return explicit;
  let text = data.getData('text/plain');
  const html = data.getData('text/html');
  if (html) {
    if (typeof DOMParser === 'undefined') return null;
    const body = new DOMParser().parseFromString(html, 'text/html').body;
    const meaningful = [...body.childNodes].filter(n => n.nodeType !== 8 && (n.nodeType !== 3 || n.textContent?.trim()));
    if (meaningful.length !== 1 || !(meaningful[0] instanceof Element)) return null;
    let element = meaningful[0];
    while (['DIV', 'SPAN'].includes(element.tagName) && element.children.length === 1 && element.textContent === element.firstElementChild?.textContent) element = element.firstElementChild!;
    if (!['PRE', 'CODE'].includes(element.tagName)) return null;
    const language = element.getAttribute('data-language') || (element.querySelector('code')?.className || element.className).match(/language-([\w-]+)/)?.[1];
    if (language && !/^(markdown|md|text|plaintext)$/i.test(language)) return null;
    text = text || element.textContent || '';
  }
  return isMarkdownText(text) ? text : null;
}

export function registerMarkdownPaste(editor: LexicalEditor, transformers: Transformer[]): () => void {
  return editor.registerCommand(PASTE_COMMAND, event => {
    if (!editor.isEditable() || !event || !('clipboardData' in event) || !event.clipboardData) return false;
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || $isTableSelection(selection)) return false;
    for (const point of [selection.anchor, selection.focus]) {
      let node = point.getNode();
      while (node.getParent()) {
        if ($isCodeNode(node) || node.getType() === 'tablecell') return false;
        node = node.getParent()!;
      }
    }
    const markdown = getMarkdownClipboardText(event.clipboardData);
    if (!markdown) return false;
    const nodes = $generateNodesFromMarkdownString(markdown.replace(/\r\n?/g, '\n'), transformers);
    if (!nodes.length) return false;
    // Absorb Lexical's first-block merge without losing a heading/quote/code
    // block when pasting into a paragraph that already contains text.
    const anchorBlock = selection.anchor.getNode().getTopLevelElement();
    if (nodes[0].getType() !== 'paragraph' && anchorBlock?.getTextContentSize()) {
      nodes.unshift($createParagraphNode());
    }
    $addUpdateTag(HISTORY_PUSH_TAG);
    selection.insertNodes(nodes);
    event.preventDefault();
    return true;
  }, COMMAND_PRIORITY_HIGH);
}
