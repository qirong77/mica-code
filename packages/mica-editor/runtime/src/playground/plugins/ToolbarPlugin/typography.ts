import { $isHeadingNode, type HeadingTagType } from '@lexical/rich-text';
import { $getSelectionStyleValueForProperty } from '@lexical/selection';
import { type TableSelection } from '@lexical/table';
import {
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
} from 'lexical';

export const NOTEBOOK_BODY_FONT_SIZE = 15;
export const HEADING_FONT_SIZES: Record<HeadingTagType, number> = {
  h1: 28,
  h2: 24,
  h3: 20,
  h4: 16,
  h5: 15,
  h6: 15,
};
export const FONT_SIZE_PRESETS = [12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 36, 48, 56, 64];

function $getInheritedFontSize(editor: LexicalEditor, node: LexicalNode): string {
  const dom = editor.getElementByKey(node.getKey());
  const computed = dom?.ownerDocument.defaultView?.getComputedStyle(dom).fontSize;
  if (computed && Number.parseFloat(computed) > 0) return computed;

  // Empty blocks and headless readers still have a deterministic display size.
  let block: LexicalNode | null = node;
  while (block !== null) {
    if ($isHeadingNode(block)) return `${HEADING_FONT_SIZES[block.getTag()]}px`;
    block = block.getParent();
  }
  return `${NOTEBOOK_BODY_FONT_SIZE}px`;
}

/** Explicit text styles win over the block's CSS; mixed sizes stay blank. */
export function $getToolbarFontSize(editor: LexicalEditor, selection: RangeSelection | TableSelection): string {
  const inherited = '__inherited__';
  const explicit = $getSelectionStyleValueForProperty(selection, 'font-size', inherited);
  if (explicit !== inherited) return explicit;

  const nodes =
    $isRangeSelection(selection) && selection.isCollapsed()
      ? [selection.anchor.getNode()]
      : selection
          .getNodes()
          .filter((node) => $isTextNode(node) || ($isElementNode(node) && node.getChildrenSize() === 0));
  const sizes = new Set(nodes.map((node) => $getInheritedFontSize(editor, node)));
  return sizes.size === 1 ? [...sizes][0] : '';
}
