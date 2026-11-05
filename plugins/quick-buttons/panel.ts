import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type {
  PluginPanelActionResult,
  PluginPanelDialog,
  PluginPanelField,
  PluginPanelHandler,
  PluginPanelItem,
  PluginPanelView,
} from '@packages/mica-plugin/index.js';
import { openInControlledBrowser, type FetchLike } from './browser.js';
import {
  QUICK_BUTTON_KINDS,
  QUICK_BUTTON_KIND_LABELS,
  QUICK_BUTTON_LIMIT,
  buttonSummary,
  isStaleQuickButton,
  removeQuickButton,
  upsertQuickButton,
  type QuickButton,
  type QuickDialog,
} from './buttons.js';

/**
 * 会话右侧的那块面板（清单 `desktop.panel`，按钮由视图现给）。
 *
 * 两件事：
 *
 * - **按钮本身**由视图的 `shortcuts` 交给宿主，画在输入框上方。点一下回到这里的 `run`，
 *   按 id 找到那枚按钮，再把「要发生什么」翻译成宿主的动作回包（`openExternal` /
 *   `compose` / `newSession` / `openPath`）——插件不碰页面，只声明意图。
 * - **面板**是这批按钮的维护界面：看一眼现在有哪几个、删掉一个、手动加一个（不是每件事
 *   都值得开口让模型做）。
 *
 * `view()` 会被反复调用（宿主每 30 秒、每次动作后、工具跑完时），所以它只读会话里的那份
 * 状态、不碰网络；真正发请求的只有点击。
 */

export type PanelDeps = {
  read(): QuickButton[];
  write(buttons: QuickButton[]): void;
  /** 会话工作目录：手动添加时把相对路径补成绝对路径。 */
  cwd(): string | undefined;
  /** 打开受控浏览器用；测试里换掉。 */
  openBrowser?: typeof openInControlledBrowser;
  fetchImpl?: FetchLike;
  /** 当前会话的归属（`MICA_BROWSER_OWNER` 的兜底来源）。 */
  owner?: string;
};

export const RUN_ACTION = 'run';
/** 弹窗底部的按钮（`dialog.actions`）。 */
export const DIALOG_ACTION = 'dialog';
export const ADD_ACTION = 'add';
export const REMOVE_ACTION = 'remove';
export const CLEAR_ACTION = 'clear';
export const CLEAR_STALE_ACTION = 'clear-stale';

function buttonKey(button: QuickButton): string {
  const fingerprint = createHash('sha256').update(JSON.stringify(button)).digest('base64url').slice(0, 20);
  return `${button.id}:${fingerprint}`;
}

export function createPanelHandler(deps: PanelDeps): PluginPanelHandler {
  return {
    view(): PluginPanelView {
      const buttons = deps.read();
      const staleCount = buttons.filter((button) => isStaleQuickButton(button)).length;
      return {
        title: '快捷按钮',
        subtitle: buttons.length > 0 ? `${buttons.length} 个按钮 · 只在当前会话显示` : '还没建按钮 · 只在当前会话显示',
        // key 包含内容指纹，旧界面不能触发同 id 的新内容。
        shortcuts: buttons.map((button) => ({
          id: button.id,
          label: button.label,
          action: RUN_ACTION,
          key: buttonKey(button),
          ...(button.style ? { style: button.style } : {}),
        })),
        shortcutStates: Object.fromEntries(
          buttons.filter((button) => isStaleQuickButton(button)).map((button) => [button.id, { badge: '可能过时' }]),
        ),
        sections: [
          {
            title: '按钮',
            subtitle:
              staleCount > 0
                ? `${staleCount} 个可能过时 · 最多 ${QUICK_BUTTON_LIMIT} 个`
                : `最多 ${QUICK_BUTTON_LIMIT} 个`,
            items: buttons.map(itemOf),
            ...(buttons.length > 0
              ? {
                  actions: [
                    ...(staleCount > 0
                      ? [
                          {
                            id: CLEAR_STALE_ACTION,
                            label: '清理可能过时',
                            icon: 'trash' as const,
                            tone: 'ghost' as const,
                          },
                        ]
                      : []),
                    {
                      id: CLEAR_ACTION,
                      label: '清空',
                      icon: 'trash' as const,
                      tone: 'danger' as const,
                    },
                  ],
                }
              : {}),
            empty: '让模型建一个（「把这个页面放到输入框上方」），或者在下面手动加。',
          },
          {
            title: '添加',
            subtitle: '填一个，加一个',
            fields: addFields(deps.cwd()),
          },
        ],
      };
    },

    async action(input): Promise<PluginPanelActionResult> {
      switch (input.action) {
        case RUN_ACTION:
          return runButton(deps, String(input.key || ''));
        case DIALOG_ACTION:
          return runDialogAction(deps, String(input.key || ''));
        case ADD_ACTION:
          return addButton(deps, input.values || {});
        case REMOVE_ACTION:
          return removeButton(deps, String(input.key || ''));
        case CLEAR_STALE_ACTION: {
          const buttons = deps.read();
          const now = Date.now();
          const next = buttons.filter((button) => !isStaleQuickButton(button, now));
          const count = buttons.length - next.length;
          if (count > 0) deps.write(next);
          return { message: `已清理 ${count} 个可能过时的模型按钮` };
        }
        case CLEAR_ACTION: {
          const count = deps.read().length;
          if (count > 0) deps.write([]);
          return { message: count > 0 ? `已清空 ${count} 个按钮` : '本来就没有按钮' };
        }
        default:
          return { message: `不认识的动作：${input.action}` };
      }
    },
  };
}

