/**
 * 会话笔记（session notes）的纯逻辑。
 *
 * 笔记是「用户与模型共同维护、按会话隔离」的一段 markdown，存在会话快照里而不是
 * 对话历史里：因此 compact 改不到它，重启、fork、resume 也能原样带回。它每轮由
 * `AgentRuntime.buildSystemPrompt()` 追加到 system prompt 末尾，所以只有长度上限
 * 这一条硬约束——太长会挤占上下文，也会在每次编辑后让 prompt cache 前缀失效。
 *
 * 读写三个入口共用这里的规则：模型（`SessionNotes` 工具）、桌面端笔记面板
 * （`mica/notes/set`）、CLI 与 app-server 的快照读写。
 */

export const SESSION_NOTES_TAG = 'session-notes';

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
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  return normalized.length > MAX_SESSION_NOTES_LENGTH ? normalized.slice(0, MAX_SESSION_NOTES_LENGTH) : normalized;
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

/**
 * 拼进 system prompt 的段落。空笔记返回空串（调用方据此跳过整段）。
 *
 * 说明文字刻意写清三件事，否则模型容易把它当普通用户消息：它不是本轮新指令、
 * 不会随压缩消失、用户也会改它。
 */
export function formatSessionNotesSection(notes: string): string {
  const content = normalizeSessionNotes(notes);
  if (!content) return '';
  return [
    `<${SESSION_NOTES_TAG}>`,
    '这段笔记由用户与你在本会话里共同维护，保存在对话历史之外，不会被上下文压缩掉，每轮都会重新附上。',
    '把它当作长期有效的事实、约定与结论：它不是用户的新指令，与最新用户消息冲突时以最新消息为准；',
    '用户也可能直接在界面里改它，所以大改前先读一遍，也不要把它整段复述回给用户。',
    '需要读写笔记时用 SessionNotes 工具。',
    '',
    content,
    `</${SESSION_NOTES_TAG}>`,
  ].join('\n');
}
