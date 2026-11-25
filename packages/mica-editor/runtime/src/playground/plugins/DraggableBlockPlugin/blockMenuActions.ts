/**
 * Block-level document actions behind the floating block menu.
 *
 * Every helper here runs inside an editor update/read context and only ever
 * touches top-level blocks of the notebook document: a caption or a table
 * cell has its own nested editor, and its root is not this root.
 */

import {$createCodeNode} from '@lexical/code';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  type ListType,
} from '@lexical/list';
import {$createHeadingNode, $createQuoteNode, $isHeadingNode} from '@lexical/rich-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $getNearestNodeFromDOMNode,
  $getRoot,
  $isDecoratorNode,
  $isElementNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
} from 'lexical';

/** The notebook title: the first top-level h1, renamed but never removed. */
export function $isFixedNotebookTitle(node: LexicalNode | null | undefined): boolean {
  if (!$isHeadingNode(node)) return false;
  const root = $getRoot();
  return node.getTag() === 'h1' && node.getParent() === root && root.getFirstChild()?.is(node) === true;
}

/** Walk up to the node this document owns; nested editors have another root. */
export function $topLevelNode(node: LexicalNode | null | undefined): LexicalNode | null {
  if (!node) return null;
  const root = $getRoot();
  let current: LexicalNode | null = node;
  while (current && current.getParent() !== root) current = current.getParent();
  return current;
}

export function $topLevelBlock(node: LexicalNode | null | undefined): ElementNode | null {
  const top = $topLevelNode(node);
  return $isElementNode(top) ? top : null;
}

export function $blockForElement(element: Element | null): ElementNode | null {
  if (!element) return null;
  return $topLevelBlock($getNearestNodeFromDOMNode(element));
}

function $moveChildren(from: ElementNode, to: ElementNode): void {
  for (const child of [...from.getChildren()]) to.append(child);
}

function $rememberShape(node: ElementNode, target: ElementNode): void {
  target.setFormat(node.getFormatType());
  target.setIndent(node.getIndent());
  target.setDirection(node.getDirection());
}

/**
 * Delete a block and keep the caret in the document: next sibling first,
 * then the previous one, and an empty document gets a fresh paragraph.
 */
export function $deleteTopLevelBlock(
  block: LexicalNode | null,
  {protectFirstBlock = false}: {protectFirstBlock?: boolean} = {},
): boolean {
  const target = $topLevelNode(block);
  const root = $getRoot();
  if (!target) return false;
  if (protectFirstBlock && $isFixedNotebookTitle(target)) return false;

  const next = target.getNextSibling();
  const previous = target.getPreviousSibling();
  target.remove();
  const focus = next?.isAttached() ? next : previous?.isAttached() ? previous : null;
  if ($isElementNode(focus)) {
    focus.selectStart();
  } else if (root.getChildrenSize() === 0) {
    const paragraph = $createParagraphNode();
    root.append(paragraph);
    paragraph.selectStart();
  }
  return true;
}

/** Select the whole block so COPY/CUT carry its formatting, not just text. */
export function $selectEntireBlock(block: LexicalNode | null): boolean {
  const target = $topLevelNode(block);
  if (!target) return false;
  if ($isDecoratorNode(target)) {
    const selection = $createNodeSelection();
    selection.add(target.getKey());
    $setSelection(selection);
    return true;
  }
  if (!$isElementNode(target)) return false;
  const selection = $createRangeSelection();
  selection.anchor.set(target.getKey(), 0, 'element');
  selection.focus.set(target.getKey(), target.getChildrenSize(), 'element');
  $setSelection(selection);
  return true;
}

/** Indent a block within Lexical's 0..5 range; returns whether it changed. */
export function $shiftBlockIndent(
  block: LexicalNode | null,
  delta: number,
  {protectFirstBlock = false}: {protectFirstBlock?: boolean} = {},
): boolean {
  const target = $topLevelBlock(block);
  if (!target) return false;
  if (protectFirstBlock && $isFixedNotebookTitle(target)) return false;
  const current = target.getIndent();
  const next = Math.min(5, Math.max(0, current + Math.sign(delta)));
  if (next === current) return false;
  target.setIndent(next);
  return true;
}

