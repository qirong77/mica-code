import {$isCodeNode} from '@lexical/code';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$isHeadingNode} from '@lexical/rich-text';
import {$isTableNode} from '@lexical/table';
import {$getNodeByKey, $getRoot, $isElementNode, type LexicalNode, type NodeKey} from 'lexical';
import {useEffect} from 'react';

import {type NotebookSession} from './NotebookBridge';

export type NotebookBlock = 'table' | 'code' | 'mermaid' | 'image';
export interface NotebookNavigation {
  heading?: NodeKey;
  block?: 'top' | NotebookBlock;
}
export interface NotebookOutlineItem {
  key: NodeKey;
  text: string;
  level: number;
  /** Nearest preceding heading with a lower level; null means root of outline. */
  parentKey?: NodeKey | null;
}
export interface NotebookOutlineSnapshot {
  items: NotebookOutlineItem[];
  activeKey: NodeKey | null;
  blocks: Record<NotebookBlock, boolean>;
}
export interface NotebookOutlineDocument {
  items: NotebookOutlineItem[];
  blocks: Record<NotebookBlock, boolean>;
  blockKeys: Record<NotebookBlock, NodeKey | null>;
}
export interface NotebookOutlinePosition {
  key: NodeKey;
  top: number;
}

/**
 * A leaf-only body edit cannot change outline metadata. Lexical marks the
 * parent element as `false` for that case; structural edits either have no
 * dirty leaves or intentionally dirty a non-root element. Keeping this rule
 * explicit prevents a full tree walk on every ordinary body keystroke.
 */
export function shouldRebuildNotebookOutline(
  dirtyElements: ReadonlyMap<NodeKey, boolean>,
  dirtyLeaves: ReadonlySet<NodeKey>,
  dirtyHeadingLeaf: boolean,
): boolean {
  if (dirtyHeadingLeaf || !dirtyLeaves.size) return true;
  const nonRoot = [...dirtyElements].filter(([key]) => key !== 'root');
  // A parent entry with `false` is Lexical's ordinary leaf-edit marker. A
  // root-only update is kept conservative because it can also represent a
  // newly inserted or removed top-level block.
  return !nonRoot.length || nonRoot.some(([, dirty]) => dirty);
}

export function resolveNotebookOutlinePosition(
  positions: readonly NotebookOutlinePosition[],
  threshold: number,
): NodeKey | null {
  if (!positions.length) return null;
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (positions[middle]!.top <= threshold) low = middle + 1;
    else high = middle;
  }
  return positions[Math.max(0, low - 1)]!.key;
}

function sameOutlineItems(left: NotebookOutlineItem[], right: NotebookOutlineItem[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index]!;
    return item.key === other.key && item.text === other.text && item.level === other.level && item.parentKey === other.parentKey;
  });
}

function sameOutlineDocument(left: NotebookOutlineDocument, right: NotebookOutlineDocument): boolean {
  return sameOutlineItems(left.items, right.items) &&
    left.blocks.table === right.blocks.table && left.blocks.code === right.blocks.code &&
    left.blocks.mermaid === right.blocks.mermaid && left.blocks.image === right.blocks.image &&
    left.blockKeys.table === right.blockKeys.table && left.blockKeys.code === right.blockKeys.code &&
    left.blockKeys.mermaid === right.blockKeys.mermaid && left.blockKeys.image === right.blockKeys.image;
}

