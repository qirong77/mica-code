import { Lexer, type Token } from 'marked';

import { parseNotebookDocument, type NotebookDocument } from './model';

/**
 * Deterministic Markdown -> Lexical 0.53 JSON, without Lexical, DOM or network.
 * Shapes follow the runtime's native heading/list/code/table/link serializers.
 */
export type MarkdownMode = 'replace' | 'append' | 'prepend';

export type MarkdownStatistics = {
  blocks: number;
  text_nodes: number;
  characters: number;
  headings: number;
  lists: number;
  tables: number;
  code_blocks: number;
  links: number;
};

export type MarkdownConversion = {
  document: NotebookDocument;
  format: 'markdown';
  blocks: number;
  outline: string[];
  warnings: string[];
  statistics: MarkdownStatistics;
};

type JsonRecord = Record<string, any>;
type Context = { warnings: string[]; outline: string[]; statistics: MarkdownStatistics };

const BOLD = 1;
const ITALIC = 2;
const STRIKE = 4;
const CODE = 16;

export function markdownDocument(
  document: NotebookDocument,
  markdown: string,
  mode: MarkdownMode = 'replace',
): MarkdownConversion {
  const parsed = parseNotebookDocument(document);
  const state = parsed.editorState === null ? { root: createRoot() } : (JSON.parse(parsed.editorState) as JsonRecord);
  const root = asRecord(state.root);
  const context: Context = {
    warnings: [],
    outline: [],
    statistics: { blocks: 0, text_nodes: 0, characters: 0, headings: 0, lists: 0, tables: 0, code_blocks: 0, links: 0 },
  };
  const source = markdown.replace(/\r\n?/g, '\n');
  const frontmatter = /^---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/.exec(source);
  const lexer = new Lexer({ gfm: true, breaks: false, pedantic: false });
  const nodes = frontmatter
    ? [
        element('paragraph', {}, textWithBreaks(frontmatter[0].replace(/\n$/, ''), 0, context)),
        ...blocks(lexer.lex(source.slice(frontmatter[0].length)), context),
      ]
    : blocks(lexer.lex(source), context);
  if (frontmatter) context.warnings.push('YAML frontmatter is not supported; it was retained as plain text.');
  if (!Array.isArray(root.children)) throw new Error('Notebook editorState root.children 不是数组');
  const existing = root.children;
  root.children = mode === 'replace' ? nodes : mode === 'prepend' ? [...nodes, ...existing] : [...existing, ...nodes];
  // Lexical cannot load an empty editor state. An empty write still produces
  // a valid editable paragraph, without adding spacer paragraphs to appends.
  if (!root.children.length) root.children = [element('paragraph', {}, [])];
  root.type ??= 'root';
  root.version ??= 1;
  context.statistics.blocks = nodes.length;
  return {
    document: parseNotebookDocument({ version: 1, editorState: JSON.stringify(state) }),
    format: 'markdown',
    blocks: nodes.length,
    outline: context.outline,
    warnings: [...new Set(context.warnings)],
    statistics: context.statistics,
  };
}

