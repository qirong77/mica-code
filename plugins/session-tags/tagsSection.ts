import { TAG_COLORS, type TagColor, type TagStore } from './tags.js';

/**
 * 拼进 system prompt 的段落。没有标签返回空串，`PluginPromptSections` 据此跳过整段。
 *
 * 为什么只给「当前会话的标签」而不是整张标签表：标签表是检索用的，对模型没有决策价值，
 * 每轮都塞进去只会让它更想「帮忙整理标签」。这里只要它知道这条会话被归到了哪一类，
 * 并且明确不要自作主张地改。
 */
export function formatSessionTagsSection(store: TagStore, colors: readonly TagColor[]): string {
  if (colors.length === 0) return '';
  const names = colors.map((color) => `${store.labels[color]} [${color}]`).join('、');
  return [
    '<session-tags>',
    `用户在界面里把这条会话标记为：${names}。标签来自 ${TAG_COLORS.length} 个固定色槽，只是用户自己的检索分类。`,
    '它不是任务指令，不会改变本轮的要求；不要因为标签扩大或缩小任务范围，也不要在用户没要求时增删标签。',
    '用户明确要求读写标签时用 session_tags 工具。',
    '</session-tags>',
  ].join('\n');
}
