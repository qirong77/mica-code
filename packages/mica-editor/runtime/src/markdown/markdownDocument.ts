import {$convertFromMarkdownString, $convertToMarkdownString} from '@lexical/markdown';

import {MARKDOWN_TRANSFORMERS} from './transformers';

/**
 * Markdown 文本进出编辑器的唯一口径。
 *
 * 两侧都不保留 Markdown 的空行：`$convertFromMarkdownString` 打开 preserveNewLines 会把
 * 段落之间的空行变成空段落，排版上就是成倍的行距，看起来和 Typora 那种「空行只作分隔」
 * 完全不同。关掉之后，段落之间的空行由导出时的块分隔补回来，所以去掉它们不丢内容；
 * 只有连续多行空行会收敛成一个空行。
 */
export function $importMarkdown(markdown: string): void {
  $convertFromMarkdownString(markdown, MARKDOWN_TRANSFORMERS, undefined, false);
}

/** 导出时保留原文件的收尾换行习惯（有就补一个，没有就不加）。 */
export function $exportMarkdown(trailingNewline: boolean): string {
  const markdown = $convertToMarkdownString(MARKDOWN_TRANSFORMERS, undefined, false).replace(/\n+$/, '');
  return trailingNewline && markdown ? `${markdown}\n` : markdown;
}
