/**
 * 快捷按钮的数据：会话里的一排「点一下就走」的入口。
 *
 * 存在会话快照的 `pluginState['quick-buttons']` 里（`ctx.sessionState`），所以它跟着这条
 * 对话走：切到别的会话看不到这一排，resume / fork 带得回来，压缩改不到它。
 *
 * 为什么是会话级而不是项目级：按钮回答的是「这一轮要做什么」——刚查到的那个页面、刚写好
 * 的那段话、刚发现的那份文件。挂在一个项目上，一周之后就是一堆没人敢删的垃圾入口。
 */

export const QUICK_BUTTONS_STATE_VERSION = 1;

/**
 * 一排按钮的上限。
 *
 * 输入框上方的位置是有限的：按钮再多，用户就得先读一排字才能找到要点的那一个，比自己去
 * 做还慢。超出的部分由插件拒绝，让模型自己挑最常用的那几个。
 */
export const QUICK_BUTTON_LIMIT = 6;
export const QUICK_BUTTON_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export const QUICK_BUTTON_LABEL_MAX = 12;
export const QUICK_BUTTON_HINT_MAX = 60;
export const QUICK_BUTTON_TEXT_MAX = 4000;
export const QUICK_BUTTON_URL_MAX = 2000;
export const QUICK_BUTTON_PATH_MAX = 1024;
/** 弹窗正文：一段说明不该比一把按钮的提示还长，超出的截断（弹窗是用来读的）。 */
export const QUICK_DIALOG_TEXT_MAX = 2000;
export const QUICK_DIALOG_MARKDOWN_MAX = 8000;
export const QUICK_DIALOG_ITEMS_MAX = 12;
export const QUICK_DIALOG_ACTIONS_MAX = 3;
export const QUICK_PREVIEW_TITLE_MAX = 60;
export const QUICK_PREVIEW_SUBTITLE_MAX = 120;
export const QUICK_PREVIEW_TEXT_MAX = 1200;
export const QUICK_PREVIEW_MARKDOWN_MAX = 4000;
export const QUICK_PREVIEW_NOTE_MAX = 240;

/**
 * 点了之后会发生什么。
 *
 * 前四个是「一下就走」的落点；`dialog` 是「先看一眼再决定」——宿主弹出一个由这里声明内容的
 * 弹窗（正文 / 列表 / 弹窗内按钮），适合「这一轮查到的几条候选」「一段结论 + 两个可选做法」。
 * 一排按钮里最多一两颗弹窗按钮：其余动作应该能一下做完。
 */
export const QUICK_BUTTON_KINDS = ['open', 'compose', 'session', 'path', 'dialog'] as const;

export type QuickButtonKind = (typeof QUICK_BUTTON_KINDS)[number];

export const QUICK_BUTTON_KIND_LABELS: Record<QuickButtonKind, string> = {
  open: '打开网页',
  compose: '放进输入框',
  session: '开新会话',
  path: '打开文件',
  dialog: '弹窗',
};

/** `open` 在哪里打开：受控浏览器（默认，能在里面继续操作）或系统浏览器。 */
export const QUICK_BUTTON_TARGETS = ['browser', 'external'] as const;

export type QuickButtonTarget = (typeof QUICK_BUTTON_TARGETS)[number];

export type QuickButton = {
  /** 会话内唯一，同时是页面上的 key 与点击时回传的 `key`。 */
  id: string;
  label: string;
  kind: QuickButtonKind;
  /** `open`：要打开的地址（只认 http / https）。 */
  url?: string;
  /** `open`：在受控浏览器里开（默认）还是交给系统浏览器。 */
  target?: QuickButtonTarget;
  /** `compose`：点一下放进输入框的一段话；`session`：新会话的第一句话。 */
  text?: string;
  /** `session`：新会话用的角色名。 */
  role?: string;
  /** `path`：要在应用里打开的文件或目录（绝对路径）。 */
  path?: string;
  /** `dialog`：点开后那个弹窗的内容（宿主用已有组件画，插件只给数据）。 */
  dialog?: QuickDialog;
  /** 悬停时显示的轻量预览；动作由插件按按钮自身内容生成。 */
  preview?: QuickButtonPreview;
  /** 外观规格：图标 / 强调色 / 形状 / 纯图标。宿主用自己的主题令牌画。 */
  style?: QuickButtonStyle;
  /** 悬停时的一句话解释。 */
  hint?: string;
  source?: 'model';
  createdAt?: number;
  updatedAt?: number;
};

export function isStaleQuickButton(button: QuickButton, now = Date.now()): boolean {
  return button.source === 'model' && isTimestamp(button.updatedAt) && now - button.updatedAt > QUICK_BUTTON_STALE_MS;
}

