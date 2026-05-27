import React from 'react';
import { atom as createAtom, type ReadableAtom, type WritableAtom } from 'nanostores';
import type { IMicaAgent } from '../core/agent';
import type { ConversationMessage } from '../store/conversation.js';
import { uuid } from '../utils/uuid';
import { quickCommandsAtom, pluginUIsAtom, dropdown, type Command, type SessionMeta, type PluginUI } from '../store/ui-state.js';
import type { SessionToolRecord } from '../store/logAtom.js';
import { useScheduleState } from '../components/ui/hooks/useScheduleState.js';

export interface PluginAtoms {
  messages: WritableAtom<ConversationMessage[]>;
  model: WritableAtom<string>;
  effort: WritableAtom<string>;
  modelOptions: ReadableAtom<Array<{ name: string; label: string }>>;
  effortOptions: ReadableAtom<Array<{ name: string; label: string }>>;
  sessionsIndex: WritableAtom<SessionMeta[]>;
  currentSessionId: WritableAtom<string>;
  sessionSwitch: WritableAtom<string | null>;
  thinkingText: WritableAtom<string>;
  responseText: WritableAtom<string>;
  sessionToolRecords: WritableAtom<SessionToolRecord[]>;
  systemLogVisible: WritableAtom<boolean>;
  maxTokens: WritableAtom<number>;
  contextWindowSize: ReadableAtom<number>;
  apiBaseUrl: ReadableAtom<string | undefined>;
  apiKey: ReadableAtom<string | undefined>;
  quickCommands: WritableAtom<Command[]>;
}

// ── 快速命令列表（由插件注册，插件内部闭环） ────────────

export { quickCommandsAtom, type SessionMeta };

/**
 * MicaPlugin 基类
 *
 * 所有插件应继承此类，通过 `this.agent` 访问 MicaAgent 实例，
 * 通过 `this.agent.ui` 访问 UI 组件对象（消息、思考文本、工具调用、下拉菜单等）。
 * 通过 `this.atoms` 访问由父组件注入的响应式 atom。
 */
export abstract class MicaPlugin {
  agent!: IMicaAgent;

  atoms!: PluginAtoms;

  private _activeUIId: string | null = null;
  private _uiAtom: WritableAtom<any> | null = null;
  private _ownedAtoms: Array<{ atom: WritableAtom<any>; initial: any }> = [];

  constructor() {
    dropdown.state.listen((state) => {
      if (state.visible) this.reset();
    });
  }
  abstract onInstall(): void | Promise<void>;

  onCleanup(): void {}
  onSessionSwitch(_newId: string, _oldId: string): void {}

  /** 创建插件自有的 atom，框架会在 reset() 时自动重置为初始值 */
  protected createState<T>(initial: T): WritableAtom<T> {
    const a = createAtom<T>(initial);
    this._ownedAtoms.push({ atom: a, initial });
    return a;
  }

  /** 重置所有 createState 创建的 atom 到初始值 */
  protected resetState(): void {
    for (const { atom, initial } of this._ownedAtoms) {
      atom.set(initial);
    }
  }

  /** 清理插件：隐藏 UI + 重置状态 + 调用 onCleanup 钩子 */
  public reset(): void {
    this.hideUI();
    this.resetState();
    this.onCleanup();
  }

  protected addQuickCommand(command: Command): void {
    quickCommandsAtom.set([...quickCommandsAtom.get(), command]);
  }

  /**
   * 显示插件 UI（无状态版本，适用于静态展示如 spinner）
   */
  protected showUISimple(component: React.ComponentType): void {
    const id = this._activeUIId ?? `plugin-ui-${uuid()}`;
    this._activeUIId = id;
    const entry: PluginUI = { id, component };
    pluginUIsAtom.set([...pluginUIsAtom.get().filter((u) => u.id !== id), entry]);
  }

  /**
   * 显示插件 UI，使用 atom 管理状态。
   * 
   * @param component - React 组件，接收 `{ state }` prop
   * @param initialState - 初始状态
   * @param onInput - 输入回调，接收 (input, key, state, setState)，返回 true 表示已处理
   */
  protected showUI<S>(
    component: React.ComponentType<{ state: S }>,
    initialState: S,
    onInput?: (input: string, key: any, state: S, setState: (s: S) => void) => boolean,
  ): void {
    const id = this._activeUIId ?? `plugin-ui-${uuid()}`;
    this._activeUIId = id;

    if (!this._uiAtom) {
      this._uiAtom = createAtom<S>(initialState);
    }
    this._uiAtom.set(initialState);
    const uiAtom = this._uiAtom;

    const Wrapper: React.ComponentType = () => {
      const state = useScheduleState(uiAtom);
      return React.createElement(component, { state });
    };

    const entry: PluginUI = {
      id,
      component: Wrapper,
      onInput: onInput
        ? (input, key) => onInput(input, key, uiAtom.get(), (s) => uiAtom.set(s))
        : undefined,
    };
    pluginUIsAtom.set([...pluginUIsAtom.get().filter((u) => u.id !== id), entry]);
  }

  protected hideUI(): void {
    if (!this._activeUIId) return;
    pluginUIsAtom.set(pluginUIsAtom.get().filter((u) => u.id !== this._activeUIId));
    this._activeUIId = null;
    this._uiAtom = null;
  }

  /** 显示或更新一条消息，默认 3s 后自动清除。传入 id 可更新已有消息 */
  protected showMessage(text: string, delay: number = 3000, id?: string): string {
    const msgId = id ?? `msg-${uuid()}`;
    if (id) this.removeMessage(msgId);
    this.agent.ui.MessageBar.addMessage({ id: msgId, text });
    if (delay) {
      setTimeout(() => {
        this.removeMessage(msgId);
      }, delay);
    }
    return msgId;
  }

  /** 移除指定 ID 的消息 */
  protected removeMessage(id: string): void {
    this.agent.ui.MessageBar.removeMessage(id);
  }

  /** 清除所有消息 */
  protected clearMessages(): void {
    this.agent.ui.MessageBar.clearMessages();
  }

  /** 获取当前消息列表 */
  protected get messages(): Anthropic.MessageParam[] {
    return this.atoms.messages.get();
  }

  /** 监听消息变更 */
  protected onMessagesChange(cb: (messages: Anthropic.MessageParam[]) => void): () => void {
    return this.atoms.messages.listen((messages) => cb([...messages]));
  }
}
