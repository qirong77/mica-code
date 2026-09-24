/**
 * `mica-file-mentions`：`@` 文件补全的唯一实现。
 *
 * - `rank.ts`：纯逻辑（触发判定、评分排序、标签高亮、插入文本），无 node 依赖，
 *   浏览器端渲染层可以直接引用 `@packages/mica-file-mentions/rank.js`。
 * - `search.ts`：工作区扫描（git/fd + 缓存）与 `prewarmFileMentions`，只在 Node 侧使用。
 */
export type { FileMentionItem, RankedFileMention } from './rank.js';
export {
  IGNORED_DIRECTORIES,
  MAX_FILE_MENTION_RESULTS,
  MAX_WORKSPACE_FILES,
  activeFileMention,
  compareRankedMentions,
  computeLabelHighlights,
  collectDirectoryPaths,
  isWorkspaceFile,
  matchWorkspaceFiles,
  mentionPath,
  mentionText,
  normalizePathQuery,
  rankWorkspaceFiles,
  scorePath,
} from './rank.js';
export { findFileMentions, prewarmFileMentions } from './search.js';