/**
 * 外观规格：**不写样式，只说意图**。
 *
 * 暗色与亮色是两套色值（`--color-accent` 两边不同），插件写死颜色总有一边读不清；而
 * 「打开」「危险」「只画图标」这些意图本来就该由宿主翻译成它自己的视觉语言。
 */
export type QuickButtonStyle = {
  /** 图标名，取自宿主那张 lucide 表（`globe` / `external` / `search` / `sparkles` / `zap` …）。 */
  icon?: string;
  /** 强调色；不写就是普通描边胶囊。 */
  color?: QuickButtonColor;
  /** 形状：`pill`（默认）/ `soft`（无边框）/ `plain`（纯文字）。 */
  shape?: QuickButtonShape;
  /** 只画图标（`label` 退成悬停提示与无障碍名）。 */
  iconOnly?: boolean;
};

export const QUICK_BUTTON_COLORS = ['accent', 'danger', 'success', 'warn'] as const;
export type QuickButtonColor = (typeof QUICK_BUTTON_COLORS)[number];

export const QUICK_BUTTON_SHAPES = ['pill', 'soft', 'plain'] as const;
export type QuickButtonShape = (typeof QUICK_BUTTON_SHAPES)[number];

/**
 * 一个弹窗：一段说明 + 一份清单 + 几个做法，全部由模型声明、宿主用已有组件画。
 *
 * 每个字段都对应宿主那套现有控件（标题 / 副标题 / Markdown 正文 / 两列表格 / 底部按钮），
 * 所以插件不需要（也无法）自带组件：这里只是「用哪些块、按什么顺序」。
 */
export type QuickDialog = {
  title: string;
  subtitle?: string;
  /** 正文：一段纯文本（换行分段）。与 `markdown` 二选一。 */
  text?: string;
  /** 正文：一段 Markdown（结论、清单），宿主用对话区那套排版渲染。 */
  markdown?: string;
  /** 一份清单：每项是「名称 + 内容（+ 可点的地址）」，宿主画成两列表格。 */
  items?: QuickDialogItem[];
  /** 表格或正文下面的一句说明。 */
  note?: string;
  /** 底部按钮（最多 3 颗）：每颗点了就执行它自己的那件事。 */
  actions?: QuickDialogAction[];
};

export type QuickButtonPreview = {
  title: string;
  subtitle?: string;
  text?: string;
  markdown?: string;
  note?: string;
};

export type QuickDialogItem = {
  label: string;
  value?: string;
  /** 这一项的地址：表格里那一格可点，点了交给系统浏览器。 */
  url?: string;
};

/** 弹窗底部的一颗按钮：`kind` 与按钮本身那几种落点一致（不开弹窗，避免套娃）。 */
export type QuickDialogAction = {
  label: string;
  kind: Exclude<QuickButtonKind, 'dialog'>;
  url?: string;
  target?: QuickButtonTarget;
  text?: string;
  role?: string;
  path?: string;
  tone?: 'primary' | 'danger';
};

export type QuickButtonsState = {
  version: number;
  buttons: QuickButton[];
};

export function isQuickButtonKind(value: unknown): value is QuickButtonKind {
  return typeof value === 'string' && (QUICK_BUTTON_KINDS as readonly string[]).includes(value);
}

export function isQuickButtonTarget(value: unknown): value is QuickButtonTarget {
  return typeof value === 'string' && (QUICK_BUTTON_TARGETS as readonly string[]).includes(value);
}

export function isQuickButtonColor(value: unknown): value is QuickButtonColor {
  return typeof value === 'string' && (QUICK_BUTTON_COLORS as readonly string[]).includes(value);
}

export function isQuickButtonShape(value: unknown): value is QuickButtonShape {
  return typeof value === 'string' && (QUICK_BUTTON_SHAPES as readonly string[]).includes(value);
}

/** id 只认小写 slug：它同时要过宿主快捷按钮的 id 约定（`isValidPluginPanelShortcutId`）。 */
export function isValidQuickButtonId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && /^[a-z0-9][a-z0-9._-]*$/.test(value);
}

/**
 * 读回状态，认不出的部分整条丢掉。
 *
 * 状态文件是插件自己的，但仍然清洗一遍：模型写下的字段经手过一个模型，历史版本可能留下
 * 少一个字段的条目——一条点不动的按钮比没有更糟。
 */
