import { estimateTextTokens } from '../src/shared/text.js';

/**
 * 系统提示词的分段展示。
 *
 * 提示词是现场拼出来的：`<system>`（角色）、`<project-instructions>`（AGENT.md）、
 * `<skills>`（索引）、`<context>`（环境信息），再由插件追加自己的段落（会话笔记、循环说明…）。
 * 界面要回答「发出去的那一份里都有什么、各占多少」，所以按顶层标签切开，标签之间没被包住的
 * 部分（插件段落就是这么进来的）聚成一段「其它注入」，而不是假装它不存在。
 */
export type PromptPart = {
  /** 顶层标签名；空串表示标签之外的附加内容。 */
  tag: string;
  label: string;
  content: string;
  chars: number;
  tokens: number;
};

/**
 * 大纲里的一个节点：顶层段（`level` 0），或段内一个 markdown 标题（`#` 为 1、`##` 为 2…）。
 *
 * 体积有两种口径，别混用：
 * - `chars` / `tokens` 是**这一节连同它的子节**（`## 3. 代码地图` 包含它下面的三个 `###`），
 *   用来回答「它占了多少」——父节点小于子节点之和才是反直觉的。
 * - `ownChars` 只算它自己的正文，不含子节。搜索命中数按它计数，否则父节点的正文（含子节）
 *   会把同一处命中重复算一遍。
 */
export type PromptNode = {
  id: string;
  /** 所属顶层标签；段节点自己是标签名，节节点沿用所属段。 */
  tag: string;
  label: string;
  /** 0 = 顶层段，1..6 = markdown 标题层级。 */
  level: number;
  /** 在全文里的行范围（1-based，含首尾）。 */
  startLine: number;
  endLine: number;
  chars: number;
  tokens: number;
  ownChars: number;
  /** 正文（含子节）。 */
  content: string;
  /** 自身正文（不含子节）。 */
  ownContent: string;
  children: PromptNode[];
};

export type PromptOutline = {
  nodes: PromptNode[];
  summary: { chars: number; tokens: number; lines: number };
};

/** 已知段落的叫法：讲清它从哪来，而不是把标签名原样丢给用户。 */
const SECTION_LABELS: Record<string, string> = {
  system: '角色提示词',
  'project-instructions': '项目说明（AGENT.md）',
  skills: 'Skills 索引',
  context: '环境信息',
  session_notes: '会话笔记',
};

