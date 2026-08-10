#!/usr/bin/env bun

import React, { useMemo } from 'react';
import { Box, Ansi, stringWidth, useTerminalSize, wrapAnsi } from '@anthropic/ink';
import { marked } from 'marked';
import { LRUCache } from 'lru-cache';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';

import type { Token, Tokens } from 'marked';

// ─── constants ───────────────────────────────────────────────────────────────

const BLOCKQUOTE_BAR = '\u258e'; // ▎
const EOL = '\n';

// ─── marked config ───────────────────────────────────────────────────────────

let markedConfigured = false;

function configureMarked(): void {
  if (markedConfigured) return;
  markedConfigured = true;
  marked.use({
    tokenizer: {
      del() {
        return undefined;
      },
    },
  });
}

// ─── OSC 8 hyperlinks ────────────────────────────────────────────────────────

const OSC8_START = '\x1b]8;;';
const OSC8_END = '\x07';

function supportsHyperlinks(): boolean {
  return process.env.FORCE_HYPERLINK !== '0' && process.stdout.isTTY === true;
}

function createHyperlink(url: string, content?: string): string {
  const displayText = content ?? url;
  const blueDisplayText = chalk.blue(displayText);
  if (!supportsHyperlinks()) return blueDisplayText;
  return `${OSC8_START}${url}${OSC8_END}${blueDisplayText}${OSC8_START}${OSC8_END}`;
}

// ─── list numbering ──────────────────────────────────────────────────────────

function numberToLetter(n: number): string {
  let result = '';
  while (n > 0) {
    n--;
    result = String.fromCharCode(97 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

const ROMAN_VALUES: ReadonlyArray<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

function numberToRoman(n: number): string {
  let result = '';
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral;
      n -= value;
    }
  }
  return result;
}

function getListNumber(listDepth: number, orderedListNumber: number): string {
  switch (listDepth) {
    case 0:
    case 1:
      return orderedListNumber.toString();
    case 2:
      return numberToLetter(orderedListNumber);
    case 3:
      return numberToRoman(orderedListNumber);
    default:
      return orderedListNumber.toString();
  }
}

// ─── table padding ───────────────────────────────────────────────────────────

function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth);
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2);
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad);
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content;
  }
  return content + ' '.repeat(padding);
}

// ─── issue reference linkification ───────────────────────────────────────────

const ISSUE_REF_PATTERN = /(^|[^\w./-])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g;

function linkifyIssueReferences(text: string): string {
  if (!supportsHyperlinks()) return text;
  return text.replace(
    ISSUE_REF_PATTERN,
    (_match, prefix, repo, num) =>
      prefix + createHyperlink(`https://github.com/${repo}/issues/${num}`, `${repo}#${num}`),
  );
}

// ─── formatToken ─────────────────────────────────────────────────────────────

