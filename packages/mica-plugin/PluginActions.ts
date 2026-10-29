/**
 * 配置页动作。
 *
 * 有些事属于插件、却不属于任何一次会话：注册到中转机、试连一次接口、生成一个访问链接。
 * 这类操作要的是「插件自己那点逻辑 + 一个不需要会话的宿主」，所以它不能挂在会话面板上
 * （`ctx.desktop.panel` 需要常驻会话宿主），也不该由内核替插件实现。
 *
 * 分工：清单声明「有哪个按钮、叫什么」，插件用 `ctx.actions.register()` 提供实现，配置页
 * 只画按钮、把结果（一句话 + 一条链接）显示出来。宿主不认任何具体插件。
 */
import type { Disposable } from '@packages/mica-common/index.js';
import type { PluginSettingValues } from './PluginSettings.js';

/** 按钮语气：主操作、普通操作、危险操作。页面只按它上色，不解释语义。 */
export const PLUGIN_ACTION_TONES = ['primary', 'neutral', 'danger'] as const;
export type PluginActionTone = (typeof PLUGIN_ACTION_TONES)[number];

/** 清单里声明的一个动作。 */
export type PluginActionDeclaration = {
  /** 动作标识，插件在 `ctx.actions.register()` 里用它认领实现。 */
  key: string;
  /** 按钮上的字。 */
  label: string;
  /** 按钮下面的一行说明；空字符串表示不显示。 */
  description: string;
  tone: PluginActionTone;
};

export type PluginActionInput = {
  /**
   * 页面上当前的设置值（可能是还没写盘的草稿）。
   *
   * 动作需要「用户刚填的那个地址」时读这里，而不是只读 `ctx.settings.get()`——配置页
   * 的输入框是防抖保存的，点按钮的瞬间磁盘上可能还是上一次的值。
   */
  values: PluginSettingValues;
};

export type PluginActionResult = {
  /** 给用户看的一句话（成功或失败都行）。 */
  message?: string;
  /** 一条可以点开的地址：注册拿到访问链接这类。 */
  link?: string;
} | void;

export type PluginActionHandler = (
  input: PluginActionInput,
) => PluginActionResult | Promise<PluginActionResult>;

type RegisteredAction = {
  pluginId: string;
  key: string;
  handler: PluginActionHandler;
};

/**
 * 已注册动作的登记表。宿主建一份、随 `setupAll` 传进去。
 *
 * 只有清单里声明过的 key 才能注册：没声明的动作页面上根本没有按钮，静默接受注册会让
 * 插件以为用户点得到它。同理，执行时也按 pluginId + key 精确定位，不跨插件复用。
 */
export class PluginActionRegistry {
  private readonly actions = new Map<string, RegisteredAction>();

  constructor(private readonly declared: (pluginId: string) => readonly string[] = () => []) {}

  add(pluginId: string, key: string, handler: PluginActionHandler): Disposable {
    const id = String(pluginId || '').trim();
    const action = String(key || '').trim();
    if (!id || !action) throw new Error('插件动作缺少 pluginId 或 key');
    const allowed = this.declared(id);
    if (allowed.length > 0 && !allowed.includes(action)) {
      throw new Error(`${id} 的清单没有声明动作 ${action}（已声明：${allowed.join(', ') || '无'}）`);
    }
    const slot = `${id}:${action}`;
    if (this.actions.has(slot)) throw new Error(`插件动作重复注册：${slot}`);
    this.actions.set(slot, { pluginId: id, key: action, handler });
    return {
      dispose: () => {
        if (this.actions.get(slot)?.handler === handler) this.actions.delete(slot);
      },
    };
  }

  has(pluginId: string, key: string): boolean {
    return this.actions.has(`${pluginId}:${key}`);
  }

  keys(pluginId: string): string[] {
    return [...this.actions.values()]
      .filter((entry) => entry.pluginId === pluginId)
      .map((entry) => entry.key);
  }

  async run(pluginId: string, key: string, input: PluginActionInput): Promise<PluginActionResult> {
    const entry = this.actions.get(`${pluginId}:${key}`);
    if (!entry) {
      throw new Error(`插件 ${pluginId} 没有可执行的动作 ${key}：它没注册，或者当前宿主没装载它`);
    }
    return entry.handler(input);
  }
}
