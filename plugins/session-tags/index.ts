import { readFileSync } from 'node:fs';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import {
  normalizeSessionAnnotations,
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
  maxTagNameWords,
  normalizeTagStore,
  removeSessionTag,
  renameTagLabel,
  resolveTagColor,
  resolveTagTokens,
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

  const readRawStore = (): unknown => {
    try {
      const raw: unknown = JSON.parse(readFileSync(annotationsPath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('标签文件格式不正确');
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      reportStoreError(error);
      throw error;
    }
  };
  /** 文件里缺的色槽自动补上，同时保留已存在的归属。 */
  const readStore = (): TagStore => normalizeTagStore(readRawStore());

  const writeStore = (store: TagStore) => {
    try {
      writeSessionAnnotations(home, pluginId, store);
      if (storeErrorReported) ctx.health.report({ level: 'ok', message: '标签文件读写已恢复' });
      storeErrorReported = false;
    } catch (error) {
      reportStoreError(error);
      throw error;
    }
  };

  // 首次运行时把 7 个色槽写出来：宿主那边「有 options 才列菜单」，空文件等于界面上没有这个插件。
  const lockStore = () => {
    const release = acquireProcessLock(`${annotationsPath}.lock`);
    if (!release) throw new Error('其他会话正在更新标签，稍后重试。');
    return release;
  };
  try {
    const release = lockStore();
    try {
      const raw = readRawStore();
      const initial = normalizeTagStore(raw);
      if (JSON.stringify(normalizeSessionAnnotations(raw)) !== JSON.stringify(initial)) writeStore(initial);
    } finally {
      release();
    }
  } catch {
    // 保留损坏文件供修复，命令仍注册并准确返回读写错误。
  }

  const currentSessionId = () => session.describe()?.id ?? null;

  /** 打标 / 去标共用：解析用户写下的颜色（id 或名字），再落到当前会话。 */
  const applyToCurrentSession = (tokens: string[], add: boolean): string => {
    const store = readStore();
    const sessionId = currentSessionId();
    if (!sessionId) return '当前没有会话，标签是挂到会话上的，先开一个对话再打标。';
    if (tokens.length === 0) return `用法：/tags ${add ? 'add' : 'remove'} <颜色>`;

    const { colors, unknown } = resolveTagTokens(store, tokens);
    let next = store;
    const applied: string[] = [];
    for (const color of colors) {
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
      let release: (() => void) | undefined;
      try {
        const [verb = 'list', ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (['add', 'remove', 'clear', 'rename'].includes(verb)) release = lockStore();
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
            const store = readStore();
            let color = null;
            let split = 0;
            for (let end = Math.min(rest.length - 1, maxTagNameWords(store)); end > 0; end -= 1) {
              color = resolveTagColor(store, rest.slice(0, end).join(' '));
              if (color) {
                split = end;
                break;
              }
            }
            const name = cleanTagLabel(rest.slice(split).join(' '));
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
            ctx.ui?.showMessage(
              `色槽 ${color} 现在叫「${next.options.find((option) => option.id === color)?.label}」。`,
            );
            return { ok: true };
          }
          default:
            ctx.ui?.showMessage('用法：/tags [list|add <颜色>|remove <颜色>|rename <颜色> <名字>|clear]');
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

  ctx.logger.info('session-tags:ready', { file: annotationsPath, colors: TAG_COLORS.length });
}