/** 点了一枚按钮：按种类翻译成宿主的动作回包。 */
async function runButton(deps: PanelDeps, key: string): Promise<PluginPanelActionResult> {
  const id = key.split(':')[0];
  const button = deps.read().find((entry) => entry.id === id);
  if (!button) return { message: '这个按钮已经删掉了' };
  if (buttonKey(button) !== key) return { message: '按钮内容已更新，请重新打开' };
  // 弹窗不在这条链上：它交给宿主画，弹窗里的按钮再以 `DIALOG_ACTION` 回来。
  if (button.kind === 'dialog') {
    return button.dialog ? { dialog: toPanelDialog(button.dialog, key) } : { message: '这个弹窗没有内容' };
  }
  // 走到这里的按钮一定不是 `dialog`（上面已经返回），窄化一下让类型跟上。
  return runEffect(deps, button as EffectPayload, button.label);
}

/**
 * 四种落点共用的一份执行：主按钮与弹窗里的按钮都走这里。
 *
 * `payload` 只要有那几个字段就够（`QuickButton` 与 `QuickDialogAction` 都是它的子集），
 * 所以新增一种「点一下做什么」只需要改这一处与各自的校验。
 */
async function runEffect(deps: PanelDeps, payload: EffectPayload, label: string): Promise<PluginPanelActionResult> {
  switch (payload.kind) {
    case 'open': {
      if (payload.target === 'external') return { openExternal: payload.url };
      const open = deps.openBrowser ?? openInControlledBrowser;
      const result = await open({
        url: payload.url || '',
        label,
        owner: deps.owner,
        fetchImpl: deps.fetchImpl,
      });
      if (result.ok) return { message: '已在受控浏览器打开' };
      // 受控浏览器不可用（CLI / 还没起来）时退回系统浏览器：用户点的是「打开这个页面」，
      // 用什么打开是次要的；只在旁边说明一句。
      return { openExternal: payload.url, message: `受控浏览器打不开，已交给系统浏览器：${result.error}` };
    }
    case 'compose':
      return { compose: payload.text || '', message: '已放进输入框，按回车发送' };
    case 'session':
      return {
        newSession: {
          prompt: payload.text || '',
          ...(payload.role ? { role: payload.role } : {}),
        },
      };
    case 'path':
      return { openPath: { path: payload.path || '' } };
  }
}

/** `runEffect` 认的那几个字段：`QuickButton` 与 `QuickDialogAction` 都满足。 */
type EffectPayload = {
  kind: 'open' | 'compose' | 'session' | 'path';
  url?: string;
  target?: 'browser' | 'external';
  text?: string;
  role?: string;
  path?: string;
};

/**
 * 弹窗动作同时校验显示时的按钮内容和动作坐标。
 */
async function runDialogAction(deps: PanelDeps, key: string): Promise<PluginPanelActionResult> {
  const [buttonId, fingerprint, indexText, extra] = key.split(':');
  const button = deps.read().find((entry) => entry.id === buttonId);
  if (!button) return { message: '这个按钮已经删掉了' };
  if (extra !== undefined || buttonKey(button) !== `${buttonId}:${fingerprint}`) {
    return { message: '弹窗内容已更新，请重新打开' };
  }
  const action =
    /^[0-2]$/.test(indexText || '') && button.kind === 'dialog'
      ? button.dialog?.actions?.[Number(indexText)]
      : undefined;
  if (!action) return { message: '这个做法已经不在弹窗里了' };
  return runEffect(deps, action, action.label);
}