const GAP_LABEL = '插件段落 / 其它注入';
// Quoted values may contain `>`; closing tags never carry attributes.
const TAG_LINE =
  /^<(?:\/([a-z][a-z0-9_-]*)|([a-z][a-z0-9_-]*)((?:\s+[a-zA-Z_:][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*)>$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TITLE_LINE = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** Decode labels only, preserving the sent prompt and its size. */
function decodeXmlAttribute(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (entity, name: string) => {
    if (!name.startsWith('#')) return entities[name]!;
    const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}

function injectionLabel(attributes: string): string | undefined {
  const values = new Map<string, string>();
  for (const match of attributes.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g)) {
    values.set(match[1]!, decodeXmlAttribute(match[2] ?? match[3]!).trim());
  }
  return [values.get('plugin') || values.get('source'), values.get('section')].filter(Boolean).join(' / ') || undefined;
}

/** 提示词里可能出现的标题层级上限：再深的 `#####` 不单独成节，正文归最近的父节。 */
const MAX_TITLE_LEVEL = 4;

type RawBlock = {
  tag: string;
  /** 标签自带来源时（`<injection plugin=… section=…>`）显示它，否则用段名兜底。 */
  label?: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
};

type DraftNode = {
  id: string;
  tag: string;
  label: string;
  level: number;
  startOffset: number;
  endOffset: number;
  children: DraftNode[];
};

/**
 * 按顶层标签切段；纯空白的间隔丢弃，只统计真的有内容的部分。
 *
 * 会话详情的大纲读 `analyzePrompt()`，两者共用同一套切分，避免「大纲里的段」和
 * 「构成表里的段」对不上。
 */
export function splitPromptSections(prompt: string): PromptPart[] {
  return analyzePrompt(prompt).nodes.map((node) => ({
    tag: node.tag,
    label: node.label,
    content: node.content,
    chars: node.chars,
    tokens: node.tokens,
  }));
}

/**
 * 把提示词读成「段 → 标题」两级大纲。
 *
 * 只认顶层标签与 markdown 标题这两种边界：它们都是作者写下的结构，不是猜出来的语义。
 * 围栏代码块里的 `#` 与 `<tag>` 一律不当边界——那多半是 shell 注释或示例。
 */
export function analyzePrompt(prompt: string): PromptOutline {
  const summary = summarizePrompt(prompt);
  if (!prompt) return { nodes: [], summary };

  const lines = prompt.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const blocks = partitionBlocks(prompt, lines, lineStarts);
  const nodes = blocks.map((block, index) => {
    const draft = draftBlock(lines, lineStarts, block, String(index));
    return toNode(prompt, lineStarts, draft);
  });
  return { nodes, summary };
}

/** 在一棵大纲里按 id 找节点（含子节）。 */
export function findPromptNode(nodes: PromptNode[], id: string | null): PromptNode | null {
  if (!id) return null;
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findPromptNode(node.children, id);
    if (found) return found;
  }
  return null;
}

/** 从根到目标的节点链：详情头上的面包屑就是它。 */
export function promptNodePath(nodes: PromptNode[], id: string | null): PromptNode[] {
  if (!id) return [];
  for (const node of nodes) {
    if (node.id === id) return [node];
    const rest = promptNodePath(node.children, id);
    if (rest.length > 0) return [node, ...rest];
  }
  return [];
}

export type PromptSearchResult = {
  /** 只保留命中节点及其父链；顺序不变。 */
  nodes: PromptNode[];
  /** 节点 id → 它自己正文里的命中次数（不含子节）。 */
  hits: Map<string, number>;
  /** 整棵大纲的命中总次数。 */
  total: number;
};

/**
 * 在标题与正文里找关键词。
 *
 * 返回的是「过滤后的树 + 每个节点自己的命中数」：搜索要能回答「这段话出现在哪一节」，
 * 只过滤标题会让搜正文的人扑空；只高亮正文又得把整份提示词重新渲染一遍，代价不划算。
 */
export function searchPrompt(nodes: PromptNode[], query: string): PromptSearchResult {
  const needle = query.trim().toLowerCase();
  const hits = new Map<string, number>();
  if (!needle) return { nodes, hits, total: 0 };

  let total = 0;
  const walk = (list: PromptNode[]): PromptNode[] => {
    const kept: PromptNode[] = [];
    for (const node of list) {
      const children = walk(node.children);
      const own = countOccurrences(`${node.label}\n${node.ownContent}`.toLowerCase(), needle);
      if (own > 0) {
        hits.set(node.id, own);
        total += own;
      }
      // 自己没命中但子节命中的，也要留在树上——父链就是「去那一节」的路。
      if (own > 0 || children.length > 0) kept.push({ ...node, children });
    }
    return kept;
  };

  return { nodes: walk(nodes), hits, total };
}

/** 整体体积：字符数、粗估 tokens、行数。 */
export function summarizePrompt(prompt: string): { chars: number; tokens: number; lines: number } {
  const chars = prompt.length;
  return { chars, tokens: estimateTextTokens(prompt), lines: chars === 0 ? 0 : prompt.split('\n').length };
}

export function promptPartLabel(tag: string): string {
  if (!tag) return GAP_LABEL;
  return SECTION_LABELS[tag] ?? tag;
}

/** 段内标题的显示名：标题本身就是作者写的目录，直接用它。 */
export function promptTitleLabel(title: string): string {
  return title.trim() || '（无标题）';
}

/** 顶层标签与「标签之外的内容」切成块，记录每块的行范围与偏移。 */
function partitionBlocks(prompt: string, lines: string[], lineStarts: number[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  let cursorOffset = 0;
  let active: { tag: string; label?: string; startLine: number; startOffset: number; depth: number } | null = null;
  let fence: { marker: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\r$/, '');
    const offset = lineStarts[index]!;
    const boundary = FENCE_LINE.exec(line);
    if (fence) {
      if (boundary && boundary[1]![0] === fence.marker && boundary[1]!.length >= fence.length && !boundary[2]!.trim()) {
        fence = null;
      }
    } else if (boundary) {
      fence = { marker: boundary[1]![0]!, length: boundary[1]!.length };
    } else {
      const tag = TAG_LINE.exec(line);
      if (tag) {
        const closing = !!tag[1];
        const name = (tag[1] ?? tag[2])!;
        if (!active && !closing) {
          active = {
            tag: name,
            label: name === 'injection' ? injectionLabel(tag[3] ?? '') : undefined,
            startLine: index,
            startOffset: offset,
            depth: 1,
          };
        } else if (active?.tag === name) {
          active.depth += closing ? -1 : 1;
          if (active.depth === 0) {
            if (active.startOffset > cursorOffset) {
              pushBlock(blocks, prompt, '', cursorOffset, active.startOffset, lineStarts);
            }
            const endOffset = offset + line.length;
            pushBlock(blocks, prompt, name, active.startOffset, endOffset, lineStarts, active.label);
            cursorOffset = endOffset;
            active = null;
          }
        }
      }
    }
  }

  if (cursorOffset < prompt.length) pushBlock(blocks, prompt, '', cursorOffset, prompt.length, lineStarts);
  return blocks;
}

function pushBlock(
  blocks: RawBlock[],
  prompt: string,
  tag: string,
  startOffset: number,
  endOffset: number,
  lineStarts: number[],
  label?: string,
): void {
  if (!prompt.slice(startOffset, endOffset).trim()) return;
  blocks.push({
    tag,
    label,
    startOffset,
    endOffset,
    startLine: lineAtOffsets(lineStarts, startOffset),
    endLine: lineAtOffsets(lineStarts, Math.max(startOffset, endOffset - 1)),
  });
}

/** 把一块切成标题节点树；标题之外的正文留给所在的段 / 父节自己。 */
function draftBlock(
  lines: string[],
  lineStarts: number[],
  block: RawBlock,
  idPrefix: string,
): DraftNode {
  const titles: { level: number; title: string; offset: number }[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (let index = block.startLine - 1; index <= block.endLine - 1 && index < lines.length; index++) {
    const line = lines[index]!.replace(/\r$/, '');
    const boundary = FENCE_LINE.exec(line);
    if (fence) {
      if (boundary && boundary[1]![0] === fence.marker && boundary[1]!.length >= fence.length && !boundary[2]!.trim()) {
        fence = null;
      }
      continue;
    }
    if (boundary) {
      fence = { marker: boundary[1]![0]!, length: boundary[1]!.length };
      continue;
    }
    const title = TITLE_LINE.exec(line);
    if (!title) continue;
    const level = title[1]!.length;
    // 太深的标题不再单独成节：切出来只会得到一屏「###」小行，正文也不比父节多几行。
    if (level > MAX_TITLE_LEVEL) continue;
    titles.push({ level, title: title[2]!, offset: lineStarts[index]! });
  }

  const root: DraftNode = {
    id: idPrefix,
    tag: block.tag,
    label: block.label ?? promptPartLabel(block.tag),
    level: 0,
    startOffset: block.startOffset,
    endOffset: block.endOffset,
    children: [],
  };
  if (titles.length === 0) return root;

  const stack: DraftNode[] = [root];
  titles.forEach((item, index) => {
    while (stack.length > 1 && stack[stack.length - 1]!.level >= item.level) stack.pop();
    const parent = stack[stack.length - 1]!;
    const node: DraftNode = {
      id: `${parent.id}/${index}`,
      tag: block.tag,
      label: promptTitleLabel(item.title),
      level: item.level,
      startOffset: item.offset,
      // 到下一个同级或更高级的标题之前：`chars` 因此包含自己的子节。
      endOffset: nextBoundaryOffset(titles, index, block.endOffset),
      children: [],
    };
    parent.children.push(node);
    stack.push(node);
  });

  // 段名已经说明了这块从哪来（「项目说明（AGENT.md）」），再让唯一的 h1 占一层只会多一次点击。
  if (root.children.length === 1 && root.children[0]!.level === 1) {
    root.children = root.children[0]!.children;
  }
  return root;
}

function nextBoundaryOffset(titles: { level: number; offset: number }[], index: number, blockEnd: number): number {
  const level = titles[index]!.level;
  for (let next = index + 1; next < titles.length; next++) {
    if (titles[next]!.level <= level) return titles[next]!.offset;
  }
  return blockEnd;
}

function toNode(prompt: string, lineStarts: number[], draft: DraftNode): PromptNode {
  const children = draft.children.map((child) => toNode(prompt, lineStarts, child));
  const content = prompt.slice(draft.startOffset, draft.endOffset);
  const ownContent = withoutChildren(prompt, draft);
  return {
    id: draft.id,
    tag: draft.tag,
    label: draft.label,
    level: draft.level,
    startLine: lineAtOffsets(lineStarts, draft.startOffset),
    endLine: lineAtOffsets(lineStarts, Math.max(draft.startOffset, draft.endOffset - 1)),
    chars: content.length,
    tokens: estimateTextTokens(content),
    ownChars: ownContent.length,
    content,
    ownContent,
    children,
  };
}

/** 一个节点自己的正文：把直接子节所占的区间挖掉，剩下的才是它自己写的部分。 */
function withoutChildren(prompt: string, draft: DraftNode): string {
  if (draft.children.length === 0) return prompt.slice(draft.startOffset, draft.endOffset);
  let output = '';
  let cursor = draft.startOffset;
  for (const child of draft.children) {
    if (child.startOffset > cursor) output += prompt.slice(cursor, child.startOffset);
    cursor = Math.max(cursor, child.endOffset);
  }
  if (cursor < draft.endOffset) output += prompt.slice(cursor, draft.endOffset);
  return output;
}

/** offset 落在哪一行（1-based）。按行起点二分：大提示词里节点多，逐行累加是平方复杂度。 */
function lineAtOffsets(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