/** Read only the current editor's tree; decorators own separate nested editors. */
export function $readNotebookOutline(): NotebookOutlineDocument {
  const items: NotebookOutlineItem[] = [];
  const blocks = {table: false, code: false, mermaid: false, image: false};
  const blockKeys: NotebookOutlineDocument['blockKeys'] = {table: null, code: null, mermaid: null, image: null};
  const root = $getRoot();
  const fixedTitle = root.getFirstChild();
  const fixedTitleKey = fixedTitle && $isHeadingNode(fixedTitle) && fixedTitle.getTag() === 'h1' ? fixedTitle.getKey() : null;
  const headingStack: {key: NodeKey; level: number}[] = [];
  const pending: {node: LexicalNode; inTable: boolean}[] = root.getChildren().reverse()
    .map((node) => ({node, inTable: false}));
  while (pending.length) {
    const {node, inTable} = pending.pop()!;
    const isTable = $isTableNode(node);
    let block: NotebookBlock | null = null;
    if (isTable) block = 'table';
    else if ($isCodeNode(node)) block = node.getLanguage()?.trim().toLowerCase() === 'mermaid' ? 'mermaid' : 'code';
    else if (node.getType() === 'image') block = 'image';
    if (block) {
      blocks[block] = true;
      blockKeys[block] ??= node.getKey();
    }
    if (!inTable && $isHeadingNode(node)) {
      const level = Number(node.getTag().slice(1));
      while (headingStack.length && headingStack[headingStack.length - 1]!.level >= level) headingStack.pop();
      if (node.getKey() !== fixedTitleKey) {
        items.push({
          key: node.getKey(),
          text: node.getTextContent().trim(),
          level,
          parentKey: headingStack[headingStack.length - 1]?.key ?? null,
        });
        headingStack.push({key: node.getKey(), level});
      }
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren().reverse()) pending.push({node: child, inTable: inTable || isTable});
    }
  }
  return {items, blocks, blockKeys};
}