export function normalizeQuickButtonsState(input: unknown): QuickButtonsState {
  const raw = isRecord(input) ? input : {};
  const buttons: QuickButton[] = [];
  const ids = new Set<string>();
  for (const entry of Array.isArray(raw.buttons) ? raw.buttons : []) {
    const button = normalizeQuickButton(entry);
    if (!button || ids.has(button.id)) continue;
    ids.add(button.id);
    buttons.push(button);
    if (buttons.length >= QUICK_BUTTON_LIMIT) break;
  }
  return { version: QUICK_BUTTONS_STATE_VERSION, buttons };
}

export function readQuickButtons(input: unknown): QuickButton[] {
  return normalizeQuickButtonsState(input).buttons;
}

/** 单条校验：形状不对或者「点了什么也不会发生」都返回 null。 */
export function normalizeQuickButton(input: unknown): QuickButton | null {
  const raw = isRecord(input) ? input : {};
  const id = trimTo(raw.id, 40);
  const label = trimTo(raw.label, QUICK_BUTTON_LABEL_MAX);
  const kind = raw.kind;
  if (!isValidQuickButtonId(id) || !label || !isQuickButtonKind(kind)) return null;
  const hint = trimTo(raw.hint, QUICK_BUTTON_HINT_MAX);
  const style = normalizeQuickButtonStyle(raw.style);
  const preview = normalizeQuickButtonPreview(raw.preview);
  const base = {
    id,
    label,
    kind,
    ...(style ? { style } : {}),
    ...(hint ? { hint } : {}),
    ...(preview ? { preview } : {}),
    ...(raw.source === 'model' ? { source: 'model' as const } : {}),
    ...(isTimestamp(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
    ...(isTimestamp(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
  };
  switch (kind) {
    case 'open': {
      const url = trimTo(raw.url, QUICK_BUTTON_URL_MAX);
      if (!isOpenableUrl(url)) return null;
      const target = isQuickButtonTarget(raw.target) ? raw.target : 'browser';
      return { ...base, url, target };
    }
    case 'compose':
    case 'session': {
      const text = trimTo(raw.text, QUICK_BUTTON_TEXT_MAX);
      if (!text) return null;
      if (kind === 'compose') return { ...base, text };
      const role = trimTo(raw.role, 40);
      return { ...base, text, ...(role ? { role } : {}) };
    }
    case 'path': {
      const path = trimTo(raw.path, QUICK_BUTTON_PATH_MAX);
      if (!path) return null;
      return { ...base, path };
    }
    case 'dialog': {
      const dialog = normalizeQuickDialog(raw.dialog);
      if (!dialog) return null;
      return { ...base, dialog };
    }
  }
}

export function normalizeQuickButtonStyle(input: unknown): QuickButtonStyle | undefined {
  if (!isRecord(input)) return undefined;
  const icon = trimTo(input.icon, 40);
  const color = isQuickButtonColor(input.color) ? input.color : undefined;
  const shape = isQuickButtonShape(input.shape) ? input.shape : undefined;
  const iconOnly = input.iconOnly === true;
  if (!icon && !color && !shape && !iconOnly) return undefined;
  return {
    ...(icon ? { icon } : {}),
    ...(color ? { color } : {}),
    ...(shape ? { shape } : {}),
    ...(iconOnly ? { iconOnly } : {}),
  };
}

/**
 * 弹窗内容：标题是硬条件，其余至少要有一样（正文 / 清单 / 按钮），否则它只是一句 message。
 *
 * 清单统一收成两列（名称 / 内容），模型不用去拼表头；宿主那边仍然是它自己的表格组件。
 */
export function normalizeQuickDialog(input: unknown): QuickDialog | undefined {
  if (!isRecord(input)) return undefined;
  const title = trimTo(input.title, 60);
  if (!title) return undefined;
  const subtitle = trimTo(input.subtitle, 120);
  const markdown = trimTo(input.markdown, QUICK_DIALOG_MARKDOWN_MAX);
  // Markdown 与纯文本互斥：同时给时按 Markdown 画（和宿主那边同一条规则）。
  const text = markdown ? '' : trimTo(input.text, QUICK_DIALOG_TEXT_MAX);
  const note = trimTo(input.note, 400);
  const items: QuickDialogItem[] = [];
  for (const entry of Array.isArray(input.items) ? input.items : []) {
    if (!isRecord(entry)) continue;
    const label = trimTo(entry.label, 40);
    if (!label) continue;
    const value = trimTo(entry.value, 200);
    const url = trimTo(entry.url, QUICK_BUTTON_URL_MAX);
    items.push({ label, ...(value ? { value } : {}), ...(isOpenableUrl(url) ? { url } : {}) });
    if (items.length >= QUICK_DIALOG_ITEMS_MAX) break;
  }
  const actions: QuickDialogAction[] = [];
  for (const entry of Array.isArray(input.actions) ? input.actions : []) {
    const action = normalizeQuickDialogAction(entry);
    if (!action) continue;
    actions.push(action);
    if (actions.length >= QUICK_DIALOG_ACTIONS_MAX) break;
  }
  if (!text && !markdown && items.length === 0 && actions.length === 0) return undefined;
  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(text ? { text } : {}),
    ...(markdown ? { markdown } : {}),
    ...(items.length > 0 ? { items } : {}),
    ...(note ? { note } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  };
}

/** 弹窗里的一颗按钮：`kind` 不能再是 `dialog`（弹窗套弹窗只会让人迷路）。 */
function normalizeQuickDialogAction(input: unknown): QuickDialogAction | null {
  if (!isRecord(input)) return null;
  const label = trimTo(input.label, 24);
  const kind = input.kind;
  if (!label || !isQuickButtonKind(kind) || kind === 'dialog') return null;
  const tone = input.tone === 'primary' || input.tone === 'danger' ? input.tone : undefined;
  const base: QuickDialogAction = { label, kind, ...(tone ? { tone } : {}) };
  switch (kind) {
    case 'open': {
      const url = trimTo(input.url, QUICK_BUTTON_URL_MAX);
      if (!isOpenableUrl(url)) return null;
      const target = isQuickButtonTarget(input.target) ? input.target : 'browser';
      return { ...base, url, target };
    }
    case 'compose':
    case 'session': {
      const text = trimTo(input.text, QUICK_BUTTON_TEXT_MAX);
      if (!text) return null;
      if (kind === 'compose') return { ...base, text };
      const role = trimTo(input.role, 40);
      return { ...base, text, ...(role ? { role } : {}) };
    }
    case 'path': {
      const path = trimTo(input.path, QUICK_BUTTON_PATH_MAX);
      if (!path) return null;
      return { ...base, path };
    }
    default:
      return null;
  }
}

/**
 * 新增 / 覆盖一枚按钮（同 id 覆盖）。
 *
 * 校验失败直接抛错：这条路径后面跟着一次工具调用，模型会看到原因并改参数，比静默丢弃
 * 「我建了但页面上没有」好得多。
 */
export function upsertQuickButton(
  buttons: QuickButton[],
  input: QuickButtonInput,
): { buttons: QuickButton[]; created: boolean; button: QuickButton } {
  const existing = Array.isArray(buttons) ? buttons : [];
  const taken = new Set(existing.map((button) => button.id));
  const requestedId = typeof input.id === 'string' ? input.id.trim() : '';
  const id = requestedId || newButtonId(input.label, taken);
  if (!isValidQuickButtonId(id)) {
    throw new Error(`id「${id}」不合法：只能是小写字母、数字、点、下划线或短横线，且以字母或数字开头`);
  }
  const requested = { ...input, id };
  const button = normalizeQuickButton(requested);
  if (!button) throw new Error(describeInvalid(input));
  const created = !taken.has(id);
  if (created && existing.length >= QUICK_BUTTON_LIMIT) {
    throw new Error(
      `按钮最多 ${QUICK_BUTTON_LIMIT} 个；先删掉一个（operation:"remove"），或者用 operation:"set" 换成新的这一排`,
    );
  }
  const next = created ? [...existing, button] : existing.map((entry) => (entry.id === id ? button : entry));
  return { buttons: next, created, button };
}

export function removeQuickButton(buttons: QuickButton[], id: string): QuickButton[] {
  const key = String(id || '').trim();
  return (Array.isArray(buttons) ? buttons : []).filter((button) => button.id !== key);
}

/** 模型给的一组按钮：整排校验，一条不合格就整批拒绝（不会只落一半）。 */
export function replaceQuickButtons(buttons: QuickButtonInput[]): QuickButton[] {
  let next: QuickButton[] = [];
  for (const input of buttons) {
    const result = upsertQuickButton(next, input);
    next = result.buttons;
  }
  return next;
}

export function normalizeQuickButtonPreview(input: unknown): QuickButtonPreview | undefined {
  if (!isRecord(input)) return undefined;
  const title = trimTo(input.title, QUICK_PREVIEW_TITLE_MAX);
  if (!title) return undefined;
  const markdown = trimTo(input.markdown, QUICK_PREVIEW_MARKDOWN_MAX);
  const text = markdown ? '' : trimTo(input.text, QUICK_PREVIEW_TEXT_MAX);
  const subtitle = trimTo(input.subtitle, QUICK_PREVIEW_SUBTITLE_MAX);
  const note = trimTo(input.note, QUICK_PREVIEW_NOTE_MAX);
  if (!text && !markdown && !note) return undefined;
  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(markdown ? { markdown } : text ? { text } : {}),
    ...(note ? { note } : {}),
  };
}

export type QuickButtonInput = {
  id?: string;
  label?: unknown;
  kind?: unknown;
  url?: unknown;
  target?: unknown;
  text?: unknown;
  role?: unknown;
  path?: unknown;
  dialog?: unknown;
  preview?: unknown;
  style?: unknown;
  hint?: unknown;
};

/**
 * 给模型看的按钮清单（工具结果）。
 *
 * `desktop` 为 false 时把「点一下」换成「直接用这一行」：TUI / `mica exec` 里没有输入框
 * 上方那一排，同一份内容只能以文字与链接的形式交出去——那正是 CLI 里这个能力的全部。
 */
export function formatQuickButtons(buttons: QuickButton[], { desktop }: { desktop: boolean }): string {
  const list = Array.isArray(buttons) ? buttons : [];
  if (list.length === 0) {
    return desktop ? '当前会话没有快捷按钮了。输入框上方那一排已经收起来。' : '当前会话没有快捷按钮。';
  }
  const head = desktop
    ? `当前会话有 ${list.length} 个快捷按钮，显示在输入框上方：`
    : `当前会话有 ${list.length} 个快捷按钮。这个宿主里没有输入框上方的按钮，直接用下面的内容：`;
  return [
    head,
    ...list.map((button) => `- ${buttonLine(button)}${isStaleQuickButton(button) ? '（可能过时）' : ''}`),
  ].join('\n');
}

/** 面板里的一行：种类 + 落点，不带按钮名——条目左边那一列就是名字。 */
export function buttonSummary(button: QuickButton): string {
  const kind = QUICK_BUTTON_KIND_LABELS[button.kind] || button.kind;
  const target = describeTarget(button);
  return target ? `${kind} · ${target}` : kind;
}

/** 一行按钮摘要：`标签 · 种类 → 落点`，工具结果用它。 */
export function buttonLine(button: QuickButton): string {
  const kind = QUICK_BUTTON_KIND_LABELS[button.kind] || button.kind;
  const target = describeTarget(button);
  return target ? `${button.label} · ${kind} → ${target}` : `${button.label} · ${kind}`;
}

function describeTarget(button: QuickButton): string {
  switch (button.kind) {
    case 'open':
      return button.target === 'external' ? `${button.url}（系统浏览器）` : `${button.url}（受控浏览器）`;
    case 'compose':
      return oneLine(button.text || '');
    case 'session':
      return button.role ? `${oneLine(button.text || '')}（角色：${button.role}）` : oneLine(button.text || '');
    case 'path':
      return button.path || '';
    case 'dialog':
      return describeDialog(button.dialog);
  }
}

/** 弹窗按钮的一行摘要：`标题 · 3 项 · 2 个按钮`。 */
function describeDialog(dialog: QuickDialog | undefined): string {
  if (!dialog) return '';
  const parts = [dialog.title];
  if (dialog.items?.length) parts.push(`${dialog.items.length} 项`);
  if (dialog.actions?.length) parts.push(`${dialog.actions.length} 个按钮`);
  return parts.join(' · ');
}

function describeInvalid(input: QuickButtonInput): string {
  const kind = input.kind;
  if (!isQuickButtonKind(kind)) return `kind 只能是 ${QUICK_BUTTON_KINDS.join(' / ')}`;
  if (!trimTo(input.label, QUICK_BUTTON_LABEL_MAX)) return '缺少 label（按钮上的字，最多 12 个字）';
  switch (kind) {
    case 'open':
      return 'open 需要 url，且只能是 http / https 地址';
    case 'compose':
      return 'compose 需要 text（点一下要放进输入框的那段话）';
    case 'session':
      return 'session 需要 text（新会话的第一句话）';
    case 'path':
      return 'path 需要绝对路径';
    case 'dialog':
      return 'dialog 需要 title，以及 text / markdown / items / actions 至少一样';
  }
}

/** 从中文标签也能得到一个可用的 id：取不到 ASCII 就按序号排。 */
export function newButtonId(label: unknown, taken: Set<string>): string {
  const slug = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  if (slug && /^[a-z0-9]/.test(slug) && !taken.has(slug)) return slug;
  for (let index = 1; index <= 99; index += 1) {
    const id = slug ? `${slug}-${index}` : `button-${index}`;
    if (!taken.has(id)) return id;
  }
  return `button-${Date.now().toString(36)}`;
}

export function isOpenableUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function trimTo(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** 正文类落点压成一行：工具结果与面板的一行里不该出现换行。 */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
