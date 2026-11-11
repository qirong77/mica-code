/** Syntax shared by the Markdown importer and the source-preservation policy. */
export interface MarkdownFence {
  indent: number;
  marker: string;
  info: string;
}

export function readMarkdownFence(line: string): MarkdownFence | null {
  const match = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
  if (!match || (match[2][0] === '`' && match[3].includes('`'))) return null;
  return {indent: match[1].length, marker: match[2], info: match[3].trim()};
}

export function closesMarkdownFence(line: string, fence: MarkdownFence): boolean {
  const match = /^ {0,3}(`+|~+)[\t ]*$/.exec(line);
  return !!match && match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length;
}

/** Keep escapes intact; only unescaped pipes delimit GFM table cells. */
export function splitMarkdownTableRow(line: string): string[] | null {
  const source = line.trim();
  const cells: string[] = [];
  let start = 0;
  let slashes = 0;
  let pipes = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '|' && slashes % 2 === 0) {
      cells.push(source.slice(start, index).trim());
      start = index + 1;
      pipes++;
    }
    slashes = character === '\\' ? slashes + 1 : 0;
  }
  if (!pipes) return null;
  cells.push(source.slice(start).trim());
  if (source.startsWith('|')) cells.shift();
  if (start === source.length) cells.pop();
  return cells.length ? cells : null;
}

export type MarkdownTableAlignment = '' | 'left' | 'center' | 'right';

export function markdownTableAlignments(line: string): MarkdownTableAlignment[] | null {
  const cells = splitMarkdownTableRow(line);
  if (!cells || !cells.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  return cells.map(cell => cell.startsWith(':') ? (cell.endsWith(':') ? 'center' : 'left') : (cell.endsWith(':') ? 'right' : ''));
}

/** Mask matched inline code only, preserving line positions for block checks. */
function maskInlineCode(source: string): string {
  const runs = [...source.matchAll(/`+/g)];
  let output = '';
  let previous = 0;
  for (let index = 0; index < runs.length; index++) {
    const open = runs[index];
    const start = open.index!;
    let slashes = 0;
    for (let cursor = start - 1; source[cursor] === '\\'; cursor--) slashes++;
    if (slashes % 2) continue;
    let closeIndex = index + 1;
    while (closeIndex < runs.length && runs[closeIndex][0].length !== open[0].length) closeIndex++;
    if (closeIndex === runs.length) continue;
    const end = runs[closeIndex].index! + runs[closeIndex][0].length;
    output += source.slice(previous, start) + source.slice(start, end).replace(/[^\n]/g, ' ');
    previous = end;
    index = closeIndex;
  }
  return output + source.slice(previous);
}

const TABLE_REASON = '此文档包含复杂表格，请在源码模式编辑以保留单元格和转义字符。';

/**
 * null means the document fits the editable Markdown subset. A reason means
 * keep the original source as the authority and offer read-only rich preview.
 * This is deliberately conservative: viewing must never rewrite a prompt.
 */
export function markdownEditableReason(source: string): string | null {
  const normalized = source.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (/^\uFEFF?(?:---|\+\+\+)[\t ]*\n/.test(normalized)) {
    return '此文档包含 frontmatter 元数据，请在源码模式编辑以保留原文。';
  }

  let fence: MarkdownFence | null = null;
  const outside = lines.map(line => {
    if (fence) {
      if (closesMarkdownFence(line, fence)) fence = null;
      return '';
    }
    fence = readMarkdownFence(line);
    return fence ? '' : line;
  });
  if (fence) return '此文档包含未闭合的代码围栏，请在源码模式编辑。';

  // Tables are checked before masking inline code: an escaped pipe in a code
  // span is still table syntax, while arbitrary backslash runs are ambiguous.
  for (let index = 1; index < outside.length; index++) {
    const alignment = markdownTableAlignments(outside[index]);
    if (!alignment) continue;
    const header = splitMarkdownTableRow(outside[index - 1]);
    if (!header || header.length !== alignment.length) return TABLE_REASON;
    let end = index + 1;
    while (end < outside.length && outside[end].trim() && splitMarkdownTableRow(outside[end])) end++;
    for (let row = index - 1; row < end; row++) {
      const cells = splitMarkdownTableRow(outside[row]);
      if (!cells || cells.length !== alignment.length || /^(?: {4}|\t|\s*>)/.test(outside[row])) return TABLE_REASON;
      for (const cell of cells) {
        if (/\\(?!\|)|\\\\|(?:^|\s)(?:`{3,}|~{3,})/.test(cell)) return TABLE_REASON;
      }
    }
    index = end - 1;
  }

  const visible = maskInlineCode(outside.join('\n'));
  if (/(?:<!--|<![A-Z]|<\?|<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*|\s*\/?)>)/.test(visible)) {
    return '此文档包含 HTML 或 XML，请在源码模式编辑以保留标签。';
  }
  if (/^ {0,3}\[[^\]\n]+\]:/m.test(visible) || /\[[^\]\n]+\]\[[^\]\n]*\]/.test(visible)) {
    return '此文档包含引用式链接或脚注，请在源码模式编辑以保留引用关系。';
  }
  if (/\[\^[^\]\n]+\]/.test(visible)) return '此文档包含脚注，请在源码模式编辑以保留脚注。';
  if (/!\[[^\]\n]*\]/.test(visible)) return '此文档包含图片，请在源码模式编辑以保留图片语法。';
  if (/\$\$|\\[([]|(^|[^\\\w])\$(?!\s|\d)[^$\n]+\$/m.test(visible)) {
    return '此文档包含数学公式，请在源码模式编辑以保留公式。';
  }
  // 引用（含引用内的列表、代码块、表格、嵌套引用）由 MARKDOWN_QUOTE 按块解析，
  // 往返是原样的，不再整体降级；写在同一行里的「列表项 + 围栏/表格」仍然无法
  // 还原（导出会把围栏提到顶层），继续留在源码。
  if (/^\s*(?:[-+*]|\d+[.)])\s+(?:`{3,}|~{3,}|\|)/m.test(visible)) {
    return '此文档包含列表内的代码块或表格，请在源码模式编辑以保留结构。';
  }
  if (/^(?: {4}|\t)(?!\s*(?:[-+*]|\d+\.)\s)\S/m.test(visible)) {
    return '此文档包含缩进代码或复杂列表，请在源码模式编辑以保留缩进。';
  }
  if (/^[^\n]+\n {0,3}(?:=+|-+)[\t ]*$/m.test(visible)) {
    return '此文档包含下划线式标题，请在源码模式编辑以保留标题结构。';
  }
  if (/&[A-Za-z][A-Za-z\d]+;|^\s*:{3,}|\{[.#][\w-]+/m.test(visible)) {
    return '此文档包含 Markdown 扩展语法，请在源码模式编辑以保留原文。';
  }
  // Lexical's newline-preserving exporter leaves literal backslashes and some
  // block markers unescaped. Pipe escapes are handled by the table converter;
  // other escape-sensitive source stays editable as source, not silently lost.
  if (/\\[\\[\]#>+.!(){}<>&-]|\\$/m.test(visible)) {
    return '此文档包含需要保留的转义字符，请在源码模式编辑以保留原文。';
  }
  return null;
}