/**
 * 把插件自己的弹窗声明翻成宿主那份 `PluginPanelDialog`。
 *
 * 两边字段名不同是有意的：宿主那份是「屏幕上的块」（列 / 格子 / 底部按钮），插件这份是
 * 「模型写的内容」（清单 / 做法）。翻译放在这里，页面只认识宿主那一份——插件因此不需要
 * 自带任何组件，弹窗仍是宿主那套 ModalShell / 表格 / 按钮。
 */
export function toPanelDialog(dialog: QuickDialog, key: string): PluginPanelDialog {
  const items = dialog.items || [];
  const actions = dialog.actions || [];
  return {
    title: dialog.title,
    ...(dialog.subtitle ? { subtitle: dialog.subtitle } : {}),
    ...(dialog.text ? { text: dialog.text } : {}),
    ...(dialog.markdown ? { markdown: dialog.markdown } : {}),
    // 清单统一是「名称 / 内容」两列：模型不用拼表头，宿主仍用自己那张表（对齐、省略、
    // 链接交给系统浏览器都在页面那边）。
    ...(items.length > 0
      ? {
          columns: ['名称', '内容'],
          rows: items.map((item) => [
            { text: item.label },
            { text: item.value || item.url || '', ...(item.url ? { link: item.url } : {}) },
          ]),
        }
      : {}),
    ...(dialog.note ? { note: dialog.note } : {}),
    ...(actions.length > 0
      ? {
          actions: actions.map((action, index) => ({
            id: DIALOG_ACTION,
            key: `${key}:${index}`,
            label: action.label,
            ...(action.tone ? { tone: action.tone } : {}),
          })),
        }
      : {}),
  };
}

/** 面板里手动加一个：三个字段就是一枚按钮的全部（kind 决定 value 的意思）。 */
function addButton(deps: PanelDeps, values: Record<string, string>): PluginPanelActionResult {
  const label = String(values.label || '').trim();
  const kind = String(values.kind || '').trim();
  const value = String(values.value || '').trim();
  if (!label) return { message: '先给按钮起个名字', keepDrafts: true };
  if (!value) return { message: '填上要打开的内容', keepDrafts: true };

  const input =
    kind === 'open'
      ? { label, kind, url: value }
      : kind === 'path'
        ? { label, kind, path: absolutePath(value, deps.cwd()) }
        : { label, kind, text: value };
  try {
    const next = upsertQuickButton(deps.read(), input).buttons;
    deps.write(next);
    // 表单在动作之后会按新视图归位：这正是「填一个，加一个」想要的效果。
    return { message: `已添加「${label}」` };
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error), keepDrafts: true };
  }
}

function removeButton(deps: PanelDeps, id: string): PluginPanelActionResult {
  const before = deps.read();
  const next = removeQuickButton(before, id);
  if (next.length === before.length) return { message: '这个按钮已经删掉了' };
  deps.write(next);
  return { message: '已删除' };
}

function itemOf(button: QuickButton): PluginPanelItem {
  return {
    key: button.id,
    label: button.label,
    value: `${buttonSummary(button)}${isStaleQuickButton(button) ? ' · 可能过时' : ''}`,
    actions: [{ id: REMOVE_ACTION, label: '删除', icon: 'trash', tone: 'ghost' }],
  };
}

function addFields(cwd: string | undefined): PluginPanelField[] {
  return [
    {
      key: 'label',
      label: '名称',
      placeholder: '按钮上的字（最多 12 个）',
      value: '',
    },
    {
      key: 'kind',
      label: '点一下',
      type: 'select',
      value: 'open',
      options: QUICK_BUTTON_KINDS.filter((kind) => kind !== 'dialog').map((kind) => ({
        value: kind,
        label: QUICK_BUTTON_KIND_LABELS[kind],
      })),
    },
    {
      key: 'value',
      label: '内容',
      placeholder: '网址 / 一句话 / 提示词 / 文件路径',
      hint: cwd ? `相对路径按 ${cwd} 补全` : undefined,
      value: '',
      action: { id: ADD_ACTION, label: '添加', icon: 'add', tone: 'primary' },
    },
  ];
}

/** 手动填的路径补成绝对路径：宿主的 `openPath` 只认绝对路径。 */
export function absolutePath(value: string, cwd: string | undefined): string {
  const text = value.trim();
  if (!text) return text;
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return resolve(homedir(), text.slice(2));
  if (isAbsolute(text)) return text;
  return resolve(cwd || process.cwd(), text);
}
