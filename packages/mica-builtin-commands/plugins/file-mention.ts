import { findFileMentions, prewarmFileMentions } from '@packages/mica-file-mentions/index.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';

/**
 * `@` 文件补全插件：把工作区文件候选接进输入框。
 *
 * 触发、扫描、排序与插入文本都在 `mica-file-mentions` 里（桌面端输入框引用同一份，
 * 见该包 README），这里只负责注册 provider、预热门和生命周期。
 */
export default function setup(ctx: PluginContext): void {
  // Prewarm the workspace file list so the first `@` (which otherwise cold
  // starts a full `git ls-files` scan ~1.7s on a large repo) hits the cache
  // instead of blocking the user's first keystroke. Fire-and-forget: never
  // block plugin setup or surface an error to the UI.
  prewarmFileMentions(process.cwd());
  const disposable = ctx.ui?.input?.registerFileMentionProvider((query) => findFileMentions(process.cwd(), query));
  if (disposable) ctx.onDispose(() => disposable.dispose());
}
