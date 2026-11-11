import {$isHeadingNode} from '@lexical/rich-text';
import {$getRoot} from 'lexical';

export interface NotebookSlide {
  title: string;
  keys: string[];
}

/** Read the existing document; presentation never rewrites blocks or history. */
export function $readNotebookSlides(): NotebookSlide[] {
  const blocks = $getRoot().getChildren();
  const headingLevels = blocks.flatMap(node => $isHeadingNode(node) ? [Number(node.getTag().slice(1))] : []);
  const boundaryLevel = headingLevels.some(level => level <= 2) ? 2 : Math.min(...headingLevels);
  const slides: NotebookSlide[] = [];
  let current: NotebookSlide = {title: '开始', keys: []};
  let hasContent = false;
  const finish = () => {
    if (current.keys.length && hasContent) slides.push(current);
    current = {title: '开始', keys: []};
    hasContent = false;
  };
  for (const block of blocks) {
    if (block.getType() === 'page-break') {finish(); continue;}
    const heading = $isHeadingNode(block) && Number(block.getTag().slice(1)) <= boundaryLevel;
    if (heading) {
      finish();
      current.title = block.getTextContent().trim() || '未命名标题';
    }
    current.keys.push(block.getKey());
    hasContent ||= heading || block.getTextContent().trim().length > 0 || block.getType() !== 'paragraph';
  }
  finish();
  return slides.length ? slides : [{title: '空白文档', keys: blocks.filter(node => node.getType() !== 'page-break').map(node => node.getKey())}];
}