function scrollContainer(root: HTMLElement, view: Window): HTMLElement | null {
  for (let parent = root.parentElement; parent && parent !== root.ownerDocument.body && parent !== root.ownerDocument.documentElement; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(view.getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
}

/** The host owns the outline UI. This plugin never changes nodes or selection. */
export default function NotebookOutline({session}: {session: NotebookSession}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    let root: HTMLElement | null = null;
    let scroller: HTMLElement | null = null;
    let toolbar: HTMLElement | null = null;
    let toolbarSize = 0;
    let scrollerTop = 0;
    let scrollerClientTop = 0;
    let outline = editor.getEditorState().read($readNotebookOutline);
    let published: NotebookOutlineSnapshot | null = null;
    let outlineNeedsPublish = true;
    let frame: number | null = null;
    let geometryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let geometryDirty = true;
    let headingPositions: NotebookOutlinePosition[] = [];
    const headingElements = new Map<NodeKey, HTMLElement>();
    const doc = editor.getRootElement()?.ownerDocument ?? document;
    const view = doc.defaultView ?? window;
    const refreshGeometry = () => {
      if (geometryTimer !== null) {
        clearTimeout(geometryTimer);
        geometryTimer = null;
      }
      if (!root) {
        scroller = null;
        toolbar = null;
        toolbarSize = 0;
        scrollerTop = 0;
        scrollerClientTop = 0;
        geometryDirty = true;
        return;
      }
      scroller = scrollContainer(root, view);
      toolbar = root.closest('.editor-shell')?.querySelector<HTMLElement>('.toolbar') ?? null;
      toolbarSize = toolbar?.getBoundingClientRect().height ?? 0;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        scrollerTop = rect.top;
        scrollerClientTop = scroller.clientTop;
      } else {
        scrollerTop = 0;
        scrollerClientTop = 0;
      }
      geometryDirty = true;
    };
    const deferGeometry = () => {
      geometryDirty = true;
      if (geometryTimer !== null) clearTimeout(geometryTimer);
      // A paragraph edit can move all following headings. Publish metadata
      // now, but wait for a short quiet window before reading every heading's
      // layout rectangle.
      geometryTimer = setTimeout(() => {
        geometryTimer = null;
        schedule();
      }, 120);
    };
    const measureHeadingPositions = () => {
      if (!root) {
        headingPositions = [];
        geometryDirty = false;
        return;
      }
      const scrollTop = scroller?.scrollTop ?? view.scrollY;
      const positions: NotebookOutlinePosition[] = [];
      for (const {key} of outline.items) {
        let element = headingElements.get(key);
        if (!element || !root.contains(element)) {
          element = editor.getElementByKey(key) ?? undefined;
          if (element) headingElements.set(key, element);
        }
        if (!element || !root.contains(element)) continue;
        const rect = element.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        positions.push({key, top: rect.top + scrollTop});
      }
      headingPositions = positions;
      geometryDirty = false;
    };
    const emit = () => {
      frame = null;
      if (disposed || !root) return;
      if (geometryDirty && geometryTimer === null) measureHeadingPositions();
      const threshold = (scroller ? scroller.scrollTop + scrollerTop + scrollerClientTop : view.scrollY) + toolbarSize + 24;
      const snapshot = {items: outline.items, blocks: outline.blocks, activeKey: resolveNotebookOutlinePosition(headingPositions, threshold)};
      if ((outlineNeedsPublish || !published || published.activeKey !== snapshot.activeKey) && session.publishOutline(snapshot)) {
        published = snapshot;
        outlineNeedsPublish = false;
      }
    };
    function schedule() {
      if (!disposed && frame === null) frame = view.requestAnimationFrame(emit);
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
      // The root itself grows while typing. Treat that as a debounced content
      // reflow; toolbar/scroller changes need their container coordinates
      // refreshed immediately.
      const rootOnly = entries.length > 0 && entries.every(entry => entry.target === root);
      if (rootOnly) deferGeometry();
      else refreshGeometry();
      schedule();
    });
    const unregisterRoot = editor.registerRootListener((nextRoot) => {
      observer?.disconnect();
      root = nextRoot;
      headingElements.clear();
      refreshGeometry();
      if (root) {
        observer?.observe(root);
        if (toolbar) observer?.observe(toolbar);
        if (scroller) observer?.observe(scroller);
      }
      schedule();
    });
    const unregisterUpdate = editor.registerUpdateListener(({editorState, dirtyElements, dirtyLeaves}) => {
      if (!dirtyElements.size && !dirtyLeaves.size) return;
      deferGeometry();
      const dirtyHeadingLeaf = editorState.read(() => {
        const first = $getRoot().getFirstChild();
        const fixedTitleKey = first && $isHeadingNode(first) && first.getTag() === 'h1' ? first.getKey() : null;
        for (const key of dirtyLeaves) {
          let node = $getNodeByKey(key);
          let heading: LexicalNode | null = null;
          let inTable = false;
          while (node) {
            if ($isTableNode(node)) inTable = true;
            if (!heading && $isHeadingNode(node)) heading = node;
            node = node.getParent();
          }
          if (heading && !inTable && heading.getKey() !== fixedTitleKey) return true;
        }
        return false;
      });
      if (shouldRebuildNotebookOutline(dirtyElements, dirtyLeaves, dirtyHeadingLeaf)) {
        const next = editorState.read($readNotebookOutline);
        if (!sameOutlineDocument(outline, next)) {
          outlineNeedsPublish = true;
          headingElements.clear();
        }
        outline = next;
      }
      schedule();
    });
    const unregisterNavigation = session.bindNavigation((navigation) => {
      if (!root) return;
      const behavior = view.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
      if (navigation.block === 'top' && navigation.heading === undefined) {
        (scroller ?? view).scrollTo({top: 0, behavior});
        schedule();
        return;
      }
      const key = navigation.heading !== undefined
        ? outline.items.find((item) => item.key === navigation.heading)?.key
        : navigation.block && navigation.block !== 'top' ? outline.blockKeys[navigation.block] : null;
      const target = key ? editor.getElementByKey(key) : null;
      if (!target || !root.contains(target)) return;
      const targetRect = target.getBoundingClientRect();
      if (!targetRect.width && !targetRect.height) return;
      const top = targetRect.top - toolbarSize - 24 + (scroller
        ? scroller.scrollTop - scroller.getBoundingClientRect().top - scroller.clientTop
        : view.scrollY);
      (scroller ?? view).scrollTo({top: Math.max(0, top), behavior});
      schedule();
    });
    const onScroll = () => {
      // Positions are stored in document coordinates. Window scrolling only
      // changes the threshold; an inner scroller changes its own threshold as
      // well, so neither path needs to re-measure every heading.
      schedule();
    };
    const onLoad = () => {
      refreshGeometry();
      schedule();
    };
    const onResize = () => {
      refreshGeometry();
      schedule();
    };
    doc.addEventListener('scroll', onScroll, {capture: true, passive: true});
    doc.addEventListener('load', onLoad, true);
    view.addEventListener('resize', onResize, {passive: true});
    return () => {
      disposed = true;
      unregisterRoot();
      unregisterUpdate();
      unregisterNavigation();
      observer?.disconnect();
      headingElements.clear();
      if (geometryTimer !== null) clearTimeout(geometryTimer);
      if (frame !== null) view.cancelAnimationFrame(frame);
      doc.removeEventListener('scroll', onScroll, true);
      doc.removeEventListener('load', onLoad, true);
      view.removeEventListener('resize', onResize);
    };
  }, [editor, session]);
  return null;
}