function formatToken(
  token: Token,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
  highlight: {
    highlight: (code: string, opts: { language: string }) => string;
    supportsLanguage: (lang: string) => boolean;
  } | null = null,
): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = (token.tokens ?? []).map((t) => formatToken(t, 0, null, null, highlight)).join('');
      const bar = chalk.dim(BLOCKQUOTE_BAR);
      return inner
        .split(EOL)
        .map((line) => (stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : line))
        .join(EOL);
    }
    case 'code': {
      if (!highlight) return token.text + EOL;
      let language = 'plaintext';
      if (token.lang && highlight.supportsLanguage(token.lang)) {
        language = token.lang;
      }
      return highlight.highlight(token.text, { language }) + EOL;
    }
    case 'codespan': {
      // ANSI blue follows the terminal palette and remains usable in both
      // light and dark profiles; the previous fixed lavender was light-only.
      return chalk.blue(token.text);
    }
    case 'em':
      return chalk.italic((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent, highlight)).join(''));
    case 'strong':
      return chalk.bold((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent, highlight)).join(''));
    case 'heading':
      switch (token.depth) {
        case 1:
          return (
            chalk.bold.italic.underline(
              (token.tokens ?? []).map((t) => formatToken(t, 0, null, null, highlight)).join(''),
            ) +
            EOL +
            EOL
          );
        case 2:
          return (
            chalk.bold((token.tokens ?? []).map((t) => formatToken(t, 0, null, null, highlight)).join('')) + EOL + EOL
          );
        default:
          return (
            chalk.bold((token.tokens ?? []).map((t) => formatToken(t, 0, null, null, highlight)).join('')) + EOL + EOL
          );
      }
    case 'hr':
      return '---';
    case 'image':
      return token.href;
    case 'link': {
      if (token.href.startsWith('mailto:')) {
        return token.href.replace(/^mailto:/, '');
      }
      const linkText = (token.tokens ?? []).map((t) => formatToken(t, 0, null, token, highlight)).join('');
      const plainLinkText = stripAnsi(linkText);
      if (plainLinkText && plainLinkText !== token.href) {
        return createHyperlink(token.href, linkText);
      }
      return createHyperlink(token.href);
    }
    case 'list': {
      return token.items
        .map((item: Token, index: number) =>
          formatToken(item, listDepth, token.ordered ? token.start + index : null, token, highlight),
        )
        .join('');
    }
    case 'list_item':
      return (token.tokens ?? [])
        .map((t) => `${'  '.repeat(listDepth)}${formatToken(t, listDepth + 1, orderedListNumber, token, highlight)}`)
        .join('');
    case 'paragraph':
      return (token.tokens ?? []).map((t) => formatToken(t, 0, null, null, highlight)).join('') + EOL;
    case 'space':
      return EOL;
    case 'br':
      return EOL;
    case 'text':
      if (parent?.type === 'link') return token.text;
      if (parent?.type === 'list_item') {
        return `${orderedListNumber === null ? '-' : getListNumber(listDepth, orderedListNumber) + '.'} ${token.tokens ? token.tokens.map((t) => formatToken(t, listDepth, orderedListNumber, token, highlight)).join('') : linkifyIssueReferences(token.text)}${EOL}`;
      }
      return linkifyIssueReferences(token.text);
    case 'table': {
      const tableToken = token as Tokens.Table;

      function getDisplayText(tokens: Token[] | undefined): string {
        return stripAnsi(tokens?.map((t) => formatToken(t, 0, null, null, highlight)).join('') ?? '');
      }

      const columnWidths = tableToken.header.map((header, index) => {
        let maxWidth = stringWidth(getDisplayText(header.tokens));
        for (const row of tableToken.rows) {
          const cellLength = stringWidth(getDisplayText(row[index]?.tokens));
          maxWidth = Math.max(maxWidth, cellLength);
        }
        return Math.max(maxWidth, 3);
      });

      let tableOutput = '| ';
      tableToken.header.forEach((header, index) => {
        const content = header.tokens?.map((t) => formatToken(t, 0, null, null, highlight)).join('') ?? '';
        const displayText = getDisplayText(header.tokens);
        const width = columnWidths[index]!;
        const align = tableToken.align?.[index];
        tableOutput += padAligned(content, stringWidth(displayText), width, align) + ' | ';
      });
      tableOutput = tableOutput.trimEnd() + EOL;

      tableOutput += '|';
      columnWidths.forEach((width) => {
        tableOutput += '-'.repeat(width + 2) + '|';
      });
      tableOutput += EOL;

      tableToken.rows.forEach((row) => {
        tableOutput += '| ';
        row.forEach((cell, index) => {
          const content = cell.tokens?.map((t) => formatToken(t, 0, null, null, highlight)).join('') ?? '';
          const displayText = getDisplayText(cell.tokens);
          const width = columnWidths[index]!;
          const align = tableToken.align?.[index];
          tableOutput += padAligned(content, stringWidth(displayText), width, align) + ' | ';
        });
        tableOutput = tableOutput.trimEnd() + EOL;
      });

      return tableOutput + EOL;
    }
    case 'escape':
      return token.text;
    case 'def':
    case 'del':
    case 'html':
      return '';
  }
  return '';
}

