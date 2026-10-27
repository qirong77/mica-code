import { resolveMicaHome } from '@packages/mica-config/brand.js';
import {
  normalizeSessionAnnotations,
  readSessionAnnotations,
  sessionAnnotationsPath,
  writeSessionAnnotations,
} from '@packages/mica-plugin/sessionAnnotations.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import {
  TAG_COLORS,
  addSessionTag,
  cleanTagLabel,
  clearSessionTags,
  describeTagStore,
  formatTagList,
  normalizeTagStore,
  removeSessionTag,
  renameTagLabel,
  resolveTagColor,
  tagsOf,
  type TagStore,
} from './tags.js';

export { TAG_COLORS, TAG_COLOR_HEX, DEFAULT_TAG_LABELS, normalizeTagStore } from './tags.js';
export type { TagColor, TagStore } from './tags.js';

/**
 * 会话标签：macOS Finder 那种彩色圆点。
 *
 * 产品定位是**跨分区的检索维度**，不是第三种归档方式：侧栏的「一个会话只在一个位置」
 * （Pinned > 分组 > Recent）由宿主守着，标签只挂在会话上，最多 7 个、顺序固定。
 *
 * 落盘走插件系统的**通用会话行标记格式**（`plugin-data/session-tags/session-annotations.json`），
 * 因此宿主不需要写死「标签」这个概念：它只按 options 的颜色在会话行画点、按 options 的名字
 * 生成右键菜单项。插件这边只提供两样东西：
 *
 * - 数据：色槽（options）与归属（assignments），7 个槽固定、可改名；
 * - 命令：`/tags` 在 CLI / TUI 里打标、去标、改名；桌面端走右键菜单；
 *
 * **不给模型任何入口**：标签是用户自己的分类习惯，既不该由模型改，也不需要它知道。
 * 所以这里不注册 tool、也不往 system prompt 里塞东西——那两样都会让模型觉得
 * 「帮忙整理标签」是它该干的事，而它并不了解用户为什么这么分。
 */
export default function setup(ctx: PluginContext): void {
  if (!ctx.session) throw new Error('session tags requires ctx.session');
  const session = ctx.session;

  const home = ctx.paths?.config ?? resolveMicaHome();
  const pluginId = ctx.pluginId;
  const annotationsPath = sessionAnnotationsPath(home, pluginId);

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

  /** 读：文件里缺的色槽自动补上（7 个槽是产品契约，不能被一次手改抹掉）。 */
  const readStore = (): TagStore => {
    try {
      return normalizeTagStore(readSessionAnnotations(home, pluginId));
    } catch (error) {
      reportStoreError(error);
      return normalizeTagStore(undefined);
    }
  };

  const writeStore = (store: TagStore) => {
    try {
      writeSessionAnnotations(home, pluginId, store);
      storeErrorReported = false;
    } catch (error) {
      reportStoreError(error);
    }
  };

  // 首次运行时把 7 个色槽写出来：宿主那边「有 options 才列菜单」，空文件等于界面上没有这个插件。
  if (normalizeSessionAnnotations(readSessionAnnotations(home, pluginId)).options.length === 0) {
    writeStore(normalizeTagStore(undefined));
  }

  const currentSessionId = () => session.describe()?.id ?? null;

  /** 打标 / 去标共用：解析用户写下的颜色（id 或名字），再落到当前会话。 */
  const applyToCurrentSession = (tokens: string[], add: boolean): string => {
    const store = readStore();
    const sessionId = currentSessionId();
    if (!sessionId) return '当前没有会话，标签是挂到会话上的，先开一个对话再打标。';
    if (tokens.length === 0) return `用法：/tags ${add ? 'add' : 'remove'} <颜色>`;

    const unknown: string[] = [];
    let next = store;
    const applied: string[] = [];
    for (const token of tokens) {
      const color = resolveTagColor(store, token);
      if (!color) {
        unknown.push(token);
        continue;
      }
      const before = next;
      next = add ? addSessionTag(next, sessionId, color) : removeSessionTag(next, sessionId, color);
      if (next !== before) applied.push(store.options.find((option) => option.id === color)?.label ?? color);
    }

    if (next !== store) writeStore(next);
    const lines: string[] = [];
    if (applied.length > 0) lines.push(`${add ? '已打标' : '已移除'}：${applied.join('、')}`);
    if (unknown.length > 0) {
      lines.push(`无法识别的颜色：${unknown.join('、')}（可用：${TAG_COLORS.join(' / ')}，或它们当前的名字）`);
    }
    lines.push(`当前会话：${formatTagList(next, tagsOf(next, sessionId))}`);
    return lines.join('\n');
  };

  const command = ctx.commands.register({
    name: 'tags',
    description: '给当前会话打标签（7 个固定色槽，照 macOS 彩色圆点）',
    completionItems: [
      { arg: 'list', description: '列出 7 个色槽与当前会话的标签' },
      { arg: 'add', description: 'add <颜色>：打标，可跟多个颜色' },
      { arg: 'remove', description: 'remove <颜色>：去标' },
      { arg: 'rename', description: 'rename <颜色> <新名字>：改色槽名字' },
      { arg: 'clear', description: '清空当前会话的标签' },
    ],
    scope: 'local-only',
    allowDuringTurn: false,
    pluginId,
    handler: (_commandCtx, args) => {
      const [verb = 'list', ...rest] = args.trim().split(/\s+/).filter(Boolean);
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
          writeStore(next);
          ctx.ui?.showMessage('已清空当前会话的标签。');
          return { ok: true };
        }
        case 'rename': {
          const [token, ...nameParts] = rest;
          const store = readStore();
          const color = token ? resolveTagColor(store, token) : null;
          const name = cleanTagLabel(nameParts.join(' '));
          if (!color) {
            ctx.ui?.showMessage(`用法：/tags rename <颜色> <新名字>（可用：${TAG_COLORS.join(' / ')}）`);
            return { ok: true };
          }
          if (!name) {
            ctx.ui?.showMessage('新名字不能为空。');
            return { ok: true };
          }
          const next = renameTagLabel(store, color, name);
          if (next !== store) writeStore(next);
          ctx.ui?.showMessage(`色槽 ${color} 现在叫「${next.options.find((option) => option.id === color)?.label}」。`);
          return { ok: true };
        }
        default:
          ctx.ui?.showMessage('用法：/tags [list|add <颜色>|remove <颜色>|rename <颜色> <名字>|clear]');
          return { ok: true };
      }
    },
  });
  ctx.onDispose(() => command.dispose());

  ctx.logger.info('session-tags:ready', { file: annotationsPath, colors: TAG_COLORS.length });
}