function blocks(tokens: Token[], context: Context): JsonRecord[] {
  const result: JsonRecord[] = [];
  for (const token of tokens) {
    const item = token as JsonRecord;
    switch (item.type) {
      case 'space':
        break;
      case 'def':
        context.warnings.push(
          'Reference definitions were retained as plain text; references in the document are resolved to links.',
        );
        result.push(element('paragraph', {}, textWithBreaks(String(item.raw), 0, context)));
        break;
      case 'heading': {
        context.outline.push(plainInline(item.tokens as Token[] | undefined, String(item.text ?? '')));
        context.statistics.headings += 1;
        result.push(
          element(
            'heading',
            { tag: `h${Math.min(6, Math.max(1, Number(item.depth) || 1))}` },
            inline(item.tokens as Token[] | undefined, context),
          ),
        );
        break;
      }
      case 'paragraph':
        result.push(
          element('paragraph', {}, inline(item.tokens as Token[] | undefined, context, String(item.text ?? ''))),
        );
        break;
      case 'text':
        result.push(element('paragraph', {}, inline([token], context)));
        break;
      case 'code':
        context.statistics.code_blocks += 1;
        {
          const info = typeof item.lang === 'string' ? item.lang.trim() : '';
          const [language = '', ...metadata] = info.split(/\s+/);
          if (metadata.length)
            context.warnings.push(
              `Code fence metadata "${metadata.join(' ')}" is not styled; the full info string is retained in node state.`,
            );
          result.push(
            element(
              'code',
              {
                ...(language ? { language } : {}),
                ...(metadata.length ? { $: { micaMarkdownCodeInfo: info } } : {}),
              },
              textWithBreaks(String(item.text ?? ''), 0, context),
            ),
          );
        }
        break;
      case 'blockquote':
        result.push(element('quote', {}, blocks((item.tokens as Token[] | undefined) ?? [], context)));
        break;
      case 'list':
        context.statistics.lists += 1;
        result.push(listNode(item, context));
        break;
      case 'table':
        if (hasExtraTableCells(item)) {
          context.warnings.push(
            'A table row has extra cells; the table was retained as plain text to avoid discarding content.',
          );
          result.push(element('paragraph', {}, textWithBreaks(String(item.raw), 0, context)));
        } else {
          context.statistics.tables += 1;
          result.push(tableNode(item, context));
        }
        break;
      case 'hr':
        result.push({ type: 'horizontalrule', version: 1 });
        break;
      case 'html':
        context.warnings.push('HTML is not executed; it was inserted as plain text.');
        result.push(element('paragraph', {}, [textNode(String(item.raw ?? item.text ?? ''), 0, context)]));
        break;
      default:
        context.warnings.push(`Unsupported Markdown block "${String(item.type)}" was inserted as plain text.`);
        result.push(element('paragraph', {}, [textNode(String(item.raw ?? item.text ?? ''), 0, context)]));
    }
  }
  return result;
}

function inline(tokens: Token[] | undefined, context: Context, fallback = ''): JsonRecord[] {
  if (!tokens?.length) return fallback ? textWithBreaks(fallback, 0, context) : [];
  const result: JsonRecord[] = [];
  for (const token of tokens) {
    const item = token as JsonRecord;
    switch (item.type) {
      case 'text':
      case 'escape':
        if (Array.isArray(item.tokens))
          result.push(...inline(item.tokens as Token[], context, String(item.text ?? '')));
        else {
          const text = decodeMarkdownEntities(String(item.text ?? ''));
          if (/\[\^[^\]]+\]|\$[^\n$]+\$|==[^\n=]+==/.test(text))
            context.warnings.push(
              'Footnotes, math and highlight syntax are not supported; their source was retained as plain text.',
            );
          result.push(...textWithBreaks(text, 0, context));
        }
        break;
      case 'strong':
        result.push(...withFormat(inline(item.tokens as Token[] | undefined, context, String(item.text ?? '')), BOLD));
        break;
      case 'em':
        result.push(
          ...withFormat(inline(item.tokens as Token[] | undefined, context, String(item.text ?? '')), ITALIC),
        );
        break;
      case 'del':
        result.push(
          ...withFormat(inline(item.tokens as Token[] | undefined, context, String(item.text ?? '')), STRIKE),
        );
        break;
      case 'codespan':
        result.push(textNode(String(item.text ?? ''), CODE, context));
        break;
      case 'br':
        result.push({ type: 'linebreak', version: 1 });
        break;
      case 'link':
        result.push(
          ...linkNodes(item, inline(item.tokens as Token[] | undefined, context, String(item.text ?? '')), context),
        );
        break;
      case 'image': {
        const alt = String(item.text ?? '');
        context.warnings.push(`Image "${alt}" was downgraded to text or a safe link; image nodes are not created.`);
        const children = [textNode(decodeMarkdownEntities(alt || String(item.href ?? '') || '[image]'), 0, context)];
        result.push(
          ...linkNodes({ href: String(item.href ?? ''), title: item.title }, children, context),
        );
        break;
      }
      case 'html':
        context.warnings.push('HTML is not executed; it was inserted as plain text.');
        result.push(textNode(String(item.raw ?? item.text ?? ''), 0, context));
        break;
      case 'checkbox':
        result.push(textNode(item.checked ? '[x] ' : '[ ] ', 0, context));
        break;
      default:
        context.warnings.push(`Unsupported Markdown inline syntax "${String(item.type)}" was inserted as plain text.`);
        result.push(textNode(String(item.raw ?? item.text ?? ''), 0, context));
    }
  }
  return result;
}

