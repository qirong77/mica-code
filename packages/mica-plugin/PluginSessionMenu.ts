import type { Disposable } from '@packages/mica-common/index.js';

/**
 * 插件在**会话右键菜单**里的动作。
 *
 * 一个能力拆成两半，因为两半分别存在于不同的进程、在不同的时刻被读：
 *
 * - **有哪些项**写在清单 `desktop.sessionMenu` 里。右键是同步交互：菜单要立刻画出来，
 *   不能为了「这个插件有没有菜单项」去冷启动一个 app-server。清单是静态数据，页面经
 *   配置页那份插件数据就能拿到。
 * - **点了做什么**由插件在自己的常驻宿主里注册（`ctx.desktop.sessionMenu()`）。处理器
 *   只活在插件所在的那个进程里，所以页面永远只是转发 `pluginId + action`。
 *
 * 与 `session-annotations`（会话行标记）的区别：那是**数据**——宿主按插件给的色槽画点、
 * 画勾选项；这里是**动作**——插件要真的跑一段自己的代码，并把结果（通常是剪贴板内容）
 * 交回页面。
 */

/** 清单里的一个菜单项（`desktop.sessionMenu`）。 */
export type PluginSessionMenuItem = {
  /** 菜单上那一行文案。 */
  label: string;
  /**
   * 动作 id，交给插件自己的处理器分派。清单是 JSON，只能放数据，所以插件按 id switch。
   * 同一个插件里必须唯一——重复的 id 会让两个菜单项做同一件事。
   */
  action: string;
};

/** 动作入参。 */
export type PluginSessionMenuInput = {
  action: string;
  /** 这条会话的 id；插件也可以直接读 `ctx.session.describe()`。 */
  sessionId?: string;
};

/**
 * 动作结果。
 *
 * - `copyText`：写进系统剪贴板。插件跑在 `mica app-server` 子进程里，那里面没有剪贴板，
 *   也不该自己去调 `pbcopy` / `xclip`（那只在一个平台上对）；页面收到后统一写。
 * - `message`：给用户看的一句话（已复制几条、没有可复制的内容…）。页面把它放进会话的
 *   notice 里——菜单动作没有别的可见位置。
 */
export type PluginSessionMenuResult = {
  copyText?: string;
  message?: string;
};

export type PluginSessionMenuHandler = {
  run(input: PluginSessionMenuInput): PluginSessionMenuResult | void | Promise<PluginSessionMenuResult | void>;
};

export type PluginSessionMenuRegistration = Disposable & {
  pluginId: string;
};

/** 进程内的处理器登记表：一个插件一个处理器，按动作 id 自己分派。 */
export class PluginSessionMenuRegistry {
  private readonly handlers = new Map<string, PluginSessionMenuHandler>();

  add(pluginId: string, handler: PluginSessionMenuHandler): PluginSessionMenuRegistration {
    this.handlers.set(pluginId, handler);
    return {
      pluginId,
      dispose: () => {
        if (this.handlers.get(pluginId) === handler) this.handlers.delete(pluginId);
      },
    };
  }

  get(pluginId: string): PluginSessionMenuHandler | null {
    return this.handlers.get(pluginId) ?? null;
  }

  ids(): string[] {
    return [...this.handlers.keys()];
  }
}

/* -------------------------------------------------------------- 归一化 */

const MAX_MESSAGE = 200;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 入参归一化：处理器拿到的一定是干净的 `{ action, sessionId? }`。 */
export function normalizePluginSessionMenuInput(input: unknown): PluginSessionMenuInput | null {
  const raw = record(input);
  const action = typeof raw.action === 'string' ? raw.action.trim() : '';
  if (!action) return null;
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  return { action, ...(sessionId ? { sessionId } : {}) };
}

/**
 * 结果归一化：只有 `copyText` 与一句 `message` 会被带回页面，其余一律忽略。
 *
 * `copyText` 不设长度上限——它就是用户要复制的那份内容，截断等于把功能做坏；
 * 这里只保证类型正确，长度与内容由插件负责。
 */
export function normalizePluginSessionMenuResult(input: unknown): PluginSessionMenuResult {
  const raw = record(input);
  const copyText = typeof raw.copyText === 'string' ? raw.copyText : '';
  const message = typeof raw.message === 'string' ? raw.message.trim() : '';
  return {
    ...(copyText ? { copyText } : {}),
    ...(message ? { message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message } : {}),
  };
}
