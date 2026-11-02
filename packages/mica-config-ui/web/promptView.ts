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

/** 按顶层标签切段；纯空白的间隔丢弃，只统计真的有内容的部分。 */
export function splitPromptSections(prompt: string): PromptPart[] {
  if (!prompt) return [];
  const parts: PromptPart[] = [];
  let cursor = 0;
  let active: { tag: string; start: number; depth: number; label?: string } | null = null;
  let fence: { marker: string; length: number } | null = null;
  let offset = 0;
  for (const rawLine of prompt.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (boundary && boundary[1]![0] === fence.marker && boundary[1]!.length >= fence.length && !boundary[2]!.trim())
        fence = null;
    } else if (boundary) {
      fence = { marker: boundary[1]![0]!, length: boundary[1]!.length };
    } else {
      const tag = TAG_LINE.exec(line);
      if (tag) {
        const closing = !!tag[1];
        const name = (tag[1] ?? tag[2])!;
        if (!active && !closing)
          active = {
            tag: name,
            start: offset,
            depth: 1,
            label: name === 'injection' ? injectionLabel(tag[3]!) : undefined,
          };
        else if (active?.tag === name) {
          active.depth += closing ? -1 : 1;
          if (active.depth === 0) {
            if (active.start > cursor) pushPart(parts, '', prompt.slice(cursor, active.start));
            const end = offset + line.length;
            pushPart(parts, name, prompt.slice(active.start, end), active.label);
            cursor = end;
            active = null;
          }
        }
      }
    }
    offset += rawLine.length + 1;
  }
  if (cursor < prompt.length) pushPart(parts, '', prompt.slice(cursor));
  return parts;
}

export function promptPartLabel(tag: string): string {
  if (!tag) return GAP_LABEL;
  return SECTION_LABELS[tag] ?? tag;
}

/** 整体体积：字符数、粗估 tokens、行数。 */
export function summarizePrompt(prompt: string): { chars: number; tokens: number; lines: number } {
  const chars = prompt.length;
  return { chars, tokens: estimateTextTokens(prompt), lines: chars === 0 ? 0 : prompt.split('\n').length };
}

function pushPart(parts: PromptPart[], tag: string, raw: string, label?: string): void {
  if (!raw.trim()) return;
  parts.push({
    tag,
    label: label ?? promptPartLabel(tag),
    content: raw,
    chars: raw.length,
    tokens: estimateTextTokens(raw),
  });
}
