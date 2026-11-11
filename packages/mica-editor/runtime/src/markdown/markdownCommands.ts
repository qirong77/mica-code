import {$createCodeNode} from '@lexical/code';
import {$isTableSelection} from '@lexical/table';
import {$addUpdateTag, $createTextNode, $getRoot, $getSelection, $isParagraphNode, $isRangeSelection, HISTORY_PUSH_TAG} from 'lexical';

/** Fenced code is a block, never inline content merged into a paragraph/cell. */
export function $insertMarkdownCodeBlock(language: string, source: string): void {
  const selection = $getSelection();
  const root = $getRoot();
  const anchor = $isRangeSelection(selection) || $isTableSelection(selection) ? selection.anchor : null;
  const selected = anchor?.getNode();
  let current = selected && selected !== root ? selected : root.getChildAtIndex(Math.max(0, (anchor?.offset ?? root.getChildrenSize()) - 1));
  // getTopLevelElement() stops at a shadow root (notably table cells). A fenced
  // block must be outside the entire table so its GFM structure remains valid.
  while (current?.getParent() && current.getParent() !== root) current = current.getParent();
  const code = $createCodeNode(language).append($createTextNode(source));
  $addUpdateTag(HISTORY_PUSH_TAG);
  if (current && current !== root) {
    if ($isParagraphNode(current) && !current.getTextContentSize()) current.replace(code);
    else current.insertAfter(code);
  } else root.append(code);
  code.selectEnd();
}
