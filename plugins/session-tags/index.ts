import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { TagsTool } from './TagsTool.js';
import { createTagStoreFile } from './storeFile.js';
import {
  TAG_COLORS,
  addSessionTag,
  cleanTagLabel,
  clearSessionTags,
  describeTagStore,
  formatTagList,
  removeSessionTag,
  renameTagLabel,
  resolveTagColor,
  tagsOf,
} from './tags.js';
import { formatSessionTagsSection } from './tagsSection.js';

export { TAG_COLORS, TAG_COLOR_HEX, DEFAULT_TAG_LABELS, normalizeTagStore } from './tags.js';
export type { TagColor, TagStore } from './tags.js';
export { TagsTool, parseTagsInput } from './TagsTool.js';
export { createTagStoreFile } from './storeFile.js';
export { formatSessionTagsSection } from './tagsSection.js';

/**
 * 会话标签：macOS Finder 那种彩色圆点。
 *
 * 产品定位是**跨分区的检索维度**，不是第三种归档方式：侧栏的「一个会话只在一个位置」
 * （Pinned > 分组 > Recent）由宿主守着，标签只挂在会话上，最多 7 个、顺序固定。
 *
 * 这一版（Phase 0）只做数据与文本入口，宿主里还没有渲染点：
 *
 * - 存储：`$MICA_HOME/session-tags.json`（跨会话，所以不能进 `ctx.sessionState`）；
 * - 命令：`/tags` 打标、去标、改名、查看；
 * - 工具：`session_tags`，让模型在当前会话上按用户要求读写；
 * - prompt：把当前会话的标签附在 system prompt 末尾，并明确它不是指令。
 *
 * 桌面侧栏的圆点、右键面板与筛选是下一步：那需要宿主提供一条「插件数据 → 会话行徽标」
 * 的通道，而不是先在宿主里写死一个叫 tags 的概念。
 */
export default function setup(ctx: PluginContext): void {
  if (!ctx.session) throw new Error('session tags requires ctx.session');
  const session = ctx.session;

  const storePath = join(ctx.paths?.config ?? resolveMicaHome(), 'session-tags.json');
  let storeErrorReported = false;
  const file = createTagStoreFile(storePath, (message) => {
    ctx.logger.warn('session-tags:store-error', { message });
    // 用户可见的故障才上报，而且只报一次：读坏文件每轮都会走到这里。
    if (!storeErrorReported) {
      storeErrorReported = true;
      ctx.health.report({ level: 'error', message, hint: `标签文件：${storePath}` });
    }
  });

  const currentSessionId = () => session.describe()?.id ?? null;

  /** 打标 / 去标共用：解析用户写下的颜色（id 或名字），再落到当前会话。 */
  const applyToCurrentSession = (tokens: string[], add: boolean): string => {
    const store = file.read();
    const sessionId = currentSessionId();
    if (!sessionId) return '当前没有会话，标签是挂到会话上的，先开一个对话再打标。';
    if (tokens.length === 0) return `用法：/tags ${add ? 'add' : 'remove'} <颜色>`;

    const unknown: string[] = [];
    let next = store;
    const applied: string[] = [];
    for (const token of tokens) {
      const color = resolveTagColor(store, token);
      // 改名之后旧名字也要能解析，所以用「默认名 + 当前名」两种写法（见 resolveTagColor）。
      if (!color) {
        unknown.push(token);
        continue;
      }
      const before = next;
      next = add ? addSessionTag(next, sessionId, color) : removeSessionTag(next, sessionId, color);
      if (next !== before) applied.push(store.labels[color]);
    }

    if (next !== store) file.write(next);
    const lines: string[] = [];
    if (applied.length > 0) lines.push(`${add ? '已打标' : '已移除'}：${applied.join('、')}`);
    if (unknown.length > 0) {
      lines.push(`无法识别的颜色：${unknown.join('、')}（可用：${TAG_COLORS.join(' / ')}，或它们当前的名字）`);
    }
    lines.push(`当前会话：${formatTagList(next, tagsOf(next, sessionId))}`);
    return lines.join('\n');
  };

  const tool = new TagsTool({
    readStore: () => file.read(),
    writeStore: (store) => file.write(store),
    sessionId: currentSessionId,
  });
  const toolRegistration = ctx.tools?.register(tool, { icon: '🏷️' });
  if (toolRegistration) ctx.onDispose(() => toolRegistration.dispose());

  const section = ctx.prompt?.section({
    id: 'session-tags',
    // 排在 notes（1000）之前：标签比笔记稳定，变化频率低，靠前才不会连带失效。
    order: 900,
    render: () => formatSessionTagsSection(file.read(), tagsOf(file.read(), currentSessionId())),
  });
  if (section) ctx.onDispose(() => section.dispose());

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
    pluginId: ctx.pluginId,
    handler: (_commandCtx, args) => {
      const [verb = 'list', ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch (verb) {
        case 'list':
          ctx.ui?.showMessage(describeTagStore(file.read(), currentSessionId()).join('\n'), 8000);
          return { ok: true };
        case 'add':
        case 'remove':
          ctx.ui?.showMessage(applyToCurrentSession(rest, verb === 'add'), 8000);
          return { ok: true };
        case 'clear': {
          const store = file.read();
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
          file.write(next);
          ctx.ui?.showMessage('已清空当前会话的标签。');
          return { ok: true };
        }
        case 'rename': {
          const [token, ...nameParts] = rest;
          const store = file.read();
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
          if (next !== store) file.write(next);
          ctx.ui?.showMessage(`色槽 ${color} 现在叫「${next.labels[color]}」。`);
          return { ok: true };
        }
        default:
          ctx.ui?.showMessage('用法：/tags [list|add <颜色>|remove <颜色>|rename <颜色> <名字>|clear]');
          return { ok: true };
      }
    },
  });
  ctx.onDispose(() => command.dispose());

  ctx.logger.info('session-tags:ready', { storePath, colors: TAG_COLORS.length });
}
