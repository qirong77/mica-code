/**
 * 会话笔记（session notes）的纯逻辑。
 *
 * 笔记是「用户与模型共同维护、按会话隔离」的一段 markdown，存在会话快照里而不是
 * 对话历史里：因此 compact 改不到它，重启、fork、resume 也能原样带回。它每轮由
 * `AgentRuntime.buildSystemPrompt()` 追加到 system prompt 末尾，所以只有长度上限
 * 这一条硬约束——太长会挤占上下文，也会在每次编辑后让 prompt cache 前缀失效。
 *
 * 读写三个入口共用这里的规则：模型（`session_notes` 工具）、桌面端笔记卡片
 * （`mica/sessionState/set`）、CLI 与 app-server 的快照读写。
 */

export const SESSION_NOTES_TAG = 'session-notes';

/**
 * 会话笔记插件在 `pluginState` 里的键。
 *
 * 笔记的**行为与界面**（工具、prompt 段落、顶栏卡片）都属于 `plugins/session-notes`；
 * 卡片的读写走通用的 `mica/sessionState/*`，键由插件决定，归一化规则放在共享层给
 * 插件的两半（工具与卡片）共用。
 */
export const SESSION_NOTES_PLUGIN_ID = 'session-notes';

/** 笔记长度上限（字符）。按中文密度估算约 1.5 万 token，够写一整轮设计结论。 */
export const MAX_SESSION_NOTES_LENGTH = 20000;

/**
 * 把任意输入收敛成可持久化的笔记文本。
 *
 * - 非字符串一律视为空（旧会话缺字段、客户端传了 null、损坏的文件）；
 * - 统一换行、去掉行尾空白与尾部空行，避免每次编辑都因为多一个换行而像「被改过」；
 * - 超出上限直接截断：宿主宁可少存几个字，也不能让每一轮 system prompt 无限增长。
 */
export function normalizeSessionNotes(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = tidyNotes(value);
  return normalized.length > MAX_SESSION_NOTES_LENGTH ? normalized.slice(0, MAX_SESSION_NOTES_LENGTH) : normalized;
}

/**
 * 只整理格式、不截断。
 *
 * 按节改之后要先判断有没有超限，再决定写不写：这里如果顺手截断，调用方看到的就已经是
 * 「刚好等于上限」的文本，超限检查永远不触发，用户会拿到一份被砍掉尾巴的笔记。
 */
function tidyNotes(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

/** 追加一段笔记：中间空一行，忽略空追加。返回归一化后的完整内容。 */
export function appendSessionNotes(current: string, addition: string): string {
  const base = normalizeSessionNotes(current);
  const next = normalizeSessionNotes(addition);
  if (!next) return base;
  return normalizeSessionNotes(base ? `${base}\n\n${next}` : next);
}

export function sessionNotesSummary(notes: string): { chars: number; lines: number } {
  const content = normalizeSessionNotes(notes);
  if (!content) return { chars: 0, lines: 0 };
  return { chars: content.length, lines: content.split('\n').length };
}

/** 笔记里的一节：标题行本身与它管辖的正文（到下一个同级或更高级标题为止）。 */
export type NotesSection = {
  /** 标题文字，不含前导 `#`。 */
  heading: string;
  level: number;
  /** 标题所在行（0 起）。 */
  line: number;
};

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * 列出所有标题行。
 *
 * 围栏代码块里的 `#` 不是标题：笔记里贴一段 shell 或 patch，里面的注释不能被当成
 * 可删的章节——按标题删除时那会删掉正文中间的一段。
 */
export function notesSections(notes: string): NotesSection[] {
  const content = normalizeSessionNotes(notes);
  if (!content) return [];
  const sections: NotesSection[] = [];
  let fence: string | null = null;
  content.split('\n').forEach((line, index) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence !== null) return;
    const match = HEADING.exec(line);
    if (match) sections.push({ heading: match[2]!.trim(), level: match[1]!.length, line: index });
  });
  return sections;
}

type SectionRange = { heading: string; from: number; to: number };

/**
 * 按标题定位一节的范围。标题匹配忽略前导 `#` 与大小写，但必须**唯一**：
 * 两个同名标题时猜测要删哪一个，删错比报错更糟。
 */
export function locateNotesSection(
  notes: string,
  query: string,
): { ok: true; range: SectionRange } | { ok: false; message: string } {
  const wanted = query.replace(/^#+\s*/, '').trim();
  if (!wanted) return { ok: false, message: 'section must name a heading' };
  const content = normalizeSessionNotes(notes);
  const lines = content ? content.split('\n') : [];
  const sections = notesSections(content);
  const matches = sections.filter((section) => section.heading.toLowerCase() === wanted.toLowerCase());
  if (matches.length === 0) {
    const available = sections.map((section) => `${'#'.repeat(section.level)} ${section.heading}`);
    return {
      ok: false,
      message: available.length
        ? `no section titled "${wanted}"; existing sections: ${available.join(' | ')}`
        : `no section titled "${wanted}"; the notes have no headings yet`,
    };
  }
  if (matches.length > 1) {
    const where = matches.map((section) => `line ${section.line + 1}`).join(', ');
    return {
      ok: false,
      message: `"${wanted}" matches ${matches.length} headings (${where}); rename one of them or use replace to rewrite the whole document`,
    };
  }
  const match = matches[0]!;
  let to = lines.length;
  for (const section of sections) {
    if (section.line > match.line && section.level <= match.level) {
      to = section.line;
      break;
    }
  }
  return { ok: true, range: { heading: match.heading, from: match.line, to } };
}

/** 删掉一节（标题连同正文），并把两侧的空行收成一个分隔空行。 */
export function removeNotesSection(
  notes: string,
  query: string,
): { ok: true; notes: string; heading: string } | { ok: false; message: string } {
  const located = locateNotesSection(notes, query);
  if (!located.ok) return located;
  const lines = normalizeSessionNotes(notes).split('\n');
  const before = lines.slice(0, located.range.from);
  const after = lines.slice(located.range.to);
  while (before.length > 0 && before[before.length - 1]!.trim() === '') before.pop();
  while (after.length > 0 && after[0]!.trim() === '') after.shift();
  const joined = [...before, ...(before.length > 0 && after.length > 0 ? [''] : []), ...after].join('\n');
  return { ok: true, notes: tidyNotes(joined), heading: located.range.heading };
}

/**
 * 只替换一节正文，标题行保留。
 *
 * 这是「笔记到上限了」的正确解法：整篇重写要重新生成两万字，按节改只要生成改的那一段，
 * 也不会顺手把别的章节弄丢。
 */
export function replaceNotesSection(
  notes: string,
  query: string,
  content: string,
): { ok: true; notes: string; heading: string } | { ok: false; message: string } {
  const located = locateNotesSection(notes, query);
  if (!located.ok) return located;
  const lines = normalizeSessionNotes(notes).split('\n');
  const body = normalizeSessionNotes(content);
  const before = lines.slice(0, located.range.from + 1);
  const after = lines.slice(located.range.to);
  while (after.length > 0 && after[0]!.trim() === '') after.shift();
  // 不额外插入空行：正文紧贴标题，与手写笔记的习惯一致，也避免每次按节改都让整篇
  // 的换行形状漂移（笔记每轮都进 system prompt，无谓的变化会让 prompt 前缀失效）。
  const joined = [
    ...before,
    ...(body ? body.split('\n') : []),
    ...(body && after.length > 0 ? [''] : []),
    ...after,
  ].join('\n');
  return { ok: true, notes: tidyNotes(joined), heading: located.range.heading };
}
