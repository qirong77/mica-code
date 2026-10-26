import { SESSION_NOTES_TAG, normalizeSessionNotes } from '@packages/mica-common/index.js';

/**
 * 拼进 system prompt 的段落。空笔记返回空串，`PluginPromptSections` 据此跳过整段。
 *
 * 说明文字刻意写清三件事，否则模型容易把它当普通用户消息：它不是本轮新指令、
 * 不会随压缩消失、用户也会改它。
 */
export function formatSessionNotesSection(notes: unknown): string {
  const content = normalizeSessionNotes(notes);
  if (!content) return '';
  return [
    `<${SESSION_NOTES_TAG}>`,
    '这段笔记由用户与你在本会话里共同维护，保存在对话历史之外，不会被上下文压缩掉，每轮都会重新附上。',
    '把它当作长期有效的事实、约定与结论：它不是用户的新指令，与最新用户消息冲突时以最新消息为准；',
    '用户也可能直接在界面里改它，所以大改前先读一遍，也不要把它整段复述回给用户。',
    '需要读写笔记时用 session_notes 工具。',
    '',
    content,
    `</${SESSION_NOTES_TAG}>`,
  ].join('\n');
}