function listNode(token: JsonRecord, context: Context): JsonRecord {
  const ordered = Boolean(token.ordered);
  const task = ((token.items as JsonRecord[] | undefined) ?? []).some((item) => item.task);
  if (task && (token.items as JsonRecord[]).some((item) => !item.task))
    context.warnings.push(
      'Mixed task and ordinary list items were rendered as a checklist; ordinary items are unchecked.',
    );
  const start = typeof token.start === 'number' ? token.start : 1;
  const children: JsonRecord[] = [];
  for (const [index, item] of ((token.items as JsonRecord[] | undefined) ?? []).entries()) {
    const itemTokens = (item.tokens as Token[] | undefined) ?? [];
    const nestedIndex = itemTokens.findIndex((child) => child.type === 'list');
    if (
      nestedIndex >= 0 &&
      itemTokens.slice(nestedIndex + 1).some((child) => !['list', 'space'].includes(child.type))
    ) {
      context.warnings.push(
        'A list item with content after a nested list was retained as plain text to preserve its original order.',
      );
      children.push(
        element(
          'listitem',
          { value: start + index, ...(task ? { checked: Boolean(item.checked) } : {}) },
          textWithBreaks(String(item.text ?? item.raw), 0, context),
        ),
      );
      continue;
    }
    const itemChildren: JsonRecord[] = [];
    const nestedLists: JsonRecord[] = [];
    for (const child of itemTokens) {
      const record = child as JsonRecord;
      if (record.type === 'list') {
        context.statistics.lists += 1;
        nestedLists.push(listNode(record, context));
      } else if (record.type === 'paragraph' || record.type === 'text') {
        if (itemChildren.length) itemChildren.push({ type: 'linebreak', version: 1 });
        itemChildren.push(...inline(record.tokens as Token[] | undefined, context, String(record.text ?? '')));
      } else if (record.type !== 'checkbox' && record.type !== 'space') {
        itemChildren.push(...blocks([child], context));
      }
    }
    children.push(
      element('listitem', { value: start + index, ...(task ? { checked: Boolean(item.checked) } : {}) }, itemChildren),
    );
    // Native Lexical nested lists live in a separate listitem wrapper, not
    // beside the parent's text in one item (which changes markers on import).
    for (const nested of nestedLists)
      children.push(element('listitem', { value: start + index, ...(task ? { checked: false } : {}) }, [nested]));
  }
  return element(
    'list',
    { listType: task ? 'check' : ordered ? 'number' : 'bullet', start, tag: ordered && !task ? 'ol' : 'ul' },
    children,
  );
}

function tableNode(token: JsonRecord, context: Context): JsonRecord {
  const header = (token.header as JsonRecord[] | undefined) ?? [];
  const rows = [
    header.map((cell) => tableCell(cell, true, context)),
    ...((token.rows as JsonRecord[][] | undefined) ?? []).map((row) =>
      row.map((cell) => tableCell(cell, false, context)),
    ),
  ];
  return element(
    'table',
    {},
    rows.map((cells) => element('tablerow', {}, cells)),
  );
}

/** marked pads short rows but truncates extra GFM cells; never silently do so. */
function hasExtraTableCells(token: JsonRecord): boolean {
  const columns = (token.header as unknown[]).length;
  return String(token.raw)
    .trimEnd()
    .split('\n')
    .slice(2)
    .some((line) => {
      let body = line.trim();
      if (body.startsWith('|')) body = body.slice(1);
      if (/(?<!\\)\|$/.test(body)) body = body.slice(0, -1);
      let count = 1;
      let escapes = 0;
      for (const character of body) {
        if (character === '|' && escapes % 2 === 0) count++;
        escapes = character === '\\' ? escapes + 1 : 0;
      }
      return count > columns;
    });
}

