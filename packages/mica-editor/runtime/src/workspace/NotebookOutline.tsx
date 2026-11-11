import {$isCodeNode} from '@lexical/code';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$isHeadingNode} from '@lexical/rich-text';
import {$isTableNode} from '@lexical/table';
import {$getRoot, $isElementNode, type LexicalNode, type NodeKey} from 'lexical';
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

/** Read only the current editor's tree; decorators own separate nested editors. */
export function $readNotebookOutline(): NotebookOutlineDocument {
  const items: NotebookOutlineItem[] = [];
  const blocks = {table: false, code: false, mermaid: false, image: false};
  const blockKeys: NotebookOutlineDocument['blockKeys'] = {table: null, code: null, mermaid: null, image: null};
  const pending: {node: LexicalNode; inTable: boolean}[] = $getRoot().getChildren().reverse()
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
      items.push({key: node.getKey(), text: node.getTextContent().trim(), level: Number(node.getTag().slice(1))});
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

function toolbarHeight(root: HTMLElement): number {
  return root.closest('.editor-shell')?.querySelector('.toolbar')?.getBoundingClientRect().height ?? 0;
}

/** The host owns the outline UI. This plugin never changes nodes or selection. */
export default function NotebookOutline({session}: {session: NotebookSession}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    let root: HTMLElement | null = null;
    let outline = editor.getEditorState().read($readNotebookOutline);
    let signature: string | null = null;
    let frame: number | null = null;
    let disposed = false;
    const doc = editor.getRootElement()?.ownerDocument ?? document;
    const view = doc.defaultView ?? window;
    const emit = () => {
      frame = null;
      if (disposed || !root) return;
      const scroller = scrollContainer(root, view);
      const threshold = (scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0) + toolbarHeight(root) + 24;
      let firstKey: NodeKey | null = null;
      let activeKey: NodeKey | null = null;
      for (const {key} of outline.items) {
        const element = editor.getElementByKey(key);
        if (!element || !root.contains(element) || !element.getClientRects().length) continue;
        firstKey ??= key;
        if (element.getBoundingClientRect().top <= threshold + 1) activeKey = key;
      }
      const snapshot = {items: outline.items, blocks: outline.blocks, activeKey: activeKey ?? firstKey};
      const nextSignature = JSON.stringify(snapshot);
      if (nextSignature !== signature && session.publishOutline(snapshot)) signature = nextSignature;
    };
    const schedule = () => {
      if (!disposed && frame === null) frame = view.requestAnimationFrame(emit);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    const unregisterRoot = editor.registerRootListener((nextRoot) => {
      observer?.disconnect();
      root = nextRoot;
      if (root) {
        observer?.observe(root);
        const toolbar = root.closest('.editor-shell')?.querySelector('.toolbar');
        if (toolbar) observer?.observe(toolbar);
      }
      schedule();
    });
    const unregisterUpdate = editor.registerUpdateListener(({editorState, dirtyElements, dirtyLeaves}) => {
      if (!dirtyElements.size && !dirtyLeaves.size) return;
      outline = editorState.read($readNotebookOutline);
      schedule();
    });
    const unregisterNavigation = session.bindNavigation((navigation) => {
      if (!root) return;
      const scroller = scrollContainer(root, view);
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
      if (!target || !root.contains(target) || !target.getClientRects().length) return;
      const top = target.getBoundingClientRect().top - toolbarHeight(root) - 24 + (scroller
        ? scroller.scrollTop - scroller.getBoundingClientRect().top - scroller.clientTop
        : view.scrollY);
      (scroller ?? view).scrollTo({top: Math.max(0, top), behavior});
      schedule();
    });
    doc.addEventListener('scroll', schedule, {capture: true, passive: true});
    doc.addEventListener('load', schedule, true);
    view.addEventListener('resize', schedule, {passive: true});
    return () => {
      disposed = true;
      unregisterRoot();
      unregisterUpdate();
      unregisterNavigation();
      observer?.disconnect();
      if (frame !== null) view.cancelAnimationFrame(frame);
      doc.removeEventListener('scroll', schedule, true);
      doc.removeEventListener('load', schedule, true);
      view.removeEventListener('resize', schedule);
    };
  }, [editor, session]);
  return null;
}
