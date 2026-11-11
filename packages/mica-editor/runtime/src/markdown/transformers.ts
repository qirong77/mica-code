import {$createCodeNode, $isCodeNode, CodeHighlightNode, CodeNode} from '@lexical/code';
import {AutoLinkNode, LinkNode} from '@lexical/link';
import {ListItemNode, ListNode} from '@lexical/list';
import {
  $convertFromMarkdownString,
  CHECK_LIST,
  HEADING,
  LINK,
  ORDERED_LIST,
  QUOTE,
  TEXT_FORMAT_TRANSFORMERS,
  UNORDERED_LIST,
  type ElementTransformer,
  type MultilineElementTransformer,
  type Transformer,
} from '@lexical/markdown';
import {$createHorizontalRuleNode, $isHorizontalRuleNode, HorizontalRuleNode} from '@lexical/react/LexicalHorizontalRuleNode';
import {HeadingNode, QuoteNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableCellHeaderStates,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import {$createParagraphNode, $createTextNode, $getState, $isElementNode, $setState, createState} from 'lexical';
import {closesMarkdownFence, markdownTableAlignments, readMarkdownFence, splitMarkdownTableRow} from './markdownPolicy';

/** No notebook decorators or nested editors are registered in Markdown mode. */
export const MARKDOWN_NODES = [
  HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, AutoLinkNode,
  CodeNode, CodeHighlightNode, TableNode, TableRowNode, TableCellNode, HorizontalRuleNode,
];

const fenceState = createState('micaMarkdownFence', {parse: value => typeof value === 'string' && /^(?:`{3,}|~{3,})$/.test(value) ? value : '```'});
const infoState = createState('micaMarkdownCodeInfo', {parse: value => typeof value === 'string' ? value : ''});
const languageState = createState('micaMarkdownCodeLanguage', {parse: value => typeof value === 'string' ? value : ''});
const metaState = createState('micaMarkdownCodeMeta', {parse: value => typeof value === 'string' ? value : ''});

function normalizedLanguage(language: string): string {
  return ({'c++': 'cpp', 'c#': 'csharp'} as Record<string, string>)[language.toLowerCase()] || language;
}

function createFencedCode(info: string, fence: string, text: string) {
  const [, rawLanguage = '', metadata = ''] = /^(\S+)?(?:\s+([\s\S]*))?$/.exec(info) || [];
  const language = normalizedLanguage(rawLanguage);
  const node = $createCodeNode(language || undefined).append($createTextNode(text));
  $setState(node, fenceState, fence);
  $setState(node, infoState, info);
  $setState(node, languageState, language);
  $setState(node, metaState, metadata);
  return node;
}

/** Both fence styles, complete info strings, and all code-body blank lines. */
export const MARKDOWN_CODE: MultilineElementTransformer = {
  type: 'multiline-element',
  dependencies: [CodeNode],
  regExpStart: /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/,
  regExpEnd: {optional: true, regExp: /^ {0,3}(?:`{3,}|~{3,})[\t ]*$/},
  handleImportAfterStartMatch({lines, startLineIndex, rootNode}) {
    const opening = readMarkdownFence(lines[startLineIndex]);
    if (!opening) return null;
    let end = startLineIndex + 1;
    while (end < lines.length && !closesMarkdownFence(lines[end], opening)) end++;
    const text = lines.slice(startLineIndex + 1, end).map(line => {
      let indent = 0;
      while (indent < opening.indent && line[indent] === ' ') indent++;
      return line.slice(indent);
    }).join('\n');
    rootNode.append(createFencedCode(opening.info, opening.marker, text));
    return [true, Math.min(end, lines.length - 1)];
  },
  replace(parent, children, match) {
    if (!children || parent.getType() === 'quote') return false;
    const node = createFencedCode((match[3] || '').trim(), match[2], '');
    node.clear().append(...children);
    parent.replace(node);
    node.selectStart();
  },
  export(node) {
    if (!$isCodeNode(node)) return null;
    const text = node.getTextContent();
    let fence = $getState(node, fenceState);
    const language = node.getLanguage() || '';
    const metadata = $getState(node, metaState);
    const info = language === $getState(node, languageState)
      ? $getState(node, infoState)
      : language + (metadata ? ` ${metadata}` : '');
    // Backticks in an info string require a tilde fence. Otherwise lengthen
    // the existing fence beyond every run in the body, including inline runs.
    if (info.includes('`')) fence = '~~~';
    const runs = text.match(fence[0] === '`' ? /`+/g : /~+/g) || [];
    let length = fence.length;
    for (const run of runs) length = Math.max(length, run.length + 1);
    fence = fence[0].repeat(length);
    return `${fence}${info}\n${text}\n${fence}`;
  },
};

// Highlight (==text==) is not GFM; keep it literal rather than adding formats
// that a Markdown consumer might not understand.
const INLINE_TRANSFORMERS: Transformer[] = [
  ...TEXT_FORMAT_TRANSFORMERS.filter(transformer => !transformer.format.includes('highlight')),
  LINK,
];

export const MARKDOWN_TABLE: MultilineElementTransformer = {
  type: 'multiline-element',
  dependencies: [TableNode, TableRowNode, TableCellNode],
  regExpStart: /^ {0,3}\S.*\|/,
  replace: () => false,
  handleImportAfterStartMatch({lines, startLineIndex, rootNode}) {
    const header = splitMarkdownTableRow(lines[startLineIndex]);
    const alignment = markdownTableAlignments(lines[startLineIndex + 1] || '');
    if (!header || !alignment || header.length !== alignment.length) return null;
    const rows = [header];
    let end = startLineIndex + 2;
    while (end < lines.length && lines[end].trim()) {
      const row = splitMarkdownTableRow(lines[end]);
      if (!row) break;
      // Never drop extra cells (GFM readers normally discard them). The source
      // policy makes this read-only, and preview leaves the whole table literal.
      if (row.length !== header.length) return null;
      rows.push(row);
      end++;
    }
    const table = $createTableNode();
    for (const [rowIndex, values] of rows.entries()) {
      const row = $createTableRowNode();
      for (const [column, value] of values.entries()) {
        const cell = $createTableCellNode(rowIndex === 0 ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS);
        // GFM unescapes a pipe before parsing inline syntax, including code.
        $convertFromMarkdownString(value.replace(/\\\|/g, '|'), INLINE_TRANSFORMERS, cell, true);
        if (!cell.getChildrenSize()) cell.append($createParagraphNode());
        cell.setFormat(alignment[column]);
        for (const child of cell.getChildren()) if ($isElementNode(child)) child.setFormat(alignment[column]);
        row.append(cell);
      }
      table.append(row);
    }
    rootNode.append(table);
    return [true, end - 1];
  },
  export(node, exportChildren) {
    if (!$isTableNode(node)) return null;
    const rows = node.getChildren().filter($isTableRowNode);
    if (!rows.length) return '';
    const header = rows[0].getChildren().filter($isTableCellNode);
    const renderRow = (cells: TableCellNode[]) => `| ${cells.map(cell => {
      // Inline-code pipes need the same GFM escaping as ordinary cell text.
      return exportChildren(cell).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    }).join(' | ')} |`;
    const divider = header.map(cell => {
      const first = cell.getFirstChild();
      const format = cell.getFormatType() || ($isElementNode(first) ? first.getFormatType() : '');
      return format === 'center' ? ':---:' : format === 'right' ? '---:' : format === 'left' ? ':---' : '---';
    });
    return [renderRow(header), `| ${divider.join(' | ')} |`, ...rows.slice(1).map(row => renderRow(row.getChildren().filter($isTableCellNode)))].join('\n');
  },
};

const HORIZONTAL_RULE: ElementTransformer = {
  type: 'element',
  dependencies: [HorizontalRuleNode],
  regExp: /^ {0,3}(?:(?:\*[\t ]*){3,}|(?:-[\t ]*){3,}|(?:_[\t ]*){3,})$/,
  replace(parent) { parent.replace($createHorizontalRuleNode()); },
  export: node => $isHorizontalRuleNode(node) ? '---' : null,
};

/**
 * Use shouldPreserveNewLines=true on both Lexical conversion calls. This also
 * bypasses its backtick-only normalizer, which cannot protect tilde code bodies.
 * Retain the original input string until an actual user edit; rendering and
 * export alone do not prove that the source has changed.
 */
export const MARKDOWN_TRANSFORMERS: Transformer[] = [
  MARKDOWN_CODE, MARKDOWN_TABLE, HORIZONTAL_RULE, HEADING, QUOTE,
  CHECK_LIST, UNORDERED_LIST, ORDERED_LIST, ...INLINE_TRANSFORMERS,
];