function tableCell(cell: JsonRecord, header: boolean, context: Context): JsonRecord {
  const format = cell.align ?? '';
  return element('tablecell', { headerState: header ? 1 : 0, colSpan: 1, rowSpan: 1, backgroundColor: null, format }, [
    element('paragraph', { format }, inline(cell.tokens as Token[] | undefined, context, String(cell.text ?? ''))),
  ]);
}

function linkNodes(token: JsonRecord, children: JsonRecord[], context: Context): JsonRecord[] {
  const href = decodeMarkdownEntities(String(token.href ?? ''));
  if (!isSafeUrl(href)) {
    context.warnings.push(`Unsafe URL "${href}" was rejected; link text was retained without a link.`);
    return children;
  }
  context.statistics.links += 1;
  return [
    element(
      'link',
      {
        url: href,
        rel: 'noopener noreferrer',
        target: null,
        title: typeof token.title === 'string' ? decodeMarkdownEntities(token.title) : null,
      },
      children,
    ),
  ];
}

function withFormat(nodes: JsonRecord[], format: number): JsonRecord[] {
  return nodes.map((node) =>
    node.type === 'text'
      ? { ...node, format: Number(node.format ?? 0) | format }
      : Array.isArray(node.children)
        ? { ...node, children: withFormat(node.children, format) }
        : node,
  );
}

function textWithBreaks(value: string, format: number, context: Context): JsonRecord[] {
  return value
    .split('\n')
    .flatMap((part, index, all) => [
      ...(part ? [textNode(part, format, context)] : []),
      ...(index < all.length - 1 ? [{ type: 'linebreak', version: 1 }] : []),
    ]);
}

function textNode(text: string, format: number, context: Context): JsonRecord {
  context.statistics.text_nodes += 1;
  context.statistics.characters += text.length;
  return { detail: 0, format, mode: 'normal', style: '', text, type: 'text', version: 1 };
}

function element(type: string, extra: JsonRecord, children: JsonRecord[]): JsonRecord {
  return { children, direction: null, format: '', indent: 0, ...extra, type, version: 1 };
}

function createRoot(): JsonRecord {
  return { children: [], direction: null, format: '', indent: 0, type: 'root', version: 1 };
}
function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Notebook editorState root 不是对象');
  return value as JsonRecord;
}

function plainInline(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens?.length) return fallback.replace(/\s+/g, ' ').trim();
  return tokens
    .map((token) => {
      const item = token as JsonRecord;
      if (item.type === 'br') return ' ';
      if (item.type === 'html') return String(item.text ?? item.raw ?? '');
      if (Array.isArray(item.tokens)) return plainInline(item.tokens as Token[], String(item.text ?? ''));
      return decodeMarkdownEntities(String(item.text ?? item.raw ?? ''));
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Allow absolute http(s)/mailto, root/path/query/fragment-relative URLs.
 * Reject unknown schemes, controls/whitespace, backslashes, protocol-relative
 * URLs and entity-obfuscated schemes. HTML is never parsed or executed.
 */
export function isSafeUrl(value: string): boolean {
  const url = decodeMarkdownEntities(value);
  if (!url || /[\u0000-\u0020\u007f\\]/.test(url) || /&(?:#\w+|\w+);/.test(url)) return false;
  if (/^(?:https?|mailto):/i.test(url)) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'mailto:' ? Boolean(parsed.pathname) : Boolean(parsed.hostname);
    } catch {
      return false;
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//')) return false;
  return (
    url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || url.startsWith('#') || !url.includes(':')
  );
}

/** Decode the entity subset Markdown permits in ordinary text and destinations. */
function decodeMarkdownEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi, (whole, hex, decimal, named) => {
    if (named) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[String(named).toLowerCase()] ?? whole;
    const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
    return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : whole;
  });
}