// ─── MarkdownTable ───────────────────────────────────────────────────────────

const SAFETY_MARGIN = 4;
const MIN_COLUMN_WIDTH = 3;
const MAX_ROW_LINES = 4;

const ANSI_BOLD_START = '\x1b[1m';
const ANSI_BOLD_END = '\x1b[22m';

type Highlight = {
  highlight: (code: string, opts: { language: string }) => string;
  supportsLanguage: (lang: string) => boolean;
};

function wrapText(text: string, width: number, options?: { hard?: boolean }): string[] {
  if (width <= 0) return [text];
  const trimmedText = text.trimEnd();
  const wrapped = wrapAnsi(trimmedText, width, {
    hard: options?.hard ?? false,
    trim: false,
    wordWrap: true,
  });
  const lines = wrapped.split('\n').filter((line: string) => line.length > 0);
  return lines.length > 0 ? lines : [''];
}

type TableProps = {
  token: Tokens.Table;
  highlight: Highlight | null;
  forceWidth?: number;
};

const MarkdownTable = React.memo(function MarkdownTable({ token, highlight, forceWidth }: TableProps): React.ReactNode {
  const terminalWidth = forceWidth ?? (process.stdout.columns || 80);

  const formatCache = new Map<Token[] | undefined, string>();
  const plainTextCache = new Map<Token[] | undefined, string>();

  function formatCell(tokens: Token[] | undefined): string {
    const cached = formatCache.get(tokens);
    if (cached !== undefined) return cached;
    const result = tokens?.map((t) => formatToken(t, 0, null, null, highlight)).join('') ?? '';
    formatCache.set(tokens, result);
    return result;
  }

  function getPlainText(tokens: Token[] | undefined): string {
    const cached = plainTextCache.get(tokens);
    if (cached !== undefined) return cached;
    const result = stripAnsi(formatCell(tokens));
    plainTextCache.set(tokens, result);
    return result;
  }

  function getMinWidth(tokens: Token[] | undefined): number {
    const text = getPlainText(tokens);
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return MIN_COLUMN_WIDTH;
    return Math.max(...words.map((w) => stringWidth(w)), MIN_COLUMN_WIDTH);
  }

  function getIdealWidth(tokens: Token[] | undefined): number {
    return Math.max(stringWidth(getPlainText(tokens)), MIN_COLUMN_WIDTH);
  }

  const minWidths = token.header.map((header, colIndex) => {
    let maxMinWidth = getMinWidth(header.tokens);
    for (const row of token.rows) {
      maxMinWidth = Math.max(maxMinWidth, getMinWidth(row[colIndex]?.tokens));
    }
    return maxMinWidth;
  });

  const idealWidths = token.header.map((header, colIndex) => {
    let maxIdeal = getIdealWidth(header.tokens);
    for (const row of token.rows) {
      maxIdeal = Math.max(maxIdeal, getIdealWidth(row[colIndex]?.tokens));
    }
    return maxIdeal;
  });

  const numCols = token.header.length;
  const borderOverhead = 1 + numCols * 3;
  const availableWidth = Math.max(terminalWidth - borderOverhead - SAFETY_MARGIN, numCols * MIN_COLUMN_WIDTH);

  const totalMin = minWidths.reduce((sum, w) => sum + w, 0);
  const totalIdeal = idealWidths.reduce((sum, w) => sum + w, 0);

  let needsHardWrap = false;
  let columnWidths: number[];

  if (totalIdeal <= availableWidth) {
    columnWidths = idealWidths;
  } else if (totalMin <= availableWidth) {
    const extraSpace = availableWidth - totalMin;
    const overflows = idealWidths.map((ideal, i) => ideal - minWidths[i]!);
    const totalOverflow = overflows.reduce((sum, o) => sum + o, 0);

    columnWidths = minWidths.map((min, i) => {
      if (totalOverflow === 0) return min;
      const extra = Math.floor((overflows[i]! / totalOverflow) * extraSpace);
      return min + extra;
    });
  } else {
    needsHardWrap = true;
    const scaleFactor = availableWidth / totalMin;
    columnWidths = minWidths.map((w) => Math.max(Math.floor(w * scaleFactor), MIN_COLUMN_WIDTH));
  }

  const wrapCache = new Map<Token[] | undefined, string[]>();

  function getWrappedLines(tokens: Token[] | undefined, colIndex: number): string[] {
    const cached = wrapCache.get(tokens);
    if (cached !== undefined) return cached;
    const formatted = formatCell(tokens);
    const lines = wrapText(formatted, columnWidths[colIndex]!, { hard: needsHardWrap });
    wrapCache.set(tokens, lines);
    return lines;
  }

  let maxRowLines = 1;
  for (let i = 0; i < token.header.length; i++) {
    maxRowLines = Math.max(maxRowLines, getWrappedLines(token.header[i]!.tokens, i).length);
  }
  for (const row of token.rows) {
    for (let i = 0; i < row.length; i++) {
      maxRowLines = Math.max(maxRowLines, getWrappedLines(row[i]?.tokens, i).length);
    }
  }

  const useVerticalFormat = maxRowLines > MAX_ROW_LINES;

  function renderRowLines(cells: Array<{ tokens?: Token[] }>, isHeader: boolean): string[] {
    const cellLines = cells.map((cell, colIndex) => getWrappedLines(cell.tokens, colIndex));
    const maxLines = Math.max(...cellLines.map((lines) => lines.length), 1);
    const verticalOffsets = cellLines.map((lines) => Math.floor((maxLines - lines.length) / 2));

    const result: string[] = [];
    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
      let line = '\u2502'; // │
      for (let colIndex = 0; colIndex < cells.length; colIndex++) {
        const lines = cellLines[colIndex]!;
        const offset = verticalOffsets[colIndex]!;
        const contentLineIdx = lineIdx - offset;
        const lineText = contentLineIdx >= 0 && contentLineIdx < lines.length ? lines[contentLineIdx]! : '';
        const width = columnWidths[colIndex]!;
        const align = isHeader ? 'center' : (token.align?.[colIndex] ?? 'left');
        line += ' ' + padAligned(lineText, stringWidth(lineText), width, align) + ' \u2502';
      }
      result.push(line);
    }
    return result;
  }

  function renderBorderLine(type: 'top' | 'middle' | 'bottom'): string {
    const chars = {
      top: ['\u250c', '\u2500', '\u252c', '\u2510'] as const, // ┌ ─ ┬ ┐
      middle: ['\u251c', '\u2500', '\u253c', '\u2524'] as const, // ├ ─ ┼ ┤
      bottom: ['\u2514', '\u2500', '\u2534', '\u2518'] as const, // └ ─ ┴ ┘
    }[type];
    let line = chars[0];
    columnWidths.forEach((width, colIndex) => {
      line += chars[1].repeat(width + 2);
      line += colIndex < columnWidths.length - 1 ? chars[2] : chars[3];
    });
    return line;
  }

  function renderVerticalFormat(): string {
    const lines: string[] = [];
    const headers = token.header.map((h) => getPlainText(h.tokens));
    const separatorWidth = Math.min(terminalWidth - 1, 40);
    const separator = '\u2500'.repeat(separatorWidth);
    const wrapIndent = '  ';

    token.rows.forEach((row, rowIndex) => {
      if (rowIndex > 0) lines.push(separator);
      row.forEach((cell, colIndex) => {
        const label = headers[colIndex] || `Column ${colIndex + 1}`;
        const rawValue = formatCell(cell.tokens).trimEnd();
        const value = rawValue.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();

        const firstLineWidth = terminalWidth - stringWidth(label) - 3;
        const subsequentLineWidth = terminalWidth - wrapIndent.length - 1;

        const firstPassLines = wrapText(value, Math.max(firstLineWidth, 10));
        const firstLine = firstPassLines[0] || '';

        let wrappedValue: string[];
        if (firstPassLines.length <= 1 || subsequentLineWidth <= firstLineWidth) {
          wrappedValue = firstPassLines;
        } else {
          const remainingText = firstPassLines
            .slice(1)
            .map((l) => l.trim())
            .join(' ');
          const rewrapped = wrapText(remainingText, subsequentLineWidth);
          wrappedValue = [firstLine, ...rewrapped];
        }

        lines.push(`${ANSI_BOLD_START}${label}:${ANSI_BOLD_END} ${wrappedValue[0] || ''}`);
        for (let i = 1; i < wrappedValue.length; i++) {
          const line = wrappedValue[i]!;
          if (!line.trim()) continue;
          lines.push(`${wrapIndent}${line}`);
        }
      });
    });

    return lines.join('\n');
  }

  if (useVerticalFormat) {
    return <Ansi>{renderVerticalFormat()}</Ansi>;
  }

  const tableLines: string[] = [];
  tableLines.push(renderBorderLine('top'));
  tableLines.push(...renderRowLines(token.header, true));
  tableLines.push(renderBorderLine('middle'));
  token.rows.forEach((row, rowIndex) => {
    tableLines.push(...renderRowLines(row, false));
    if (rowIndex < token.rows.length - 1) {
      tableLines.push(renderBorderLine('middle'));
    }
  });
  tableLines.push(renderBorderLine('bottom'));

  const maxLineWidth = Math.max(...tableLines.map((line) => stringWidth(stripAnsi(line))));
  if (maxLineWidth > terminalWidth - SAFETY_MARGIN) {
    return <Ansi>{renderVerticalFormat()}</Ansi>;
  }

  return <Ansi>{tableLines.join('\n')}</Ansi>;
});

