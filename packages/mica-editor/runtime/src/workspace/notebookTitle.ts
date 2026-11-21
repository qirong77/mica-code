import {$createHeadingNode, $isHeadingNode} from '@lexical/rich-text';
import {$createTextNode, $getRoot} from 'lexical';

export const DEFAULT_NOTEBOOK_TITLE = '未命名笔记';

export function normalizeNotebookTitle(value: string | undefined): string {
  const title = value?.trim();
  return title || DEFAULT_NOTEBOOK_TITLE;
}

export type NotebookTitleState = {key: string | null; text: string; firstIsTitle: boolean};

/** 读取第一个顶层块是不是标题 H1。调用方负责在 editor state 的读/写上下文里运行。 */
export function $readNotebookTitle(): NotebookTitleState {
  const root = $getRoot();
  const first = root.getFirstChild();
  const title = first && $isHeadingNode(first) && first.getTag() === 'h1' ? first : null;
  return {
    key: title?.getKey() ?? null,
    text: title?.getTextContent() ?? '',
    firstIsTitle: title !== null && root.getFirstChild() === title,
  };
}

/**
 * 保证第一个顶层块是 H1 标题块，返回是否改动了文档。
 *
 * 文字只在 `alignTo` 给定时写入——那是宿主显式改名（目录重命名、API 改名）的路径。
 * 用户把标题删空是合法状态，这里不能再用旧名字填回去，否则标题永远清不干净。
 */
export function $ensureNotebookTitle(alignTo: string | null): boolean {
  const root = $getRoot();
  const first = root.getFirstChild();
  const heading = first && $isHeadingNode(first) && first.getTag() === 'h1' ? first : null;
  if (heading && (alignTo === null || heading.getTextContent() === alignTo)) return false;
  const target = heading ?? $createHeadingNode('h1');
  if (root.getFirstChild() !== target) root.splice(0, 0, [target]);
  if (alignTo !== null && target.getTextContent() !== alignTo) {
    target.clear().append($createTextNode(alignTo));
  }
  return true;
}
