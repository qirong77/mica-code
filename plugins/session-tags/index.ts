import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import {
  addSessionTag,
  clearSessionTags,
  describeTagStore,
  formatTagList,
  normalizeTagStore,
  removeSessionTag,
  resolveTagTokens,
  tagsOf,
  type TagStore,
} from './model.js';
import { annotationsFile, readRawStore, resolveStore, writeStore } from './store.js';

export { TAG_PALETTE, MAX_TAGS, MAX_TAG_LABEL_LENGTH, normalizeTagStore } from './model.js';
export type { TagOption, TagStore } from './model.js';

/**
 * 会话标签：一份用户自己定义的标签表（名字 + 颜色），挂在会话上。
 *
 * 落盘走插件系统的**通用会话行标记格式**（`plugin-data/session-tags/session-annotations.json`），
 * 因此宿主不需要写死「标签」这个概念：它只按 options 的颜色在会话行画点、按 options 的
 * 名字生成右键菜单项。插件这边只提供两样东西：
 *
 * - 数据：标签表（options）与归属（assignments）；
 * - 命令：`/tags` 在 CLI / TUI 里给当前会话打标、去标。桌面端走会话行右键菜单；
 *
 * **标签本身的维护（新增、改名、换色、删除）只在桌面端的 Tags 页面里做**
 * （`desktop.jsx`，通过 `ctx` 之外的前端 api 写同一份文件）。命令只管打标，所以
 * CLI / TUI 里不会长出一套「怎么定义标签」的语法，也不会出现两边规则不一致。
 *
 * **不给模型任何入口**：标签是用户自己的分类习惯，既不该由模型改，也不需要它知道。
 * 所以这里不注册 tool、也不往 system prompt 里塞东西。
 */
export default function setup(ctx: PluginContext): void {
  if (!ctx.session) throw new Error('session tags requires ctx.session');
  const session = ctx.session;

  const home = ctx.paths?.config ?? resolveMicaHome();
  const pluginId = ctx.pluginId;
  const annotationsPath = annotationsFile(home, pluginId);

  let storeErrorReported = false;
  const reportStoreError = (error: unknown) => {
    const message = `标签文件读写失败：${error instanceof Error ? error.message : String(error)}`;
    ctx.logger.warn('session-tags:store-error', { message, file: annotationsPath });
    // 用户可见的故障才上报，而且只报一次：每轮都会走到这里。
    if (!storeErrorReported) {
      storeErrorReported = true;
      ctx.health.report({ level: 'error', message, hint: `标签文件：${annotationsPath}` });
    }
  };

  const readStore = (): TagStore => {
    try {
      return normalizeTagStore(readRawStore(annotationsPath));
    } catch (error) {
      reportStoreError(error);
      throw error;
    }
  };

  const write = (store: TagStore) => {
    try {
      writeStore(home, pluginId, store);
      if (storeErrorReported) ctx.health.report({ level: 'ok', message: '标签文件读写已恢复' });
      storeErrorReported = false;
    } catch (error) {
      reportStoreError(error);
      throw error;
    }
  };

  // 首次运行时把「待 review」写出来：宿主那边「有 options 才列菜单」，空文件等于界面上
  // 没有这个插件。已有文件（哪怕标签被删空）一律不动，只做归一化收敛。
  const lockStore = () => {
    const release = acquireProcessLock(`${annotationsPath}.lock`);
    if (!release) throw new Error('其他会话正在更新标签，稍后重试。');
    return release;
  };
  try {
    const release = lockStore();
    try {
      const { store, dirty } = resolveStore(readRawStore(annotationsPath));
      if (dirty) write(store);
    } finally {
      release();
    }
  } catch {
    // 保留损坏文件供修复，命令仍注册并准确返回读写错误。
  }

  const currentSessionId = () => session.describe()?.id ?? null;

  /** 打标 / 去标共用：按名字（或 id）解析用户写下的词，再落到当前会话。 */
  const applyToCurrentSession = (tokens: string[], add: boolean): string => {
    const store = readStore();
    const sessionId = currentSessionId();
    if (!sessionId) return '当前没有会话，标签是挂到会话上的，先开一个对话再打标。';
    if (tokens.length === 0) return `用法：/tags ${add ? 'add' : 'remove'} <标签名>`;

    const { tags, unknown } = resolveTagTokens(store, tokens);
    let next = store;
    const applied: string[] = [];
    for (const tag of tags) {
      const before = next;
      next = add ? addSessionTag(next, sessionId, tag.id) : removeSessionTag(next, sessionId, tag.id);
      if (next !== before) applied.push(tag.label);
    }

    if (next !== store) write(next);
    const lines: string[] = [];
    if (applied.length > 0) lines.push(`${add ? '已打标' : '已移除'}：${applied.join('、')}`);
    if (unknown.length > 0) {
      const available = store.options.map((option) => option.label).join(' / ') || '（还没有标签）';
      lines.push(`认不出的标签：${unknown.join('、')}（现有：${available}）`);
    }
    lines.push(`当前会话：${formatTagList(next, tagsOf(next, sessionId))}`);
    return lines.join('\n');
  };

  const command = ctx.commands.register({
    name: 'tags',
    description: '给当前会话打标签（标签在桌面端 Tags 页面里定义）',
    completionItems: [
      { arg: 'list', description: '列出所有标签与当前会话的标签' },
      { arg: 'add', description: 'add <标签名>：打标，可跟多个' },
      { arg: 'remove', description: 'remove <标签名>：去标' },
      { arg: 'clear', description: '清空当前会话的标签' },
    ],
    scope: 'local-only',
    allowDuringTurn: false,
    pluginId,
    handler: (_commandCtx, args) => {
      let release: (() => void) | undefined;
      try {
        const [verb = 'list', ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (['add', 'remove', 'clear'].includes(verb)) release = lockStore();
        switch (verb) {
          case 'list':
            ctx.ui?.showMessage(describeTagStore(readStore(), currentSessionId()).join('\n'), 8000);
            return { ok: true };
          case 'add':
          case 'remove':
            ctx.ui?.showMessage(applyToCurrentSession(rest, verb === 'add'), 8000);
            return { ok: true };
          case 'clear': {
            const store = readStore();
            const sessionId = currentSessionId();
            if (!sessionId) {
              ctx.ui?.showMessage('当前没有会话。');
              return { ok: true };
            }
            const next = clearSessionTags(store, sessionId);
            if (next === store) {
              ctx.ui?.showMessage('当前会话本来就没有标签。');
              return { ok: true };
            }
            write(next);
            ctx.ui?.showMessage('已清空当前会话的标签。');
            return { ok: true };
          }
          default:
            ctx.ui?.showMessage('用法：/tags [list|add <标签名>|remove <标签名>|clear]');
            return { ok: true };
        }
      } catch (error) {
        const message = `标签操作失败：${error instanceof Error ? error.message : String(error)}`;
        ctx.ui?.showMessage(message, 8000);
        return { ok: false, error, message };
      } finally {
        release?.();
      }
    },
  });
  ctx.onDispose(() => command.dispose());

  ctx.logger.info('session-tags:ready', { file: annotationsPath });
}