// ─── Markdown component ──────────────────────────────────────────────────────

type MarkdownProps = {
  children: string;
  dimColor?: boolean;
};

const tokenCache = new LRUCache<string, Token[]>({ max: 500 });

const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;

function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s);
}

function hashContent(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function cachedLexer(content: string): Token[] {
  if (!hasMarkdownSyntax(content)) {
    return [
      {
        type: 'paragraph',
        raw: content,
        text: content,
        tokens: [{ type: 'text', raw: content, text: content }],
      } as Token,
    ];
  }
  const key = hashContent(content);
  const hit = tokenCache.get(key);
  if (hit) return hit;
  const tokens = marked.lexer(content);
  tokenCache.set(key, tokens);
  return tokens;
}

export function Markdown({ children, dimColor }: MarkdownProps): React.ReactNode {
  configureMarked();
  const { columns } = useTerminalSize();

  const elements = useMemo(() => {
    const tokens = cachedLexer(children);
    const elements: React.ReactNode[] = [];
    let nonTableContent = '';

    function flushNonTableContent(): void {
      if (nonTableContent) {
        elements.push(
          <Ansi key={elements.length} dimColor={dimColor}>
            {nonTableContent.trim()}
          </Ansi>,
        );
        nonTableContent = '';
      }
    }

    for (const token of tokens) {
      if (token.type === 'table') {
        flushNonTableContent();
        elements.push(
          <MarkdownTable
            key={elements.length}
            token={token as Tokens.Table}
            highlight={highlight}
            forceWidth={columns}
          />,
        );
      } else {
        nonTableContent += formatToken(token, 0, null, null, highlight);
      }
    }

    flushNonTableContent();
    return elements;
  }, [children, columns, dimColor]);

  return (
    <Box flexDirection="column" gap={1}>
      {elements}
    </Box>
  );
}

// ─── cli-highlight loading ───────────────────────────────────────────────────

type CliHighlight = {
  highlight: (code: string, opts: { language: string }) => string;
  supportsLanguage: (lang: string) => boolean;
};

let highlight: CliHighlight | null = null;
try {
  const mod = await import('cli-highlight');
  highlight = {
    highlight: mod.highlight,
    supportsLanguage: mod.supportsLanguage,
  };
} catch {
  // cli-highlight not available — code blocks render without syntax highlighting
}
