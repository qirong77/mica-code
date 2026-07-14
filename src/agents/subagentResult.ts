export type StructuredSubagentResult = {
  status: 'completed' | 'failed' | 'partial';
  summary: string;
  findings: string[];
  files_touched: string[];
  risks: string[];
  next_actions_for_parent: string[];
  raw: string;
};

const MAX_LIST_ITEMS = 12;
const MAX_ITEM_CHARS = 400;
const MAX_SUMMARY_CHARS = 2_000;

export function formatStructuredSubagentResult(options: {
  type: string;
  description: string;
  result: string;
  status?: StructuredSubagentResult['status'];
}): string {
  const structured = parseStructuredSubagentResult(options.result, options.status ?? 'completed');
  return [
    `Subagent: ${options.type}`,
    `Task: ${options.description}`,
    `Status: ${structured.status}`,
    '',
    '## Summary',
    structured.summary || '(empty summary)',
    '',
    '## Findings',
    formatList(structured.findings),
    '',
    '## Files touched',
    formatList(structured.files_touched),
    '',
    '## Risks',
    formatList(structured.risks),
    '',
    '## Next actions for parent',
    formatList(structured.next_actions_for_parent),
    '',
    '## Raw result',
    structured.raw || '(empty result)',
  ].join('\n');
}

export function parseStructuredSubagentResult(
  result: string,
  fallbackStatus: StructuredSubagentResult['status'] = 'completed',
): StructuredSubagentResult {
  const raw = result.trim();
  const fromJson = tryParseJsonResult(raw);
  if (fromJson) {
    return {
      status: normalizeStatus(fromJson.status, fallbackStatus),
      summary: clampText(asString(fromJson.summary) || raw || '(empty result)', MAX_SUMMARY_CHARS),
      findings: normalizeStringList(fromJson.findings),
      files_touched: normalizeStringList(fromJson.files_touched ?? fromJson.filesTouched),
      risks: normalizeStringList(fromJson.risks),
      next_actions_for_parent: normalizeStringList(fromJson.next_actions_for_parent ?? fromJson.nextActionsForParent),
      raw,
    };
  }

  return {
    status: fallbackStatus,
    summary: clampText(raw || '(empty result)', MAX_SUMMARY_CHARS),
    findings: extractBulletSection(raw, ['findings', 'finding', '结论', '发现']),
    files_touched: extractPathCandidates(raw),
    risks: extractBulletSection(raw, ['risks', 'risk', '风险']),
    next_actions_for_parent: extractBulletSection(raw, [
      'next actions',
      'next_actions',
      'next steps',
      '后续',
      '下一步',
    ]),
    raw,
  };
}

function tryParseJsonResult(raw: string): Record<string, unknown> | null {
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) candidates.push(objectMatch[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Keep scanning candidates.
    }
  }
  return null;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .map((item) => clampText(item, MAX_ITEM_CHARS))
    .slice(0, MAX_LIST_ITEMS);
}

function extractBulletSection(text: string, headings: string[]): string[] {
  const lines = text.split(/\r?\n/);
  const headingPattern = new RegExp(`^\\s{0,3}#{0,3}\\s*(?:${headings.map(escapeRegExp).join('|')})\\s*:?\\s*$`, 'i');
  let collecting = false;
  const items: string[] = [];
  for (const line of lines) {
    if (headingPattern.test(line)) {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    if (/^\s{0,3}#{1,3}\s+\S/.test(line) || /^\s*[A-Za-z\u4e00-\u9fff].*:$/.test(line)) break;
    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (bullet?.[1]) items.push(clampText(bullet[1].trim(), MAX_ITEM_CHARS));
  }
  return items.slice(0, MAX_LIST_ITEMS);
}

function extractPathCandidates(text: string): string[] {
  const matches = text.match(/(?:[A-Za-z]:)?(?:\.?\.?\/)?[\w.-]+(?:\/[\w.-]+)+/g) ?? [];
  return [...new Set(matches.map((item) => item.trim()))].slice(0, MAX_LIST_ITEMS);
}

function formatList(items: string[]): string {
  if (items.length === 0) return '- (none)';
  return items.map((item) => `- ${item}`).join('\n');
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 16))}...[truncated]`;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeStatus(
  value: unknown,
  fallback: StructuredSubagentResult['status'],
): StructuredSubagentResult['status'] {
  if (value === 'completed' || value === 'failed' || value === 'partial') return value;
  return fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