export type BlockShape = 'paragraph' | 'h2' | 'h3' | 'quote' | 'code' | 'bullet' | 'number';

function $replaceShape(node: ElementNode, shape: Exclude<BlockShape, 'bullet' | 'number'>): ElementNode | null {
  const current =
    ($isHeadingNode(node) && node.getTag() === shape) ||
    (shape === 'paragraph' && node.getType() === 'paragraph') ||
    (shape === 'quote' && node.getType() === 'quote') ||
    (shape === 'code' && node.getType() === 'code');
  if (current) return node;

  const replacement =
    shape === 'paragraph'
      ? $createParagraphNode()
      : shape === 'quote'
        ? $createQuoteNode()
        : shape === 'code'
          ? $createCodeNode()
          : $createHeadingNode(shape);
  $rememberShape(node, replacement);
  $moveChildren(node, replacement);
  node.replace(replacement);
  return replacement;
}

/** Turn a list into the paragraphs it contains, in document order. */
function $unrollList(list: ElementNode): ElementNode[] {
  if (!$isListNode(list)) return [list];
  const root = $getRoot();
  const paragraphs: ElementNode[] = [];
  for (const item of list.getChildren()) {
    if (!$isListItemNode(item)) continue;
    const paragraph = $createParagraphNode();
    $rememberShape(item, paragraph);
    $moveChildren(item, paragraph);
    paragraphs.push(paragraph);
  }
  if (!paragraphs.length) paragraphs.push($createParagraphNode());
  let anchor: LexicalNode = list;
  for (const paragraph of paragraphs) {
    anchor.insertAfter(paragraph);
    anchor = paragraph;
  }
  list.remove();
  // Keep a list that was one of several children from leaving the root empty.
  if (root.getChildrenSize() === 0) root.append($createParagraphNode());
  return paragraphs;
}

function $wrapInList(block: ElementNode, listType: ListType): ElementNode {
  const list = $createListNode(listType);
  const item = $createListItemNode();
  $rememberShape(block, item);
  $moveChildren(block, item);
  block.insertBefore(list);
  list.append(item);
  block.remove();
  return list;
}

/**
 * Convert one top-level block between the shapes the block menu offers.
 * Lists convert as a whole: wrapping a paragraph, switching a list's type, or
 * unrolling every item when the target is a plain block shape.
 */
export function $convertBlockShape(
  block: LexicalNode | null,
  shape: BlockShape,
  {protectFirstBlock = false}: {protectFirstBlock?: boolean} = {},
): ElementNode | null {
  const target = $topLevelBlock(block);
  if (!target) return null;
  // The notebook title is the document's h1 and stays one.
  if (protectFirstBlock && $isFixedNotebookTitle(target)) return null;

  if (shape === 'bullet' || shape === 'number') {
    const listType: ListType = shape === 'bullet' ? 'bullet' : 'number';
    if ($isListNode(target)) {
      if (target.getListType() === listType) return target;
      target.setListType(listType);
      return target;
    }
    const list = $wrapInList(target, listType);
    const item = list.getFirstChild();
    if ($isListItemNode(item)) item.selectStart();
    return list;
  }

  const blocks = $isListNode(target) ? $unrollList(target) : [target];
  let first: ElementNode | null = null;
  for (const blockNode of blocks) {
    const converted = $replaceShape(blockNode, shape);
    if (converted && !first) first = converted;
    if (converted) converted.selectStart();
  }
  return first;
}

/** Reset a block to a plain paragraph, unrolling lists item by item. */
export function $convertBlockToParagraph(block: ElementNode | null): ElementNode | null {
  return $convertBlockShape(block, 'paragraph');
}

/** The block kind, for menu labels and disabled states. */
export function $blockShape(block: LexicalNode | null): BlockShape | null {
  const target = $topLevelBlock(block);
  if (!target) return null;
  if ($isListNode(target)) return target.getListType() === 'number' ? 'number' : 'bullet';
  if ($isHeadingNode(target)) {
    const tag = target.getTag();
    return tag === 'h1' ? 'paragraph' : tag === 'h2' ? 'h2' : tag === 'h3' ? 'h3' : 'paragraph';
  }
  if (target.getType() === 'quote') return 'quote';
  if (target.getType() === 'code') return 'code';
  return 'paragraph';
}
