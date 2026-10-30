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
const SECTION_PATTERN = /^<([a-z][a-z0-9_-]*)>\r?\n([\s\S]*?)\r?\n<\/\1>$/gm;

/** 按顶层标签切段；纯空白的间隔丢弃，只统计真的有内容的部分。 */
export function splitPromptSections(prompt: string): PromptPart[] {
  if (!prompt) return [];
  const parts: PromptPart[] = [];
  let cursor = 0;
  SECTION_PATTERN.lastIndex = 0;
  for (let match = SECTION_PATTERN.exec(prompt); match; match = SECTION_PATTERN.exec(prompt)) {
    const start = match.index;
    if (start > cursor) pushPart(parts, '', prompt.slice(cursor, start));
    pushPart(parts, match[1]!, match[0]);
    cursor = start + match[0].length;
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

function pushPart(parts: PromptPart[], tag: string, raw: string): void {
  if (!raw.trim()) return;
  parts.push({ tag, label: promptPartLabel(tag), chars: raw.length, tokens: estimateTextTokens(raw) });
}
